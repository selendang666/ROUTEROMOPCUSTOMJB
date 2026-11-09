import type { ExtendedStreamEvent, StopReason } from "../types/stream.js";
import type { ProviderUsage } from "../types/telemetry.js";
import type { Surface } from "../types/surface.js";
import { STREAM_BOUNDS, StreamError } from "../transport/sse.js";
import { usageNumber } from "../usage.js";
import { markSampledOverhead } from "../../runtime/overhead.js";
import { utf8Encoder } from "../protocol-request.js";


// Internal alias used by surface translation and commit logic; external callers use StreamEvent.
type InternalStreamEvent = ExtendedStreamEvent;

// Surface stream translation (bounded frames, no retry after commit) ─────────
// Reuse the protocol request TextEncoder, pooled DONE frame, cached prefixes, encodeInto slab
const utf8 = utf8Encoder;
const DONE_FRAME = utf8.encode("data: [DONE]\n\n");
// 8 KiB reusable slab for small frames — avoids per-frame Uint8Array allocation for typical SSE chunks (<2KB JSON)
const SSE_SLAB = new Uint8Array(8192);
const eventPrefixCache = new Map<string, string>();
const chatPrefixCache = new Map<string, string>();
function getEventPrefix(event: string | undefined): string {
  if (event === undefined) return "";
  let cached = eventPrefixCache.get(event);
  if (cached === undefined) {
    cached = `event: ${event}\n`;
    eventPrefixCache.set(event, cached);
  }
  return cached;
}
function getChatPrefix(id: string, created: number, model: string): string {
  const key = `${id}\0${created}\0${model}`;
  let cached = chatPrefixCache.get(key);
  if (cached === undefined) {
    cached = `{"id":${JSON.stringify(id)},"object":"chat.completion.chunk","created":${created},"model":${JSON.stringify(model)}`;
    if (chatPrefixCache.size >= 128) {
      // LRU trim: remove oldest 32 entries (Map preserves insertion order)
      const keys = chatPrefixCache.keys();
      for (let i = 0; i < 32; i++) {
        const next = keys.next();
        if (next.done) break;
        chatPrefixCache.delete(next.value);
      }
    }
    chatPrefixCache.set(key, cached);
  }
  return cached;
}
type WireFrame = { readonly event?: string; readonly data: unknown };
function frame(input: WireFrame): Uint8Array {
  const stop = markSampledOverhead("stream.frame");
  const ev = getEventPrefix(input.event);
  const dataStr = typeof input.data === "string" ? input.data : JSON.stringify(input.data);
  const text = `${ev}data: ${dataStr}\n\n`;
  // Fast path: encodeInto reusable slab for small frames (typical case: <8KiB)
  if (typeof utf8.encodeInto === "function" && text.length * 3 <= SSE_SLAB.length) {
    const { read, written } = utf8.encodeInto(text, SSE_SLAB);
    if (read === text.length) {
      const sliced = SSE_SLAB.slice(0, written);
      stop();
      return sliced;
    }
  }
  // Slow path: large frame — allocate exact-sized buffer
  const buf = new Uint8Array(text.length * 3);
  const { written } = utf8.encodeInto(text, buf);
  const encoded = written === buf.byteLength ? buf : buf.subarray(0, written);
  stop();
  return encoded;
}

function openAIStop(reason: StopReason, hasTool: boolean): string {
  if (reason === "error") return "error";
  if (reason === "length") return "length";
  if (reason === "tool_call" || hasTool) return "tool_calls";
  if (reason === "content_filter") return "content_filter";
  return "stop";
}

function anthropicStop(reason: StopReason): string {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_call") return "tool_use";
  if (reason === "content_filter") return "refusal";
  if (reason === "compaction") return "compaction";
  if (reason === "pause_turn") return "pause_turn";
  return "end_turn";
}

