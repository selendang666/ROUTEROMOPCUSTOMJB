import { describe, expect, test } from "bun:test";
import { ToolCallAssembler } from "./tool-assembler.js";
import type { TranslationDiagnostic } from "../types/telemetry.js";

function assembler(opts: Partial<ConstructorParameters<typeof ToolCallAssembler>[0]> = {}): { asm: ToolCallAssembler; diagnostics: TranslationDiagnostic[] } {
  const diagnostics: TranslationDiagnostic[] = [];
  const asm = new ToolCallAssembler({
    maxActiveCalls: opts.maxActiveCalls ?? 10,
    maxArgumentBytes: opts.maxArgumentBytes ?? 64 * 1024,
    recordDiagnostic: (d) => diagnostics.push(d),
    ...opts,
  });
  return { asm, diagnostics };
}

describe("ToolCallAssembler late name arrival", () => {
  test("buffers deltas until name arrives then flushes", () => {
    const { asm } = assembler();
    // delta arrives before name — should buffer, no events yet
    const buffered = asm.push({ sourceKey: "0", argumentDelta: '{"city":' });
    expect(buffered.length).toBe(0);
    // name arrives later
    const flushed = asm.push({ sourceKey: "0", name: "get_weather" });
    expect(flushed.some((e) => e.type === "tool_call_start" && e.name === "get_weather")).toBe(true);
    expect(flushed.some((e) => e.type === "tool_call_delta")).toBe(true);
    const end = asm.push({ sourceKey: "0", done: true });
    expect(end.some((e) => e.type === "tool_call_end")).toBe(true);
  });

  test("emits start immediately when name provided first", () => {
    const { asm } = assembler();
    const start = asm.push({ sourceKey: "1", name: "search", argumentDelta: '{"q":"hi"}' });
    expect(start.some((e) => e.type === "tool_call_start")).toBe(true);
    expect(start.some((e) => e.type === "tool_call_delta")).toBe(true);
  });
});

describe("UTF-8 split JSON", () => {
  test("reassembles split deltas into valid JSON without diagnostic", () => {
    const { asm, diagnostics } = assembler();
    asm.push({ sourceKey: "utf", name: "fn", argumentDelta: '{"a":' });
    asm.push({ sourceKey: "utf", argumentDelta: '"hello' });
    asm.push({ sourceKey: "utf", argumentDelta: ' world"}' });
    const end = asm.push({ sourceKey: "utf", done: true });
    expect(end.some((e) => e.type === "tool_call_end")).toBe(true);
    expect(diagnostics.length).toBe(0);
  });

  test("multi-byte characters split across deltas are preserved", () => {
    const { asm } = assembler();
    const text = "café 🎉";
    const json = JSON.stringify({ t: text });
    const mid = Math.floor(json.length / 2);
    asm.push({ sourceKey: "mb", name: "fn", argumentDelta: json.slice(0, mid) });
    asm.push({ sourceKey: "mb", argumentDelta: json.slice(mid) });
    const end = asm.push({ sourceKey: "mb", done: true });
    expect(end.length).toBeGreaterThan(0);
  });
});

describe("duplicate source IDs", () => {
  test("deduplicates canonical IDs with suffix", () => {
    const { asm } = assembler();
    const a = asm.push({ sourceKey: "dup", sourceId: "call_1", name: "fn" });
    const callA = (a.find((e) => e.type === "tool_call_start") as Extract<typeof a[number], { type: "tool_call_start" } | never> | undefined);
    expect(callA).toBeDefined();
    const firstId = (callA as unknown as { callId: string }).callId;

    asm.push({ sourceKey: "dup", done: true });

    const b = asm.push({ sourceKey: "dup2", sourceId: "call_1", name: "fn2" });
    const callB = b.find((e) => e.type === "tool_call_start") as unknown as { callId: string } | undefined;
    expect(callB).toBeDefined();
    expect(callB!.callId).not.toBe(firstId);
    expect(callB!.callId).toContain("call_1");
  });
});

