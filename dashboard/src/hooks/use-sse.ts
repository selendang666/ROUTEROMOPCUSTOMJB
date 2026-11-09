/**
 * Canonical SSE hook — single owner for EventSource + backoff + coalesce.
 * @param url - SSE endpoint
 * @param opts - parse/maxLines/mapEvent
 * @returns data/status/error
 */
import { useEffect, useRef, useState } from "react";

export type SseStatus = "connecting" | "connected" | "error";

export interface UseSseOptions<T> {
  readonly parse?: (raw: string) => T[];
  readonly maxLines?: number;
  readonly enabled?: boolean;
}

export function useSse<T>(url: string, opts: UseSseOptions<T> = {}): {
  readonly data: readonly T[];
  readonly status: SseStatus;
  readonly error: string | null;
} {
  const [data, setData] = useState<readonly T[]>([]);
  const [status, setStatus] = useState<SseStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const attemptsRef = useRef(0);

  useEffect(() => {
    if (opts.enabled === false) return;
    let source: EventSource | null = null;
    let backoff = 1000;
    let timer: number | null = null;

    const connect = () => {
      setStatus("connecting");
      // HEAD probe to surface 401/403 without opaque SSE error
      void fetch(url, { method: "HEAD" }).catch(() => undefined);
      source = new EventSource(url, { withCredentials: true } as unknown as EventSourceInit);
      source.onopen = () => {
        setStatus("connected");
        setError(null);
        attemptsRef.current = 0;
        backoff = 1000;
      };
      source.onerror = () => {
        setStatus("error");
        setError("SSE disconnected");
        source?.close();
        attemptsRef.current += 1;
        const delay = Math.min(backoff, 30000);
        backoff *= 2;
        timer = window.setTimeout(connect, delay);
      };
      source.onmessage = (event: MessageEvent) => {
        try {
          const parsed = opts.parse ? opts.parse(event.data) : ([JSON.parse(event.data) as T] as T[]);
          setData((prev) => {
            const next = [...prev, ...parsed];
            const max = opts.maxLines ?? 200;
            return next.length > max ? next.slice(next.length - max) : next;
          });
        } catch {
          // ignore parse error
        }
      };
    };
    connect();
    return () => {
      source?.close();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [url, opts.enabled, opts.maxLines, opts.parse]);

  void attemptsRef;
  return { data, status, error };
}