function responseStatus(reason: StopReason): "completed" | "incomplete" | "failed" {
  if (reason === "error") return "failed";
  return reason === "length" || reason === "content_filter" ? "incomplete" : "completed";
}
function responseIncompleteReason(reason: StopReason): string | undefined {
  if (reason === "length") return "max_output_tokens";
  if (reason === "content_filter") return "content_filter";
  return undefined;
}
function responseUsage(usage: ProviderUsage): Record<string, unknown> {
  const prompt = usageNumber(usage.promptTokens);
  const completion = usageNumber(usage.completionTokens);
  const total = usageNumber(usage.totalTokens) || prompt + completion;
  const cached = usage.cachedTokens !== undefined ? usageNumber(usage.cachedTokens) : 0;
  return {
    input_tokens: prompt,
    output_tokens: completion,
    total_tokens: total,
    input_tokens_details: { cached_tokens: cached },
    output_tokens_details: {
      reasoning_tokens: usage.reasoningTokens !== undefined ? usageNumber(usage.reasoningTokens) : 0,
      ...(usage.acceptedPredictionTokens !== undefined ? { accepted_prediction_tokens: usageNumber(usage.acceptedPredictionTokens) } : {}),
      ...(usage.rejectedPredictionTokens !== undefined ? { rejected_prediction_tokens: usageNumber(usage.rejectedPredictionTokens) } : {}),
    },
  };
}

async function* translateOpenAIChatStream(events: AsyncIterable<InternalStreamEvent>, model: string): AsyncGenerator<Uint8Array> {
  let id = `chatcmpl-${crypto.randomUUID()}`;
  let created = Math.floor(Date.now() / 1000);
  let started = false;
  let finished = false;
  let sawTool = false;
  let nextIdx = 0;
  const toolIdx = new Map<string, number>();
  const toolHasArgs = new Set<string>();
  let frames = 0;
  const check = (): void => {
    frames += 1;
    if (frames > STREAM_BOUNDS.framesPerEvent) throw new StreamError({ kind: "provider_protocol_error", message: `Surface translation exceeds ${STREAM_BOUNDS.framesPerEvent} frames`, routeScope: "provider" });
  };
  const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, unknown>): Uint8Array => {
    check();
    // Cache id/created/model prefix to avoid repeated JSON.stringify of invariant header
    const prefix = getChatPrefix(id, created, model);
    const choicesJson = JSON.stringify([{ index: 0, delta, finish_reason: finish }]);
    const usageJson = usage === undefined ? "" : `,"usage":${JSON.stringify(usage)}`;
    const json = `${prefix},"choices":${choicesJson}${usageJson}}`;
    return frame({ data: json });
  };

  for await (const ev of events) {
    if (ev.type === "message_start") {
      id = ev.id || id;
      if (!started) { started = true; yield chunk({ role: "assistant", content: "" }); }
      continue;
    }
    if (!started) { started = true; yield chunk({ role: "assistant", content: "" }); }
    if (ev.type === "thinking_delta") yield chunk({ reasoning_content: ev.text });
    else if (ev.type === "text_delta") yield chunk({ content: ev.text });
    else if (ev.type === "tool_call_start") {
      sawTool = true;
      const idx = nextIdx++;
      toolIdx.set(ev.callId, idx);
      yield chunk({ tool_calls: [{ index: idx, id: ev.callId, type: "function", function: { name: ev.name, arguments: "" }, ...(ev.reasoningSignature === undefined ? {} : { extra_content: { google: { thought_signature: ev.reasoningSignature } } }) }] });
    } else if (ev.type === "tool_call_delta") {
      sawTool = true;
      const idx = toolIdx.get(ev.callId) ?? nextIdx++;
      toolIdx.set(ev.callId, idx);
      toolHasArgs.add(ev.callId);
      yield chunk({ tool_calls: [{ index: idx, function: { arguments: ev.delta } }] });
    } else if (ev.type === "tool_call_end") {
      const idx = toolIdx.get(ev.callId);
      if (idx !== undefined && !toolHasArgs.has(ev.callId)) yield chunk({ tool_calls: [{ index: idx, function: { arguments: "{}" } }] });
    } else if (ev.type === "usage") {
      const cached = ev.usage.cachedTokens !== undefined ? usageNumber(ev.usage.cachedTokens) : 0;
      yield chunk({}, null, {
        prompt_tokens: usageNumber(ev.usage.promptTokens),
        completion_tokens: usageNumber(ev.usage.completionTokens),
        total_tokens: usageNumber(ev.usage.totalTokens) || usageNumber(ev.usage.promptTokens) + usageNumber(ev.usage.completionTokens),
        prompt_tokens_details: { cached_tokens: cached },
        completion_tokens_details: {
          reasoning_tokens: ev.usage.reasoningTokens !== undefined ? usageNumber(ev.usage.reasoningTokens) : 0,
          ...(ev.usage.acceptedPredictionTokens !== undefined ? { accepted_prediction_tokens: usageNumber(ev.usage.acceptedPredictionTokens) } : {}),
          ...(ev.usage.rejectedPredictionTokens !== undefined ? { rejected_prediction_tokens: usageNumber(ev.usage.rejectedPredictionTokens) } : {}),
        },
      });
    } else if (ev.type === "message_stop" && !finished) {
      finished = true;
      if (ev.reason === "error") {
        const prefix = getChatPrefix(id, created, model);
        const json = `${prefix},"choices":[{"index":0,"delta":{},"finish_reason":"error"}],"error":{"message":${JSON.stringify(ev.error?.safeMessage ?? "Stream interrupted")},"type":"stream_error","code":${JSON.stringify(ev.error?.kind ?? null)}}}`;
        yield frame({ data: json });
      } else {
        yield chunk({}, openAIStop(ev.reason, sawTool));
        yield DONE_FRAME;
      }
    }
    // extended events are ignored on OpenAI chat surface — they are handled on anthropic/responses surfaces
  }
  if (!finished) { yield chunk({}, "error"); yield DONE_FRAME; }
}

