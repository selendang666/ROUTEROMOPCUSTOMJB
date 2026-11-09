import { AsyncLocalStorage } from "node:async_hooks";

const MAX_MARKS_PER_REQUEST = 64;
const MAX_PHASES = 64;
const DEFAULT_SAMPLES_PER_PHASE = 8_192;
const PHASE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const NOOP_STOP = (): void => {};

/** Numeric and categorical metadata attached to one measured phase. */
export type OverheadMetadata = Readonly<Record<string, string | number | boolean>>;

/** One completed request-phase measurement. */
export interface OverheadMark {
  readonly phase: string;
  readonly durationMs: number;
  readonly metadata?: OverheadMetadata;
}

/** Sampled measurements retained for a single request. */
export interface OverheadReport {
  readonly requestId: string;
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly marks: readonly OverheadMark[];
  readonly truncated: boolean;
}

/** Percentiles computed from the bounded rolling samples for one phase. */
export interface OverheadPhaseSnapshot {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly p999Ms: number;
  readonly maxMs: number;
}

/** Process-local overhead metrics exposed to operators. */
export interface OverheadSnapshot {
  readonly enabled: boolean;
  readonly sampleRate: number;
  readonly generatedAt: string;
  readonly phases: Readonly<Record<string, OverheadPhaseSnapshot>>;
}

interface RuntimeOverheadConfig {
  readonly enabled: boolean;
  readonly sampleRate: number;
  readonly samplesPerPhase: number;
}

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const runtimeConfig: RuntimeOverheadConfig = Object.freeze({
  enabled: Bun.env.OHMYOMOP_ROUTER_OVERHEAD_TRACKING !== "0",
  sampleRate: boundedNumber(Bun.env.OHMYOMOP_ROUTER_OVERHEAD_SAMPLE_RATE, 1, 0, 1),
  samplesPerPhase: Math.floor(
    boundedNumber(Bun.env.OHMYOMOP_ROUTER_OVERHEAD_SAMPLES_PER_PHASE, DEFAULT_SAMPLES_PER_PHASE, 128, 65_536),
  ),
});

const streamSampleRate = boundedNumber(Bun.env.OHMYOMOP_ROUTER_OVERHEAD_STREAM_SAMPLE_RATE, 0.01, 0, 1);
// Counter-based sampling for hot stream.frame path to avoid Math.random per frame
let streamFrameCounter = 0;

class RollingSamples {
  private readonly values: Float64Array;
  private writeIndex = 0;
  private retained = 0;
  private total = 0;

  constructor(capacity: number) {
    this.values = new Float64Array(capacity);
  }

  record(durationMs: number): void {
    this.values[this.writeIndex] = durationMs;
    this.writeIndex = (this.writeIndex + 1) % this.values.length;
    this.retained = Math.min(this.retained + 1, this.values.length);
    this.total += 1;
  }

  snapshot(): OverheadPhaseSnapshot {
    if (this.retained === 0) {
      return { count: this.total, p50Ms: 0, p95Ms: 0, p99Ms: 0, p999Ms: 0, maxMs: 0 };
    }
    const sorted = Array.from(this.values.subarray(0, this.retained)).sort((left, right) => left - right);
    return {
      count: this.total,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
      p999Ms: percentile(sorted, 0.999),
      maxMs: sorted[sorted.length - 1] ?? 0,
    };
  }
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return roundMilliseconds(sorted[index] ?? 0);
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

const phaseSamples = new Map<string, RollingSamples>();

function recordPhase(phase: string, durationMs: number): void {
  let samples = phaseSamples.get(phase);
  if (samples === undefined) {
    if (phaseSamples.size >= MAX_PHASES) {
      // LRU evict oldest phase to make room
      const oldest = phaseSamples.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        phaseSamples.delete(oldest);
        console.warn(`[overhead] phase limit ${MAX_PHASES} exceeded, evicted oldest phase ${oldest} for ${phase}`);
      } else {
        console.warn(`[overhead] phase limit ${MAX_PHASES} exceeded, dropping phase ${phase}`);
        return;
      }
    }
    samples = new RollingSamples(runtimeConfig.samplesPerPhase);
    phaseSamples.set(phase, samples);
  } else {
    // LRU: move accessed phase to end
    phaseSamples.delete(phase);
    phaseSamples.set(phase, samples);
  }
  samples.record(durationMs);
}

/** Bounded request-local collector used by hot-path instrumentation. */
export class OverheadTracker {
  private readonly startedAtEpochMs = Date.now();
  private readonly startedAtPerformanceMs = performance.now();
  private readonly collectedMarks: OverheadMark[] = [];
  private isTruncated = false;
  private streamFrameCount = 0;

  constructor(readonly requestId: string) {}

