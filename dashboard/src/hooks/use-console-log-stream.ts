/**
 * useConsoleLogStream — EventSource hook for /console/api/logs/stream
 * (design §9.3): backoff 1s→2s→…→30s, SQL-backed snapshot cap 200 lines, status badge state.
 * Native EventSource handles SSE framing + sends the session cookie same-origin.
 *
 * Incoming `line` events are coalesced into batches and committed with one
 * state update per batch (per animation frame), so the 200-line view is copied
 * once per burst instead of once per line event.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type ConsoleLogLevel = "debug" | "info" | "warn" | "error";
export type ConsoleLogCategory = "all" | "web" | "request" | "system";

export interface ConsoleLogContext {
  readonly event?: "incoming" | "complete" | "failed" | "aborted" | "switch" | string;
  readonly requestId?: string | null;
  readonly endpoint?: string | null;
  readonly providerId?: string | null;
  readonly model?: string | null;
  readonly status?: number | null;
  readonly errorKind?: string | null;
  readonly durationMs?: number | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cachedTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
  readonly reasoningTokens?: number | null;
  readonly messageCount?: number | null;
  readonly toolCount?: number | null;
  readonly imageCount?: number | null;
  readonly clientName?: string | null;
  readonly clientSource?: string | null;
  readonly clientIp?: string | null;
  readonly accountId?: string | null;
  readonly proxyId?: string | null;
  readonly switch?: {
    readonly scope?: string;
    readonly fromCandidateId?: string | null;
    readonly toCandidateId?: string | null;
    readonly fromAccountId?: string | null;
    readonly toAccountId?: string | null;
    readonly reason?: string | null;
  } | null;
}

export interface ConsoleLogLine {
  id: number;
  ts: string;
  level: ConsoleLogLevel;
  scope: string;
  category: Exclude<ConsoleLogCategory, "all">;
  msg: string;
  context?: ConsoleLogContext | null;
  searchBlob?: string;
}

export type StreamStatus = "connected" | "connecting" | "error";

const MAX_LINES = 200;
const STREAM_URL = "/console/api/logs/stream";
/** Fallback flush window when the tab is hidden and requestAnimationFrame is throttled. */
const FLUSH_FALLBACK_MS = 32;
const HIGHLIGHT_MS = 3_000;

export interface ConsoleLogStream {
  lines: ConsoleLogLine[];
  newLineIds: ReadonlySet<number>;
  status: StreamStatus;
  attempts: number;
  reset: () => void;
}

export function buildSearchBlob(line: ConsoleLogLine): string {
  const context = line.context ? ` ${JSON.stringify(line.context)}` : "";
  return `${line.ts} ${line.level} ${line.category} ${line.scope} ${line.msg}${context}`.toLowerCase();
}

function withBlob(line: ConsoleLogLine): ConsoleLogLine {
  if (line.searchBlob !== undefined && line.searchBlob !== "") return line;
  return { ...line, searchBlob: buildSearchBlob(line) };
}

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  return 0;
}

function cancelFrame(frameId: number): void {
  if (frameId === 0) return;
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(frameId);
  }
}

function dedupAndSortWithBlob(lines: ConsoleLogLine[]): ConsoleLogLine[] {
  const map = new Map<number, ConsoleLogLine>();
  for (const line of lines) {
    map.set(line.id, withBlob(line));
  }
  return [...map.values()].sort((a, b) => b.id - a.id);
}

function mergeNewestFirst(
  dedupedBatch: ConsoleLogLine[],
  prev: ConsoleLogLine[],
): ConsoleLogLine[] {
  if (prev.length === 0) return dedupedBatch.slice(0, MAX_LINES);
  if (dedupedBatch.length === 0) return prev.length <= MAX_LINES ? prev : prev.slice(0, MAX_LINES);
  const merged: ConsoleLogLine[] = [];
  let i = 0;
  let j = 0;
  while ((i < dedupedBatch.length || j < prev.length) && merged.length < MAX_LINES) {
    if (i >= dedupedBatch.length) {
      merged.push(prev[j++]);
    } else if (j >= prev.length) {
      merged.push(dedupedBatch[i++]);
    } else if (dedupedBatch[i].id > prev[j].id) {
      merged.push(dedupedBatch[i++]);
    } else {
      merged.push(prev[j++]);
    }
  }
  return merged;
}