async function* translateAnthropicStream(events: AsyncIterable<InternalStreamEvent>, _model: string): AsyncGenerator<Uint8Array> {
  let id = `msg_${crypto.randomUUID()}`;
  let started = false;
  let finished = false;
  let blockIndex = -1;
  let textBlock: number | null = null;
  let thinkingBlock: number | null = null;
  const toolById = new Map<string, number>();
  const nativeByIdx = new Map<number, number>();
  const startMsg = (): Uint8Array => frame({ event: "message_start", data: { type: "message_start", message: { id, type: "message", role: "assistant", model: _model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } } });
  const stopBlock = (idx: number): Uint8Array => frame({ event: "content_block_stop", data: { type: "content_block_stop", index: idx } });
  function* closeText(): Generator<Uint8Array> {
    if (thinkingBlock !== null) { yield stopBlock(thinkingBlock); thinkingBlock = null; }
    if (textBlock !== null) { yield stopBlock(textBlock); textBlock = null; }
  }
  for await (const ev of events) {
    if (ev.type === "message_start") { id = ev.id || id; if (!started) { started = true; yield startMsg(); } continue; }
    if (ev.type === "server_tool_result") {
      yield* closeText();
      const idx = ++blockIndex;
      yield frame({ event: "content_block_start", data: { type: "content_block_start", index: idx, content_block: ev.block } });
      yield stopBlock(idx);
    } else if (ev.type === "native_block_start") {
      yield* closeText();
      const idx = ++blockIndex;
      nativeByIdx.set(ev.index, idx);
      yield frame({ event: "content_block_start", data: { type: "content_block_start", index: idx, content_block: ev.block } });
    } else if (ev.type === "native_block_delta") {
      const idx = nativeByIdx.get(ev.index);
      if (idx !== undefined) yield frame({ event: "content_block_delta", data: { type: "content_block_delta", index: idx, delta: ev.delta } });
    } else if (ev.type === "native_block_stop") {
      const idx = nativeByIdx.get(ev.index);
      if (idx !== undefined) { yield stopBlock(idx); nativeByIdx.delete(ev.index); }
    } else if (ev.type === "thinking_delta") {
      if (thinkingBlock === null) {
        yield* closeText();
        thinkingBlock = ++blockIndex;
        yield frame({ event: "content_block_start", data: { type: "content_block_start", index: thinkingBlock, content_block: { type: "thinking", thinking: "", ...(ev.reasoningSignature === undefined ? {} : { signature: ev.reasoningSignature }) } } });
      }
      yield frame({ event: "content_block_delta", data: { type: "content_block_delta", index: thinkingBlock, delta: { type: "thinking_delta", thinking: ev.text } } });
    } else if (ev.type === "text_delta") {
      if (textBlock === null) {
        yield* closeText();
        textBlock = ++blockIndex;
        yield frame({ event: "content_block_start", data: { type: "content_block_start", index: textBlock, content_block: { type: "text", text: "" } } });
      }
      yield frame({ event: "content_block_delta", data: { type: "content_block_delta", index: textBlock, delta: { type: "text_delta", text: ev.text } } });
    } else if (ev.type === "tool_call_start") {
      yield* closeText();
      const idx = ++blockIndex;
      toolById.set(ev.callId, idx);
      yield frame({ event: "content_block_start", data: { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: ev.callId, name: ev.name, input: {}, ...(ev.reasoningSignature === undefined ? {} : { signature: ev.reasoningSignature }) } } });
    } else if (ev.type === "tool_call_delta") {
      const idx = toolById.get(ev.callId);
      if (idx !== undefined) yield frame({ event: "content_block_delta", data: { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: ev.delta } } });
    } else if (ev.type === "tool_call_end") {
      const idx = toolById.get(ev.callId);
      if (idx !== undefined) { yield stopBlock(idx); toolById.delete(ev.callId); }
    } else if (ev.type === "usage") {
      yield frame({ event: "message_delta", data: { type: "message_delta", delta: {}, usage: { input_tokens: usageNumber(ev.usage.promptTokens), output_tokens: usageNumber(ev.usage.completionTokens), cache_read_input_tokens: usageNumber(ev.usage.cachedTokens), cache_creation_input_tokens: 0 } } });
    } else if (ev.type === "message_stop" && !finished) {
      finished = true;
      yield* closeText();
      for (const idx of toolById.values()) yield stopBlock(idx);
      toolById.clear();
      for (const idx of nativeByIdx.values()) yield stopBlock(idx);
      nativeByIdx.clear();
      if (ev.reason === "error") yield frame({ event: "error", data: { type: "error", error: { type: ev.error?.kind ?? "stream_error", message: ev.error?.safeMessage ?? "Stream interrupted" } } });
      else {
        yield frame({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: anthropicStop(ev.reason), stop_sequence: null }, usage: {} } });
        yield frame({ event: "message_stop", data: { type: "message_stop" } });
      }
    } else if (ev.type === "compaction_start" || ev.type === "compaction_delta" || ev.type === "compaction_stop" || ev.type === "context_item") {
      // compaction/context events are not surfaced on anthropic directly; ignore or could map to native
      continue;
    }
  }
  if (!finished) yield frame({ event: "error", data: { type: "error", error: { type: "stream_error", message: "Stream interrupted" } } });
}

