import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildSearchBlob } from "../../../src/hooks/use-console-log-stream";
import type { ConsoleLogLine } from "../../../src/hooks/use-console-log-stream";

const mockStream = vi.fn();

vi.mock("../../../src/hooks/use-console-log-stream", async () => {
  const actual = (await vi.importActual("../../../src/hooks/use-console-log-stream")) as typeof import("../../../src/hooks/use-console-log-stream");
  return {
    ...actual,
    useConsoleLogStream: (...args: unknown[]) => mockStream(...args),
  };
});

// Import after mock
import { ConsoleLogPage } from "../../../src/features/console-log/page";

function makeLine(id: number, patch: Partial<ConsoleLogLine> = {}): ConsoleLogLine {
  const base: ConsoleLogLine = {
    id,
    ts: `2026-08-10T00:00:${String(id).padStart(2, "0")}Z`,
    level: "info",
    scope: "test",
    category: "request",
    msg: `message ${id}`,
    ...patch,
  };
  return { ...base, searchBlob: patch.searchBlob ?? buildSearchBlob({ ...base, ...patch } as ConsoleLogLine) };
}

describe("ConsoleLogPage — searchBlob + ordering", () => {
  beforeEach(() => {
    mockStream.mockReset();
    mockStream.mockReturnValue({
      lines: [],
      newLineIds: new Set<number>(),
      status: "connected",
      attempts: 0,
      reset: () => undefined,
    });
  });

  test("filters against precomputed searchBlob (case-insensitive, all fields)", async () => {
    const user = userEvent.setup();
    const lines = [
      makeLine(3, { scope: "Auth", category: "web", msg: "Hello World", level: "warn" }),
      makeLine(2, { scope: "proxy", category: "request", msg: "boom", level: "error" }),
      makeLine(1, { scope: "test", category: "system", msg: "unrelated", level: "debug" }),
    ];
    mockStream.mockReturnValue({
      lines,
      newLineIds: new Set<number>(),
      status: "connected",
      attempts: 0,
      reset: () => undefined,
    });

    render(<ConsoleLogPage />);

    expect(screen.getAllByText(/Hello World|boom|unrelated/)).toHaveLength(3);

    const input = screen.getByLabelText("Search console logs");
    await user.type(input, "auth");
    await waitFor(() => expect(screen.getByText("Hello World")).toBeInTheDocument());
    expect(screen.queryByText("boom")).not.toBeInTheDocument();
    expect(screen.queryByText("unrelated")).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "web");
    await waitFor(() => expect(screen.getByText("Hello World")).toBeInTheDocument());
    expect(screen.queryByText("boom")).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "HELLO");
    await waitFor(() => expect(screen.getByText("Hello World")).toBeInTheDocument());
  });

  test("search uses searchBlob field directly and preserves newest-first ordering", async () => {
    const user = userEvent.setup();
    const lines = [
      makeLine(30, { msg: "alpha search-token" }),
      makeLine(20, { msg: "beta search-token" }),
      makeLine(10, { msg: "gamma search-token" }),
    ];
    lines[1].searchBlob = buildSearchBlob({ ...lines[1], msg: "beta no-match" } as ConsoleLogLine);

    mockStream.mockReturnValue({
      lines,
      newLineIds: new Set<number>(),
      status: "connected",
      attempts: 0,
      reset: () => undefined,
    });

    render(<ConsoleLogPage />);

    const input = screen.getByLabelText("Search console logs");
    await user.type(input, "search-token");

    await waitFor(() => expect(screen.getByText("alpha search-token")).toBeInTheDocument());
    expect(screen.queryByText("beta search-token")).not.toBeInTheDocument();
    const rendered = screen.getAllByText(/alpha|gamma/).map((el) => el.textContent);
    expect(rendered).toEqual(["alpha search-token", "gamma search-token"]);
  });

  test("keeps newest-first order without extra sort when no search", async () => {
    const lines = [makeLine(5), makeLine(4), makeLine(3), makeLine(2), makeLine(1)];
    mockStream.mockReturnValue({
      lines,
      newLineIds: new Set<number>(),
      status: "connected",
      attempts: 0,
      reset: () => undefined,
    });

    render(<ConsoleLogPage />);

    const rows = screen.getAllByText(/message \d/);
    expect(rows.map((r) => r.textContent)).toEqual(["message 5", "message 4", "message 3", "message 2", "message 1"]);
  });

  test("lines render newest-first as provided by hook without re-sorting", async () => {
    const lines = [
      makeLine(4, { level: "error", msg: "e1" }),
      makeLine(3, { level: "info", msg: "i1" }),
      makeLine(2, { level: "error", msg: "e2" }),
      makeLine(1, { level: "info", msg: "i2" }),
    ];
    mockStream.mockReturnValue({
      lines,
      newLineIds: new Set<number>(),
      status: "connected",
      attempts: 0,
      reset: () => undefined,
    });

    render(<ConsoleLogPage />);

    const texts = screen.getAllByText(/e\d|i\d/).map((el) => el.textContent);
    expect(texts).toEqual(["e1", "i1", "e2", "i2"]);
  });

  test("renders structured lifecycle events as one-line entries with details", () => {
    const lines = [
      makeLine(6, {
        msg: "complete | req-one",
        context: {
          event: "complete",
          requestId: "req-one",
          endpoint: "/v1/chat/completions",
          providerId: "stub",
          model: "resolve-model",
          status: 200,
          durationMs: 6.85,
          inputTokens: 4,
          outputTokens: 2,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          accountId: "acc-1",
          proxyId: null,
        },
      }),
      makeLine(5, {
        level: "warn",
        msg: "switch | req-one",
        context: {
          event: "switch",
          requestId: "req-one",
          providerId: "stub",
          model: "resolve-model",
          status: 429,
          errorKind: "provider_rate_limited",
          accountId: "acc-1",
          proxyId: null,
          switch: {
            fromCandidateId: "candidate-1",
            toCandidateId: "candidate-2",
            reason: "provider_rate_limited",
          },
        },
      }),
      makeLine(4, {
        level: "debug",
        msg: "incoming | req-one",
        context: {
          event: "incoming",
          requestId: "req-one",
          endpoint: "/v1/chat/completions",
          providerId: "stub",
          model: "resolve-model",
          clientName: "unknown",
          clientSource: "endpoint",
        },
      }),
      makeLine(3, {
        msg: "complete | req-two",
        context: {
          event: "complete",
          requestId: "req-two",
          providerId: "cerebras",
          model: "gpt-oss-120b",
          status: 200,
          durationMs: 511,
          inputTokens: 72,
          outputTokens: 42,
          reasoningTokens: 31,
          accountId: "acc-2",
        },
      }),
    ];
    mockStream.mockReturnValue({
      lines,
      newLineIds: new Set<number>([6, 5, 4]),
      status: "connected",
      attempts: 0,
      reset: () => undefined,
    });

    render(<ConsoleLogPage />);

    expect(screen.getByText(/candidate-1 → candidate-2/)).toBeInTheDocument();
    expect(screen.getByText(/reason=provider_rate_limited/)).toBeInTheDocument();
    expect(screen.getAllByText(/request=req-one/)).toHaveLength(3);
    expect(screen.getByText(/tokens: in=4 out=2 cache=0 \(miss\) cachew=0 think=0/)).toBeInTheDocument();
    expect(screen.getByText(/in=4 out=2 cache=0 \(miss\) cachew=0 think=0/)).toBeInTheDocument();
    expect(screen.getByText(/in=72 out=42 cache=— \(unknown\) cachew=— think=31/)).toBeInTheDocument();
    expect(screen.queryByText("live")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /following|follow/i })).not.toBeInTheDocument();
  });
});
