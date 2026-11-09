/**
 * useInFlightStream — EventSource hook for /console/api/live/in-flight/stream.
 * Mirrors useConsoleLogStream's backoff (1s→2s→…→30s); native EventSource
 * handles SSE framing + sends the session cookie same-origin.
 */

import { useEffect, useRef, useState } from "react";

const STREAM_URL = "/console/api/live/in-flight/stream";
/** Fallback flush window when the tab is hidden and requestAnimationFrame is throttled. */
const FLUSH_FALLBACK_MS = 32;

export type InFlightStreamStatus = "connected" | "connecting" | "error";

export interface InFlightSnapshot {
  inFlight: number;
  /** Every IP with an active flight right now, busiest first — the same tracker `maxFlightsPerIp` is enforced against. */
  byIp: Array<{ ip: string; active: number }>;
  /** Providers with an active upstream call, busiest first. */
  byProvider: Array<{ providerId: string; active: number }>;
  maxFlightsPerIp: number;
  connectionStatus: InFlightStreamStatus;
}

const EMPTY: InFlightSnapshot = { inFlight: 0, byIp: [], byProvider: [], maxFlightsPerIp: 0, connectionStatus: "connecting" };

export function useInFlightSnapshot(): InFlightSnapshot {
  const [snapshot, setSnapshot] = useState<InFlightSnapshot>(EMPTY);
  const attemptsRef = useRef(0);
  const pendingDataRef = useRef<Omit<InFlightSnapshot, "connectionStatus"> | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const flushTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let source: EventSource | null = null;
    let connectionGeneration = 0;

    const flush = () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (flushTimerRef.current !== undefined) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = undefined;
      }
      const data = pendingDataRef.current;
      if (data === null) return;
      pendingDataRef.current = null;
      setSnapshot({
        ...data,
        byIp: data.byIp.slice(0, 20),
        byProvider: data.byProvider.slice(0, 20),
        connectionStatus: "connected",
      });
      attemptsRef.current = 0;
    };

    const scheduleFlush = () => {
      if (rafIdRef.current !== null) return;
      rafIdRef.current = requestAnimationFrame(flush);
      flushTimerRef.current = window.setTimeout(flush, FLUSH_FALLBACK_MS);
    };

    const connect = () => {
      if (disposed) return;
      const generation = ++connectionGeneration;
      setSnapshot((current) => ({ ...current, connectionStatus: "connecting" }));
      void fetch(STREAM_URL, { method: "HEAD", credentials: "same-origin" }).then((res) => {
        if (disposed || generation !== connectionGeneration) return;
        if (res.status === 401 && !window.location.pathname.endsWith("/login")) {
          window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
        } else if (res.status === 403 && !window.location.pathname.endsWith("/banned")) {
          const rid = res.headers.get("x-request-id")?.trim() || "";
          window.location.replace(rid ? `/console/banned?rid=${encodeURIComponent(rid)}` : "/console/banned");
        }
      }).catch(() => {});
      const es = new EventSource(STREAM_URL, { withCredentials: true });
      source = es;
      es.onopen = () => {
        if (disposed || generation !== connectionGeneration) return;
        if (timer !== undefined) {
          window.clearTimeout(timer);
          timer = undefined;
        }
        setSnapshot((current) => ({ ...current, connectionStatus: "connected" }));
      };

      es.addEventListener("count", (event) => {
        let data: Omit<InFlightSnapshot, "connectionStatus">;
        try {
          data = JSON.parse((event as MessageEvent).data as string) as Omit<InFlightSnapshot, "connectionStatus">;
        } catch {
          return;
        }
        pendingDataRef.current = data;
        scheduleFlush();
      });

      es.onerror = () => {
        if (disposed || generation !== connectionGeneration) return;
        es.close();
        if (source === es) source = null;
        setSnapshot((current) => ({ ...current, connectionStatus: "error" }));
        if (timer !== undefined) return;
        const delay = Math.min(1000 * 2 ** attemptsRef.current, 30_000);
        attemptsRef.current += 1;
        timer = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      connectionGeneration += 1;
      clearTimeout(timer);
      timer = undefined;
      source?.close();
      source = null;
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
      clearTimeout(flushTimerRef.current);
    };
  }, []);

  return snapshot;
}

/** Global in-flight count only — the common case for stat-card badges. */
export function useInFlightStream(): number {
  return useInFlightSnapshot().inFlight;
}