export function useConsoleLogStream(category: ConsoleLogCategory = "request"): ConsoleLogStream {
  const [lines, setLines] = useState<ConsoleLogLine[]>([]);
  const [newLineIds, setNewLineIds] = useState<ReadonlySet<number>>(new Set());
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [attempts, setAttempts] = useState(0);
  const [reconnectKey, setReconnectKey] = useState(0);
  const attemptsRef = useRef(0);
  const watermarkRef = useRef(0);
  const pendingRef = useRef<ConsoleLogLine[]>([]);
  const scheduledRef = useRef(false);
  const rafRef = useRef(0);
  const flushTimerRef = useRef(0);
  const reconnectTimerRef = useRef(0);
  const highlightTimerRef = useRef(0);

  /** Clears visible state and rewinds the client-side replay cursor. */
  const clearVisibleState = useCallback(() => {
    pendingRef.current = [];
    scheduledRef.current = false;
    cancelFrame(rafRef.current);
    rafRef.current = 0;
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = 0;
    }
    watermarkRef.current = 0;
    clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = 0;
    setNewLineIds(new Set());
    setLines([]);
  }, []);

  /** Clears the visible snapshot and reopens SSE so the next log starts from a fresh server cursor. */
  const reset = useCallback(() => {
    clearVisibleState();
    attemptsRef.current = 0;
    setAttempts(0);
    setStatus("connecting");
    setReconnectKey((value) => value + 1);
  }, [clearVisibleState]);

  /** Commit the pending batch as one newest-first ring update. */
  const flushPending = useCallback(() => {
    scheduledRef.current = false;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = 0;
    }
    const batch = pendingRef.current;
    if (batch.length === 0) return;
    pendingRef.current = [];
    const batchMap = new Map<number, ConsoleLogLine>();
    for (const line of batch) {
      batchMap.set(line.id, withBlob(line));
    }
    const dedupedBatch = [...batchMap.values()].sort((a, b) => b.id - a.id);
    setLines((prev) => {
      const batchIds = new Set(dedupedBatch.map((l) => l.id));
      const filteredPrev = prev.filter((p) => !batchIds.has(p.id));
      return mergeNewestFirst(dedupedBatch, filteredPrev);
    });
    setNewLineIds(new Set(dedupedBatch.map((line) => line.id)));
    // Highlight timer: only (re)schedule for non-empty batches, reducing churn on empty flushes.
    clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => setNewLineIds(new Set()), HIGHLIGHT_MS);
  }, []);

  const scheduleFlush = useCallback(() => {
    if (scheduledRef.current) return;
    scheduledRef.current = true;
    rafRef.current = requestFrame(flushPending);
    flushTimerRef.current = window.setTimeout(flushPending, FLUSH_FALLBACK_MS);
  }, [flushPending]);

  useEffect(() => {
    let disposed = false;
    let source: EventSource | null = null;
    const streamUrl = `${STREAM_URL}?category=${encodeURIComponent(category)}`;

    clearVisibleState();
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = 0;

    const connect = () => {
      if (disposed) return;
      setStatus(attemptsRef.current === 0 ? "connecting" : "error");
      // Probe auth before EventSource so 401/403 can redirect via the same bridge as fetch
      // No extra tick cost during steady streaming — only on (re)connect.
      void fetch(streamUrl, { method: "HEAD", credentials: "same-origin" })
        .then((res) => {
          if (disposed) return;
          if (res.status === 401 && !window.location.pathname.endsWith("/login")) {
            window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
          } else if (res.status === 403 && !window.location.pathname.endsWith("/banned")) {
            const rid = res.headers.get("x-request-id")?.trim() || "";
            window.location.replace(rid ? `/console/banned?rid=${encodeURIComponent(rid)}` : "/console/banned");
          }
        })
        .catch(() => {});
      const es = new EventSource(streamUrl, { withCredentials: true });
      source = es;
      es.addEventListener("init", (event) => {
        let data: { lines: ConsoleLogLine[]; lastId?: number };
        try {
          data = JSON.parse((event as MessageEvent).data as string) as { lines: ConsoleLogLine[]; lastId?: number };
        } catch {
          return;
        }
        pendingRef.current = [];
        scheduledRef.current = false;
        cancelFrame(rafRef.current);
        rafRef.current = 0;
        if (flushTimerRef.current) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = 0;
        }
        watermarkRef.current = Math.max(data.lastId ?? 0, ...data.lines.map((line) => line.id), 0);
        clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = 0;
        setNewLineIds(new Set());
        setLines(dedupAndSortWithBlob(data.lines).slice(0, MAX_LINES));
        setStatus("connected");
        attemptsRef.current = 0;
        setAttempts(0);
      });
      es.addEventListener("line", (event) => {
        let line: ConsoleLogLine;
        try {
          line = JSON.parse((event as MessageEvent).data as string) as ConsoleLogLine;
        } catch {
          return;
        }
        if (line.id < watermarkRef.current) return;
        watermarkRef.current = line.id;
        const pending = pendingRef.current;
        if (pending.length >= MAX_LINES) pending.splice(0, pending.length - MAX_LINES + 1);
        pending.push(line);
        scheduleFlush();
      });
      es.addEventListener("clear", () => {
        reset();
      });

      es.onerror = () => {
        es.close();
        if (disposed) return;
        setStatus("error");
        const delay = Math.min(1000 * 2 ** attemptsRef.current, 30_000);
        attemptsRef.current += 1;
        setAttempts(attemptsRef.current);
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      cancelFrame(rafRef.current);
      rafRef.current = 0;
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = 0;
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = 0;
      clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = 0;
      source?.close();
    };
  }, [scheduleFlush, category, clearVisibleState, reset, reconnectKey]);

  return { lines, newLineIds, status, attempts, reset };
}