  /** Starts one phase and returns an idempotent completion callback. */
  mark(phase: string, metadata?: OverheadMetadata): () => void {
    if (!PHASE_PATTERN.test(phase)) return NOOP_STOP;
    const startedAt = performance.now();
    let stopped = false;
    return (): void => {
      if (stopped) return;
      stopped = true;
      const durationMs = Math.max(0, performance.now() - startedAt);
      recordPhase(phase, durationMs);
      if (this.collectedMarks.length >= MAX_MARKS_PER_REQUEST) {
        if (!this.isTruncated) console.warn(`[overhead] mark limit ${MAX_MARKS_PER_REQUEST} exceeded for request ${this.requestId}, truncating`);
        this.isTruncated = true;
        return;
      }
      this.collectedMarks.push({ phase, durationMs: roundMilliseconds(durationMs), ...(metadata === undefined ? {} : { metadata }) });
    };
  }

  shouldSampleStreamFrame(sampleRate: number): boolean {
    if (sampleRate <= 0) return false;
    if (sampleRate >= 1) return true;
    const interval = Math.max(1, Math.round(1 / sampleRate));
    this.streamFrameCount = (this.streamFrameCount + 1) % interval;
    return this.streamFrameCount === 0;
  }

  /** Returns a stable copy suitable for sampled telemetry persistence. */
  report(): OverheadReport {
    return {
      requestId: this.requestId,
      startedAt: new Date(this.startedAtEpochMs).toISOString(),
      elapsedMs: roundMilliseconds(performance.now() - this.startedAtPerformanceMs),
      marks: this.collectedMarks.slice(),
      truncated: this.isTruncated,
    };
  }
}

const requestStorage = new AsyncLocalStorage<OverheadTracker>();

/** Overrides runtime sampling for deterministic internal tests and diagnostics. */
export interface RunOverheadOptions {
  readonly force?: boolean;
}

/** Runs a request in an optional sampled overhead-tracking context. */
export function runWithOverheadRequest<T>(requestId: string, task: () => T, options: RunOverheadOptions = {}): T {
  if (options.force !== true && (!runtimeConfig.enabled || Math.random() >= runtimeConfig.sampleRate)) return task();
  return requestStorage.run(new OverheadTracker(requestId), task);
}

/** Starts a phase on the active request, or returns a zero-cost no-op callback. */
export function markOverhead(phase: string, metadata?: OverheadMetadata): () => void {
  return requestStorage.getStore()?.mark(phase, metadata) ?? NOOP_STOP;
}

/** Starts a phase only for the configured fraction of high-frequency operations. */
export function markSampledOverhead(
  phase: string,
  sampleRate: number = streamSampleRate,
  metadata?: OverheadMetadata,
): () => void {
  // Fast bail if no active overhead tracker — avoids Math.random cost for unsampled requests
  const store = requestStorage.getStore();
  if (store === undefined) return NOOP_STOP;
  // stream.frame hot-path: use per-tracker counter-based sampling to avoid global bias
  if (phase === "stream.frame") {
    if (!store.shouldSampleStreamFrame(sampleRate)) return NOOP_STOP;
    return store.mark(phase, metadata);
  }
  if (sampleRate <= 0 || Math.random() >= sampleRate) return NOOP_STOP;
  return store.mark(phase, metadata);
}

/** Returns the active sampled request report for telemetry attachment. */
export function currentOverheadReport(): OverheadReport | undefined {
  return requestStorage.getStore()?.report();
}

/** Returns bounded process-local phase percentiles. */
export function getOverheadSnapshot(): OverheadSnapshot {
  const phases: Record<string, OverheadPhaseSnapshot> = {};
  for (const [phase, samples] of phaseSamples) phases[phase] = samples.snapshot();
  return {
    enabled: runtimeConfig.enabled,
    sampleRate: runtimeConfig.sampleRate,
    generatedAt: new Date().toISOString(),
    phases,
  };
}

/** Serializes current phase histograms using Prometheus text exposition format. */
export function overheadPrometheus(): string {
  const snapshot = getOverheadSnapshot();
  const lines = [
    "# HELP ohmyomop_router_overhead_milliseconds Request processing overhead by phase and percentile.",
    "# TYPE ohmyomop_router_overhead_milliseconds gauge",
  ];
  for (const [phase, values] of Object.entries(snapshot.phases)) {
    const escapedPhase = phase.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
    lines.push(`ohmyomop_router_overhead_milliseconds{phase="${escapedPhase}",quantile="0.5"} ${values.p50Ms}`);
    lines.push(`ohmyomop_router_overhead_milliseconds{phase="${escapedPhase}",quantile="0.95"} ${values.p95Ms}`);
    lines.push(`ohmyomop_router_overhead_milliseconds{phase="${escapedPhase}",quantile="0.99"} ${values.p99Ms}`);
    lines.push(`ohmyomop_router_overhead_milliseconds{phase="${escapedPhase}",quantile="0.999"} ${values.p999Ms}`);
    lines.push(`ohmyomop_router_overhead_milliseconds{phase="${escapedPhase}",quantile="max"} ${values.maxMs}`);
    lines.push(`ohmyomop_router_overhead_samples_total{phase="${escapedPhase}"} ${values.count}`);
  }
  return `${lines.join("\n")}\n`;
}
