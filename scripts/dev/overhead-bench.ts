#!/usr/bin/env bun
/**
 * overhead-bench — repeatable endpoint benchmark harness.
 *
 * Exercises: /health, /v1/models, /share/:token/data, one non-stream proxy request,
 * one streaming proxy request. Reports cold startup, first-request latency,
 * p50/p95/p99, and process.memoryUsage() before/after each batch.
 *
 * Usage:
 *   bun scripts/overhead-bench.ts --help
 *   bun scripts/overhead-bench.ts --dry-run
 *   bun scripts/overhead-bench.ts --iterations 1,100,1000 --concurrency 10
 *   bun scripts/overhead-bench.ts --iterations 100 --concurrency 5 --share-token abc123
 *
 * Required env (or --flags):
 *   BENCH_URL          or --url          (default: PUBLIC_ORIGIN or http://127.0.0.1:12800)
 *   BENCH_API_KEY      or --key          (required for /v1/models and proxy endpoints)
 *   BENCH_SHARE_TOKEN  or --share-token  (required for /share/:token/data)
 *   BENCH_MODEL        or --model        (default: openai/gpt-4o-mini)
 *
 * Output:
 *   JSON report to stdout and local/overhead-bench-report.json
 */

// ── Types ──────────────────────────────────────────────────────────────────

interface Args {
  url: string;
  key: string;
  shareToken: string;
  model: string;
  iterations: number[];
  concurrency: number;
  dryRun: boolean;
  help: boolean;
}

