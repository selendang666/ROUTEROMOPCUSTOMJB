import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildSearchBlob,
  useConsoleLogStream,
  type ConsoleLogLine,
} from "../../src/hooks/use-console-log-stream";

class FakeEventSource {
  static instance: FakeEventSource | null = null;
  static closeCount = 0;

  readonly url: string;
  readonly withCredentials: boolean;
  closed = false;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();

  constructor(url: string, options?: EventSourceInit) {
    this.url = url;
    this.withCredentials = options?.withCredentials ?? false;
    FakeEventSource.instance = this;
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener as (event: MessageEvent<string>) => void);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    FakeEventSource.closeCount += 1;
  }

  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

function makeLine(id: number, extra: Partial<ConsoleLogLine> = {}): ConsoleLogLine {
  return {
    id,
    ts: `2026-08-10T00:00:0${String(id).padStart(2, "0")}Z`,
    level: "info",
    scope: "test",
    category: "system",
    msg: `line ${id}`,
    ...extra,
  };
}

function Probe({ category = "request" }: { category?: "all" | "web" | "request" | "system" }): ReactElement {
  const { lines, newLineIds, status, attempts } = useConsoleLogStream(category);
  return (
    <output role="status">
      {JSON.stringify({ status, attempts, ids: lines.map((line) => line.id), newIds: [...newLineIds], blobs: lines.map((l) => l.searchBlob) })}
    </output>
  );
}

function RawProbe({ category = "request" }: { category?: "all" | "web" | "request" | "system" }): ReactElement {
  const { lines } = useConsoleLogStream(category);
  return <output role="status">{JSON.stringify(lines)}</output>;
}