async function* translateOpenAIResponsesStream(events: AsyncIterable<InternalStreamEvent>, model: string): AsyncGenerator<Uint8Array> {
  let id = `resp_${crypto.randomUUID()}`;
  let started = false;
  let finished = false;
  let seq = 0;
  let textId: string | null = null;
  let textIdx: number | null = null;
  let textChunks: string[] = [];
  let reasoningId: string | null = null;
  let reasoningIdx: number | null = null;
  let reasoningChunks: string[] = [];
  let usage: ProviderUsage | null = null;
  const outputItems: Array<Record<string, unknown>> = [];
  const active = new Map<string, { index: number; item: Record<string, unknown>; argumentChunks: string[] }>();
  const next = (): number => seq++;
  const evFrame = (data: Record<string, unknown>): Uint8Array => frame({ data: { sequence_number: next(), ...data } });
  const setOut = (i: number, item: Record<string, unknown>): void => { outputItems[i] = item; };
  const created = (): Uint8Array => evFrame({ type: "response.created", response: { id, object: "response", created_at: Math.floor(Date.now() / 1000), model, status: "in_progress", output: [] } });
  const added = (i: number, item: Record<string, unknown>): Uint8Array => evFrame({ type: "response.output_item.added", output_index: i, item });
  const partAdded = (i: number, itemId: string, content: Record<string, unknown>): Uint8Array => evFrame({ type: "response.content_part.added", item_id: itemId, output_index: i, content_index: 0, part: content });
  function* closeText(): Generator<Uint8Array> {
    if (textId === null || textIdx === null) return;
    const textVal = textChunks.join("");
    const item = (outputItems[textIdx] ?? { type: "message", id: textId, role: "assistant", content: [] }) as Record<string, unknown>;
    const content = { type: "output_text", text: textVal, annotations: [] };
    (item as Record<string, unknown>).content = [content];
    setOut(textIdx, item);
    yield evFrame({ type: "response.output_text.done", item_id: textId, output_index: textIdx, content_index: 0, text: textVal });
    yield evFrame({ type: "response.content_part.done", item_id: textId, output_index: textIdx, content_index: 0, part: content });
    yield evFrame({ type: "response.output_item.done", output_index: textIdx, item });
    textId = null; textIdx = null; textChunks = [];
  }
  function* closeReasoning(): Generator<Uint8Array> {
    if (reasoningId === null || reasoningIdx === null) return;
    const reasoningVal = reasoningChunks.join("");
    const item = (outputItems[reasoningIdx] ?? { type: "reasoning", id: reasoningId, summary: [] }) as Record<string, unknown>;
    item.summary = [{ type: "summary_text", text: reasoningVal }];
    setOut(reasoningIdx, item);
    yield evFrame({ type: "response.reasoning_summary_text.done", item_id: reasoningId, output_index: reasoningIdx, summary_index: 0, text: reasoningVal });
    yield evFrame({ type: "response.content_part.done", item_id: reasoningId, output_index: reasoningIdx, content_index: 0, part: item.summary as unknown as Record<string, unknown> });
    yield evFrame({ type: "response.output_item.done", output_index: reasoningIdx, item });
    reasoningId = null; reasoningIdx = null; reasoningChunks = [];
  }
  for await (const ev of events) {
    if (ev.type === "message_start") { id = ev.id || id; if (!started) { started = true; yield created(); } continue; }
    if (!started) { started = true; yield created(); }
    if (ev.type === "thinking_delta") {
      if (reasoningId === null || reasoningIdx === null) {
        yield* closeText();
        reasoningId = `rs_${crypto.randomUUID()}`;
        reasoningIdx = outputItems.length;
        const item = { type: "reasoning", id: reasoningId, summary: [] };
        setOut(reasoningIdx, item);
        yield added(reasoningIdx, item);
        yield partAdded(reasoningIdx, reasoningId, { type: "summary_text", text: "" });
      }
      reasoningChunks.push(ev.text);
      yield evFrame({ type: "response.reasoning_summary_text.delta", item_id: reasoningId, output_index: reasoningIdx, summary_index: 0, delta: ev.text });
    } else if (ev.type === "text_delta") {
      if (textId === null || textIdx === null) {
        yield* closeReasoning();
        textId = `msg_${crypto.randomUUID()}`;
        textIdx = outputItems.length;
        const item = { type: "message", id: textId, role: "assistant", status: "in_progress", content: [] };
        setOut(textIdx, item);
        yield added(textIdx, item);
        yield partAdded(textIdx, textId, { type: "output_text", text: "", annotations: [] });
      }
      textChunks.push(ev.text);
      yield evFrame({ type: "response.output_text.delta", item_id: textId, output_index: textIdx, content_index: 0, delta: ev.text });
    } else if (ev.type === "tool_call_start") {
      yield* closeReasoning(); yield* closeText();
      const idx = outputItems.length;
      const item = { type: "function_call", id: ev.callId, call_id: ev.callId, name: ev.name, arguments: "" };
      setOut(idx, item);
      active.set(ev.callId, { index: idx, item, argumentChunks: [] });
      yield added(idx, item);
    } else if (ev.type === "tool_call_delta") {
      const a = active.get(ev.callId);
      if (a !== undefined) { a.argumentChunks.push(ev.delta); yield evFrame({ type: "response.function_call_arguments.delta", item_id: ev.callId, output_index: a.index, delta: ev.delta }); }
    } else if (ev.type === "tool_call_end") {
      const a = active.get(ev.callId);
      if (a !== undefined) {
        a.item.arguments = a.argumentChunks.join("");
        yield evFrame({ type: "response.function_call_arguments.done", item_id: ev.callId, output_index: a.index, arguments: a.item.arguments ?? "{}" });
        yield evFrame({ type: "response.output_item.done", output_index: a.index, item: a.item });
        active.delete(ev.callId);
      }
    } else if (ev.type === "usage") usage = ev.usage;
    else if (ev.type === "message_stop" && !finished) {
      finished = true;
      yield* closeReasoning(); yield* closeText();
      for (const [cid, a] of active) {
        a.item.arguments = a.argumentChunks.join("");
        yield evFrame({ type: "response.function_call_arguments.done", item_id: cid, output_index: a.index, arguments: a.item.arguments ?? "{}" });
        yield evFrame({ type: "response.output_item.done", output_index: a.index, item: a.item });
      }
      active.clear();
      const status = responseStatus(ev.reason);
      if (status === "failed") {
        yield evFrame({ type: "response.failed", response: { id, object: "response", status: "failed", output: outputItems, error: { code: ev.error?.kind ?? "stream_error", message: ev.error?.safeMessage ?? "Stream interrupted" } } });
      } else {
        const resp: Record<string, unknown> = { id, object: "response", created_at: Math.floor(Date.now() / 1000), model, status, output: outputItems.filter((x): x is Record<string, unknown> => x !== undefined) };
        if (usage !== null) resp.usage = responseUsage(usage);
        const inc = responseIncompleteReason(ev.reason);
        if (inc !== undefined) resp.incomplete_details = { reason: inc };
        yield evFrame({ type: status === "completed" ? "response.completed" : "response.incomplete", response: resp });
        yield DONE_FRAME;
      }
    } else if (
      ev.type === "native_block_start" ||
      ev.type === "native_block_delta" ||
      ev.type === "native_block_stop" ||
      ev.type === "server_tool_result" ||
      ev.type === "context_item" ||
      ev.type === "compaction_start" ||
      ev.type === "compaction_delta" ||
      ev.type === "compaction_stop"
    ) {
      // native/compaction events are carried as output items on responses surface
      // For now, forward as generic output items to preserve multimodal/native contract
      const idx = outputItems.length;
      const item: Record<string, unknown> = { ...ev };
      setOut(idx, item);
      yield added(idx, item);
    }
  }
  if (!finished) { yield* closeReasoning(); yield* closeText(); yield evFrame({ type: "response.incomplete", response: { id, object: "response", model, status: "incomplete", output: outputItems } }); yield DONE_FRAME; }
}