describe("interleaved parallel calls", () => {
  test("handles two concurrent sourceKeys independently", () => {
    const { asm } = assembler();
    asm.push({ sourceKey: "k0", name: "fn_a", argumentDelta: '{"x":1' });
    asm.push({ sourceKey: "k1", name: "fn_b", argumentDelta: '{"y":2' });
    asm.push({ sourceKey: "k0", argumentDelta: ',"z":3}' });
    asm.push({ sourceKey: "k1", argumentDelta: ',"w":4}' });
    const end0 = asm.push({ sourceKey: "k0", done: true });
    const end1 = asm.push({ sourceKey: "k1", done: true });
    expect(end0.some((e) => e.type === "tool_call_end")).toBe(true);
    expect(end1.some((e) => e.type === "tool_call_end")).toBe(true);
  });
});

describe("invalid JSON diagnostic", () => {
  test("emits invalid_json diagnostic on malformed args", () => {
    const { asm, diagnostics } = assembler();
    asm.push({ sourceKey: "bad", name: "fn", argumentDelta: "{not-json" });
    asm.push({ sourceKey: "bad", done: true });
    expect(diagnostics.some((d) => d.reason === "invalid_json")).toBe(true);
    expect(diagnostics[0]!.fieldCategory).toBe("arguments");
    expect(diagnostics[0]!.action).toBe("adapted");
  });

  test("emits diagnostic on trailing garbage after valid JSON", () => {
    const { asm, diagnostics } = assembler();
    asm.push({ sourceKey: "garbage", name: "fn", argumentDelta: '{"a":1} trailing' });
    asm.push({ sourceKey: "garbage", done: true });
    expect(diagnostics.some((d) => d.reason === "invalid_json")).toBe(true);
  });

  test("no diagnostic on valid JSON", () => {
    const { asm, diagnostics } = assembler();
    asm.push({ sourceKey: "good", name: "fn", argumentDelta: '{"a":1}' });
    asm.push({ sourceKey: "good", done: true });
    expect(diagnostics.length).toBe(0);
  });

  test("empty args considered valid (no diagnostic)", () => {
    const { asm, diagnostics } = assembler();
    asm.push({ sourceKey: "empty", name: "fn" });
    asm.push({ sourceKey: "empty", done: true });
    expect(diagnostics.length).toBe(0);
  });
});

describe("per-call and aggregate bounds", () => {
  test("throws when per-call limit exceeded", () => {
    const { asm } = assembler({ maxArgumentBytes: 10 });
    asm.push({ sourceKey: "bound", name: "fn", argumentDelta: "12345" });
    expect(() => asm.push({ sourceKey: "bound", argumentDelta: "123456" })).toThrow();
  });

  test("throws when too many concurrent calls", () => {
    const { asm } = assembler({ maxActiveCalls: 1 });
    asm.push({ sourceKey: "c0", name: "fn", argumentDelta: "{}" });
    expect(() => asm.push({ sourceKey: "c1", name: "fn2", argumentDelta: "{}" })).toThrow();
  });

  test("throws when tool finishes without name", () => {
    const { asm } = assembler();
    asm.push({ sourceKey: "noname", argumentDelta: '{"x":1}' });
    expect(() => asm.push({ sourceKey: "noname", done: true })).toThrow();
  });

  test("finishAll emits ends for all pending", () => {
    const { asm } = assembler();
    asm.push({ sourceKey: "fa", name: "fn_a", argumentDelta: "{}" });
    asm.push({ sourceKey: "fb", name: "fn_b", argumentDelta: "{}" });
    const events = asm.finishAll();
    expect(events.filter((e) => e.type === "tool_call_end").length).toBe(2);
  });

  test("missing sourceKey throws provider_protocol_error", () => {
    const { asm } = assembler();
    expect(() => asm.push({ sourceKey: "", name: "fn" })).toThrow();
  });
});