describe("useConsoleLogStream", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(null, { status: 200, headers: {} })));
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = 1;
      setTimeout(() => cb(0), 0);
      return id as unknown as number;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    FakeEventSource.instance = null;
    FakeEventSource.closeCount = 0;
  });

  test("loads the snapshot, ignores stale lines, batches new lines, and clears", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    render(<Probe category="request" />);

    await waitFor(() => expect(FakeEventSource.instance?.url).toBe("/console/api/logs/stream?category=request"));
    expect(FakeEventSource.instance?.withCredentials).toBe(true);

    FakeEventSource.instance?.emit("init", { lines: [makeLine(1), makeLine(2)], lastId: 2 });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent('"status":"connected"'));
    {
      const text = screen.getByRole("status").textContent ?? "";
      expect(text).toContain('"ids":');
      expect(text).toContain("1");
      expect(text).toContain("2");
    }

    FakeEventSource.instance?.emit("line", makeLine(2));
    FakeEventSource.instance?.emit("line", makeLine(3));
    await waitFor(() => {
      const t = screen.getByRole("status").textContent ?? "";
      expect(t).toContain('"status":"connected"');
      expect(t).toContain("3");
    });
    {
      const text = screen.getByRole("status").textContent ?? "";
      expect(text).toContain('"newIds":');
      expect(text).toContain("3");
    }

    FakeEventSource.instance?.emit("clear", null);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent('"ids":[]'));
    expect(screen.getByRole("status")).toHaveTextContent('"newIds":[]');
  });

  test("resetting after clear accepts fresh low ids again", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const resetStreamRef: { current: (() => void) | null } = { current: null };
    function ResetProbe(): ReactElement {
      const stream = useConsoleLogStream("request");
      resetStreamRef.current = stream.reset;
      return <output role="status">{JSON.stringify({ ids: stream.lines.map((line) => line.id) })}</output>;
    }

    render(<ResetProbe />);
    await waitFor(() => expect(FakeEventSource.instance).not.toBeNull());
    FakeEventSource.instance?.emit("init", { lines: [makeLine(100)], lastId: 100 });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent('"ids":[100]'));

    const initialSource = FakeEventSource.instance;
    resetStreamRef.current?.();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent('"ids":[]'));
    await waitFor(() => {
      expect(FakeEventSource.instance).not.toBe(initialSource);
      expect(initialSource?.closed).toBe(true);
    });

    FakeEventSource.instance?.emit("line", makeLine(1, { msg: "after clear" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent('"ids":[1]'));
  });

  test("closes the EventSource when the consumer unmounts", async () => {
    FakeEventSource.closeCount = 0;
    vi.stubGlobal("EventSource", FakeEventSource);
    const view = render(<Probe />);
    await waitFor(() => expect(FakeEventSource.instance).not.toBeNull());
    expect(FakeEventSource.instance?.url).toBe("/console/api/logs/stream?category=request");

    view.unmount();

    expect(FakeEventSource.closeCount).toBe(1);
  });

  test("dedupes streamed batches by id into newest-first ring buffer", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    render(<Probe />);

    await waitFor(() => expect(FakeEventSource.instance).not.toBeNull());
    FakeEventSource.instance?.emit("init", { lines: [makeLine(5), makeLine(6)], lastId: 6 });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain('"ids":[6,5]'));

    FakeEventSource.instance?.emit("line", { ...makeLine(7), msg: "first" });
    FakeEventSource.instance?.emit("line", { ...makeLine(7), msg: "second" });
    FakeEventSource.instance?.emit("line", makeLine(8));

    await waitFor(() => {
      const t = screen.getByRole("status").textContent ?? "";
      expect(t).toContain("8");
      expect(t).toContain("7");
    });

    const raw = JSON.parse(screen.getByRole("status").textContent ?? "{}") as { ids: number[] };
    expect(raw.ids.filter((id) => id === 7)).toHaveLength(1);
    expect(raw.ids).toEqual([...raw.ids].sort((a, b) => b - a));
    expect(raw.ids).toEqual([8, 7, 6, 5]);
  });

  test("keeps newest-first ordering without re-sorting already sorted snapshot", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    render(<RawProbe />);

    await waitFor(() => expect(FakeEventSource.instance).not.toBeNull());

    FakeEventSource.instance?.emit("init", {
      lines: [makeLine(1), makeLine(3), makeLine(2)],
      lastId: 3,
    });

    await waitFor(() => {
      const text = screen.getByRole("status").textContent ?? "";
      const parsed = JSON.parse(text) as ConsoleLogLine[];
      expect(parsed.map((l) => l.id)).toEqual([3, 2, 1]);
    });

    FakeEventSource.instance?.emit("line", makeLine(4));
    FakeEventSource.instance?.emit("line", makeLine(5));

    await waitFor(() => {
      const parsed = JSON.parse(screen.getByRole("status").textContent ?? "[]") as ConsoleLogLine[];
      expect(parsed.map((l) => l.id)).toEqual([5, 4, 3, 2, 1]);
    });
  });

  test("merges overlapping ids so newest-first order is maintained and duplicates are removed", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    render(<RawProbe />);

    await waitFor(() => expect(FakeEventSource.instance).not.toBeNull());
    FakeEventSource.instance?.emit("init", { lines: [makeLine(10), makeLine(9), makeLine(8)], lastId: 10 });
    await waitFor(() => {
      const parsed = JSON.parse(screen.getByRole("status").textContent ?? "[]") as ConsoleLogLine[];
      expect(parsed.map((l) => l.id)).toEqual([10, 9, 8]);
    });

    FakeEventSource.instance?.emit("line", makeLine(11));
    FakeEventSource.instance?.emit("line", makeLine(12));
    FakeEventSource.instance?.emit("line", makeLine(13));

    await waitFor(() => {
      const parsed = JSON.parse(screen.getByRole("status").textContent ?? "[]") as ConsoleLogLine[];
      expect(parsed.map((l) => l.id)).toEqual([13, 12, 11, 10, 9, 8]);
      expect(parsed.filter((l) => l.id === 9)).toHaveLength(1);
    });
  });

  test("precomputes searchable blob per row matching buildSearchBlob", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    render(<RawProbe />);

    await waitFor(() => expect(FakeEventSource.instance).not.toBeNull());
    const line = makeLine(42, { level: "warn", scope: "auth", category: "web", msg: "hello blob" });
    FakeEventSource.instance?.emit("init", { lines: [line], lastId: 42 });

    await waitFor(() => {
      const parsed = JSON.parse(screen.getByRole("status").textContent ?? "[]") as ConsoleLogLine[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0].searchBlob).toBe(buildSearchBlob(line));
      expect(parsed[0].searchBlob).toBe(`${line.ts} ${line.level} ${line.category} ${line.scope} ${line.msg}`.toLowerCase());
    });

    const next = makeLine(43, { level: "error", scope: "proxy", category: "request", msg: "boom" });
    FakeEventSource.instance?.emit("line", next);

    await waitFor(() => {
      const parsed = JSON.parse(screen.getByRole("status").textContent ?? "[]") as ConsoleLogLine[];
      const found = parsed.find((l) => l.id === 43);
      expect(found?.searchBlob).toBe(buildSearchBlob(next));
    });
  });

  test("batch dedup keeps last write and blob reflects the last payload", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    render(<RawProbe />);

    await waitFor(() => expect(FakeEventSource.instance).not.toBeNull());
    FakeEventSource.instance?.emit("init", { lines: [], lastId: 0 });
    await waitFor(() => {
      const parsed = JSON.parse(screen.getByRole("status").textContent ?? "[]") as ConsoleLogLine[];
      expect(parsed).toEqual([]);
    });

    FakeEventSource.instance?.emit("line", { ...makeLine(20), msg: "first", level: "info" as const });
    FakeEventSource.instance?.emit("line", { ...makeLine(20), msg: "second", level: "error" as const });

    await waitFor(() => {
      const parsed = JSON.parse(screen.getByRole("status").textContent ?? "[]") as ConsoleLogLine[];
      const dup = parsed.filter((l) => l.id === 20);
      expect(dup).toHaveLength(1);
      expect(dup[0].msg).toBe("second");
      expect(dup[0].searchBlob).toContain("second");
      expect(dup[0].searchBlob).toContain("error");
    });
  });

  test("highlight timer churn: empty flush does not reschedule highlight window", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("EventSource", FakeEventSource);
    render(<Probe />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(FakeEventSource.instance).not.toBeNull();
    FakeEventSource.instance?.emit("init", { lines: [makeLine(1)], lastId: 1 });
    await act(async () => {
      vi.advanceTimersByTime(10);
      await Promise.resolve();
    });

    expect(screen.getByRole("status").textContent).toContain('"newIds":[]');

    FakeEventSource.instance?.emit("line", makeLine(2));
    await act(async () => {
      vi.advanceTimersByTime(10);
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toContain('"newIds":[2]');

    await act(async () => {
      vi.advanceTimersByTime(2_900);
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toContain('"newIds":[2]');

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toContain('"newIds":[]');
  });
});