export async function* translateSurfaceStream(surface: Surface, events: AsyncIterable<InternalStreamEvent>, model: string): AsyncGenerator<Uint8Array> {
  if (surface === "openai-chat") yield* translateOpenAIChatStream(events, model);
  else if (surface === "openai-responses") yield* translateOpenAIResponsesStream(events, model);
  else if (surface === "anthropic-messages") yield* translateAnthropicStream(events, model);
  else {
    let frames = 0;
    for await (const ev of events) {
      frames += 1;
      if (frames > STREAM_BOUNDS.framesPerEvent) throw new StreamError({ kind: "provider_protocol_error", message: `Surface translation exceeds ${STREAM_BOUNDS.framesPerEvent} frames`, routeScope: "provider" });
      yield frame({ data: ev });
    }
  }
}

function surfaceErrorFrame(surface: Surface): Uint8Array {
  if (surface === "openai-responses") {
    return frame({ data: { type: "response.failed", response: { status: "failed", error: { code: "stream_error", message: "Stream interrupted" } } } });
  }
  if (surface === "anthropic-messages") {
    return frame({ event: "error", data: { type: "error", error: { type: "stream_error", message: "Stream interrupted" } } });
  }
  return frame({ data: { error: { message: "Stream interrupted", type: "stream_error", code: null } } });
}