interface MemorySnapshot {
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

interface LatencyResult {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  errors: number;
  errorMessages: string[];
}

interface EndpointResult {
  name: string;
  path: string;
  iterations: number;
  concurrency: number;
  coldFirstMs?: number;
  latency: LatencyResult;
  memoryBefore: MemorySnapshot;
  memoryAfter: MemorySnapshot;
  memoryDelta: {
    rss: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
}

interface BenchmarkReport {
  generatedAt: string;
  url: string;
  model: string;
  concurrency: number;
  endpoints: EndpointResult[];
}

// ── Arg parsing ────────────────────────────────────────────────────────────

function parseArgs(): Args {
  const m = new Map<string, string>();
  for (let i = 2; i < Bun.argv.length; i += 1) {
    const a = Bun.argv[i] ?? "";
    if (a === "--help" || a === "-h") {
      m.set("help", "1");
    } else if (a === "--dry-run") {
      m.set("dry-run", "1");
    } else if (a.startsWith("--")) {
      const eqIdx = a.indexOf("=");
      if (eqIdx > 0) {
        m.set(a.slice(2, eqIdx), a.slice(eqIdx + 1));
      } else {
        m.set(a.slice(2), String(Bun.argv[++i] ?? ""));
      }
    }
  }

  const iterationsRaw = m.get("iterations") ?? "1,100,1000";
  const iterations = iterationsRaw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (iterations.length === 0) {
    throw new Error(`Invalid --iterations: "${iterationsRaw}". Expected comma-separated positive integers.`);
  }

  return {
    url: m.get("url") ?? Bun.env.BENCH_URL ?? Bun.env.PUBLIC_ORIGIN ?? "http://127.0.0.1:12800",
    key: m.get("key") ?? Bun.env.BENCH_API_KEY ?? Bun.env.PROXY_API_KEY ?? "",
    shareToken: m.get("share-token") ?? Bun.env.BENCH_SHARE_TOKEN ?? "",
    model: m.get("model") ?? Bun.env.BENCH_MODEL ?? "openai/gpt-4o-mini",
    iterations,
    concurrency: Math.max(1, Number(m.get("concurrency") ?? "10")),
    dryRun: m.has("dry-run"),
    help: m.has("help"),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function memorySnapshot(): MemorySnapshot {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatMs(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(2)} ms`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function computeLatency(latencies: number[], errors: number, errorMessages: string[]): LatencyResult {
  if (latencies.length === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0, errors, errorMessages };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    errors,
    errorMessages: errorMessages.slice(0, 5),
  };
}

// ── Request runners ────────────────────────────────────────────────────────

type RequestFn = () => Promise<{ status: number; ok: boolean; body?: string }>;

async function runBatch(
  fn: RequestFn,
  iterations: number,
  concurrency: number,
): Promise<{ latencies: number[]; errors: number; errorMessages: string[] }> {
  const latencies: number[] = [];
  let errors = 0;
  const errorMessages: string[] = [];
  let inFlight = 0;
  let completed = 0;

  const { promise, resolve } = Promise.withResolvers<{ latencies: number[]; errors: number; errorMessages: string[] }>();

  const next = (): void => {
    while (inFlight < concurrency && completed + inFlight < iterations) {
      inFlight += 1;
      const start = performance.now();
      fn()
        .then((res) => {
          const elapsed = performance.now() - start;
          latencies.push(elapsed);
          if (!res.ok) {
            errors += 1;
            const msg = `HTTP ${res.status}`;
            if (errorMessages.length < 10) errorMessages.push(msg);
          }
        })
        .catch((err: unknown) => {
          const elapsed = performance.now() - start;
          latencies.push(elapsed);
          errors += 1;
          const msg = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
          if (errorMessages.length < 10) errorMessages.push(msg);
        })
        .finally(() => {
          inFlight -= 1;
          completed += 1;
          if (completed >= iterations) {
            resolve({ latencies, errors, errorMessages });
          } else {
            next();
          }
        });
    }
  };
  next();

  return promise;
}

function makeHealthFn(url: string): RequestFn {
  const endpoint = `${url}/health`;
  return async () => {
    const res = await fetch(endpoint);
    return { status: res.status, ok: res.ok };
  };
}

function makeModelsFn(url: string, key: string): RequestFn {
  const endpoint = `${url}/v1/models`;
  return async () => {
    const res = await fetch(endpoint, {
      headers: { "x-api-key": key },
    });
    return { status: res.status, ok: res.ok };
  };
}

function makeShareFn(url: string, token: string): RequestFn {
  const endpoint = `${url}/share/${token}/data`;
  return async () => {
    const res = await fetch(endpoint);
    return { status: res.status, ok: res.ok };
  };
}

function makeProxyNonStreamFn(url: string, key: string, model: string): RequestFn {
  const endpoint = `${url}/v1/chat/completions`;
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: "Say exactly one word: pong" }],
    stream: false,
    max_tokens: 8,
  });
  return async () => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body,
    });
    const text = await res.text().catch(() => "");
    return { status: res.status, ok: res.ok, body: text.slice(0, 200) };
  };
}

function makeProxyStreamFn(url: string, key: string, model: string): RequestFn {
  const endpoint = `${url}/v1/chat/completions`;
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: "Say exactly one word: pong" }],
    stream: true,
    max_tokens: 8,
  });
  return async () => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body,
    });
    // Consume the stream to measure full round-trip
    if (res.body) {
      const reader = res.body.getReader();
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        // Stream may abort; that's an error case
      }
    } else {
      await res.text().catch(() => "");
    }
    return { status: res.status, ok: res.ok };
  };
}

// ── Endpoint benchmark ─────────────────────────────────────────────────────

async function benchEndpoint(
  name: string,
  path: string,
  fn: RequestFn,
  iterations: number,
  concurrency: number,
): Promise<EndpointResult> {
  // Warm up with a single request to establish connection
  const warmupStart = performance.now();
  await fn().catch(() => {});
  const coldFirstMs = performance.now() - warmupStart;

  const memBefore = memorySnapshot();
  const { latencies, errors, errorMessages } = await runBatch(fn, iterations, concurrency);
  const memAfter = memorySnapshot();

  return {
    name,
    path,
    iterations,
    concurrency,
    coldFirstMs,
    latency: computeLatency(latencies, errors, errorMessages),
    memoryBefore: memBefore,
    memoryAfter: memAfter,
    memoryDelta: {
      rss: memAfter.rss - memBefore.rss,
      heapUsed: memAfter.heapUsed - memBefore.heapUsed,
      external: memAfter.external - memBefore.external,
      arrayBuffers: memAfter.arrayBuffers - memBefore.arrayBuffers,
    },
  };
}

// ── Validation ─────────────────────────────────────────────────────────────

function validateRequirements(args: Args): string[] {
  const errors: string[] = [];

  if (!args.key) {
    errors.push(
      "Missing API key. Set BENCH_API_KEY env, PROXY_API_KEY env, or --key flag.",
    );
  }

  if (!args.shareToken) {
    errors.push(
      "Missing share token. Set BENCH_SHARE_TOKEN env or --share-token flag.\n" +
        "  Create a share link in the console, then extract the token from the URL.",
    );
  }

  return errors;
}

// ── Help ───────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
overhead-bench — repeatable endpoint benchmark harness

USAGE
  bun scripts/overhead-bench.ts [OPTIONS]

OPTIONS
  --url <url>            Base URL (default: PUBLIC_ORIGIN or http://127.0.0.1:12800)
  --key <key>            API key for authenticated endpoints (required)
  --share-token <token>  Share token for /share/:token/data (required)
  --model <model>        Model for proxy requests (default: openai/gpt-4o-mini)
  --iterations <n,...>   Comma-separated iteration counts (default: 1,100,1000)
  --concurrency <n>      Max concurrent requests per batch (default: 10)
  --dry-run              Validate config and connectivity without running benchmarks
  --help, -h             Show this help

ENVIRONMENT VARIABLES
  BENCH_URL              Base URL (fallback: PUBLIC_ORIGIN)
  BENCH_API_KEY          API key (fallback: PROXY_API_KEY)
  BENCH_SHARE_TOKEN      Share token for /share/:token/data
  BENCH_MODEL            Model for proxy requests

ENDPOINTS BENCHMARKED
  /health                GET  — no auth, health check
  /v1/models             GET  — requires API key
  /share/:token/data     GET  — requires share token
  /v1/chat/completions   POST — non-stream proxy (requires API key + model)
  /v1/chat/completions   POST — streaming proxy (requires API key + model)

OUTPUT
  JSON report to stdout and local/overhead-bench-report.json
`);
}

// ── Dry run ────────────────────────────────────────────────────────────────

async function dryRun(args: Args): Promise<void> {
  console.log("=== DRY RUN ===\n");
  console.log(`  URL:          ${args.url}`);
  console.log(`  API Key:      ${args.key ? "(set)" : "(missing)"}`);
  console.log(`  Share Token:  ${args.shareToken ? args.shareToken.slice(0, 8) + "..." : "(missing)"}`);
  console.log(`  Model:        ${args.model}`);
  console.log(`  Iterations:   ${args.iterations.join(", ")}`);
  console.log(`  Concurrency:  ${args.concurrency}`);
  console.log();

  const validationErrors = validateRequirements(args);
  if (validationErrors.length > 0) {
    console.log("\x1b[31mConfiguration errors:\x1b[0m");
    for (const err of validationErrors) {
      console.log(`  \x1b[31m✗\x1b[0m ${err}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("\x1b[32mConfiguration OK\x1b[0m\n");
  console.log("Testing connectivity...");

  // Test /health
  try {
    const res = await fetch(`${args.url}/health`);
    console.log(`  /health:              ${res.status} ${res.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}`);
  } catch (err) {
    console.log(`  /health:              \x1b[31m✗ ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
  }

  // Test /v1/models
  try {
    const res = await fetch(`${args.url}/v1/models`, { headers: { "x-api-key": args.key } });
    console.log(`  /v1/models:           ${res.status} ${res.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}`);
  } catch (err) {
    console.log(`  /v1/models:           \x1b[31m✗ ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
  }

  // Test /share/:token/data
  try {
    const res = await fetch(`${args.url}/share/${args.shareToken}/data`);
    console.log(`  /share/:token/data:   ${res.status} ${res.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}`);
  } catch (err) {
    console.log(`  /share/:token/data:   \x1b[31m✗ ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
  }

  // Test proxy non-stream
  try {
    const res = await fetch(`${args.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": args.key },
      body: JSON.stringify({ model: args.model, messages: [{ role: "user", content: "ping" }], stream: false, max_tokens: 4 }),
    });
    console.log(`  /v1/chat/completions: ${res.status} ${res.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} (non-stream)`);
  } catch (err) {
    console.log(`  /v1/chat/completions: \x1b[31m✗ ${err instanceof Error ? err.message : String(err)}\x1b[0m (non-stream)`);
  }

  // Test proxy stream
  try {
    const res = await fetch(`${args.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": args.key },
      body: JSON.stringify({ model: args.model, messages: [{ role: "user", content: "ping" }], stream: true, max_tokens: 4 }),
    });
    if (res.body) {
      const reader = res.body.getReader();
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        // ok
      }
    }
    console.log(`  /v1/chat/completions: ${res.status} ${res.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} (stream)`);
  } catch (err) {
    console.log(`  /v1/chat/completions: \x1b[31m✗ ${err instanceof Error ? err.message : String(err)}\x1b[0m (stream)`);
  }

  console.log("\n\x1b[32mDry run complete.\x1b[0m Remove --dry-run to execute benchmarks.");
}

// ── Main ───────────────────────────────────────────────────────────────────

function printResult(result: EndpointResult): void {
  const { name, latency, memoryDelta, coldFirstMs } = result;
  console.log(`\n  ${name}`);
  if (coldFirstMs !== undefined) {
    console.log(`    Cold first:  ${formatMs(coldFirstMs)}`);
  }
  console.log(`    Count:       ${latency.count} (${latency.errors} errors)`);
  console.log(`    Min:         ${formatMs(latency.min)}`);
  console.log(`    Mean:        ${formatMs(latency.mean)}`);
  console.log(`    p50:         ${formatMs(latency.p50)}`);
  console.log(`    p95:         ${formatMs(latency.p95)}`);
  console.log(`    p99:         ${formatMs(latency.p99)}`);
  console.log(`    Max:         ${formatMs(latency.max)}`);
  console.log(`    RSS Δ:       ${formatBytes(memoryDelta.rss)}`);
  console.log(`    Heap Δ:      ${formatBytes(memoryDelta.heapUsed)}`);
  console.log(`    External Δ:  ${formatBytes(memoryDelta.external)}`);
  console.log(`    ArrayBuf Δ:  ${formatBytes(memoryDelta.arrayBuffers)}`);
  if (latency.errors > 0 && latency.errorMessages.length > 0) {
    console.log(`    Errors:      ${latency.errorMessages.join("; ")}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    return;
  }

  if (args.dryRun) {
    await dryRun(args);
    return;
  }

  const validationErrors = validateRequirements(args);
  if (validationErrors.length > 0) {
    console.error("\x1b[31mCannot run benchmark:\x1b[0m");
    for (const err of validationErrors) {
      console.error(`  \x1b[31m✗\x1b[0m ${err}`);
    }
    console.error("\nRun with --help for usage information.");
    process.exitCode = 1;
    return;
  }

  const baseUrl = args.url.replace(/\/+$/, "");
  const allResults: EndpointResult[] = [];

  console.log(`\x1b[1moverhead-bench\x1b[0m`);
  console.log(`  URL:         ${baseUrl}`);
  console.log(`  Model:       ${args.model}`);
  console.log(`  Concurrency: ${args.concurrency}`);
  console.log(`  Iterations:  ${args.iterations.join(", ")}`);

  for (const iter of args.iterations) {
    console.log(`\n\x1b[1m── Batch: ${iter} iteration(s) ──\x1b[0m`);

    // 1. /health
    const health = await benchEndpoint(
      "GET /health",
      "/health",
      makeHealthFn(baseUrl),
      iter,
      args.concurrency,
    );
    allResults.push(health);
    printResult(health);

    // 2. /v1/models
    const models = await benchEndpoint(
      "GET /v1/models",
      "/v1/models",
      makeModelsFn(baseUrl, args.key),
      iter,
      args.concurrency,
    );
    allResults.push(models);
    printResult(models);

    // 3. /share/:token/data
    const share = await benchEndpoint(
      "GET /share/:token/data",
      "/share/:token/data",
      makeShareFn(baseUrl, args.shareToken),
      iter,
      args.concurrency,
    );
    allResults.push(share);
    printResult(share);

    // 4. Non-stream proxy
    const proxyNonStream = await benchEndpoint(
      "POST /v1/chat/completions (non-stream)",
      "/v1/chat/completions",
      makeProxyNonStreamFn(baseUrl, args.key, args.model),
      iter,
      args.concurrency,
    );
    allResults.push(proxyNonStream);
    printResult(proxyNonStream);

    // 5. Streaming proxy
    const proxyStream = await benchEndpoint(
      "POST /v1/chat/completions (stream)",
      "/v1/chat/completions",
      makeProxyStreamFn(baseUrl, args.key, args.model),
      iter,
      args.concurrency,
    );
    allResults.push(proxyStream);
    printResult(proxyStream);
  }

  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    url: baseUrl,
    model: args.model,
    concurrency: args.concurrency,
    endpoints: allResults,
  };

  // Write report
  const reportPath = "local/overhead-bench-report.json";
  await Bun.write(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n\x1b[32mReport written to ${reportPath}\x1b[0m`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