export function createSurfaceStream(
  surface: Surface,
  events: AsyncIterable<InternalStreamEvent>,
  model: string,
  signal?: AbortSignal,
  abortUpstream?: (reason?: unknown) => void,
): ReadableStream<Uint8Array> {
  const gen = translateSurfaceStream(surface, events, model);
  let pendingChunk: Uint8Array | null = null;
  let pendingDone = false;
  let failed = false;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      await gen.return?.(undefined);
    } catch {}
  };
  if (signal) {
    if (signal.aborted) void cleanup();
    else signal.addEventListener("abort", () => void cleanup(), { once: true });
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted) {
        if (!failed) {
          failed = true;
          try { controller.enqueue(surfaceErrorFrame(surface)); } catch {}
        }
        try { controller.close(); } catch {}
        await cleanup();
        return;
      }
      if (failed) {
        controller.close();
        return;
      }
      // Flush pending chunk first (preserves order and respects backpressure)
      if (pendingChunk !== null) {
        if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
        controller.enqueue(pendingChunk);
        pendingChunk = null;
        if (pendingDone) { controller.close(); return; }
        // Fall through to fetch next chunk only if capacity remains
        if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
      } else if (pendingDone) {
        controller.close();
        return;
      }
      // Backpressure gate: do not pull upstream if downstream is saturated
      if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
      let result: IteratorResult<Uint8Array>;
      try {
        result = await gen.next();
      } catch {
        failed = true;
        try { controller.enqueue(surfaceErrorFrame(surface)); } catch {}
        try { controller.close(); } catch {}
        await cleanup();
        return;
      }
      const { value, done } = result;
      if (done) {
        try { controller.close(); } catch {}
        await cleanup();
      } else {
        // Check backpressure after async work — if consumer stalled during await, stash for next pull
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          pendingChunk = value;
          return;
        }
        controller.enqueue(value);
      }
    },
    async cancel(reason?: unknown) {
      abortUpstream?.(reason);
      pendingChunk = null;
      pendingDone = false;
      await cleanup();
    },
  }, { highWaterMark: 16 });
}

