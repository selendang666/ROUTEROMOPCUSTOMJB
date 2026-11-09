/**
 * Stream domain — StopReason, StreamEvent, SseEvent, StreamMapper
 * Manual write
 */

import type { ProviderUsage } from "./telemetry.js";
import type { InternalFailure } from "./error-types.js";

export type StopReason = "completed" | "length" | "tool_call" | "content_filter" | "compaction" | "pause_turn" | "error" | "cancelled" | "premature_close" | "refusal" | "safety" | "empty" | "incomplete";

export interface NativeBlockStartEvent {
  readonly type: "native_block_start";
  readonly index: number;
  readonly block: Readonly<Record<string, unknown>>;
}

export interface NativeBlockDeltaEvent {
  readonly type: "native_block_delta";
  readonly index: number;
  readonly delta: Readonly<Record<string, unknown>>;
}

export interface NativeBlockStopEvent {
  readonly type: "native_block_stop";
  readonly index: number;
}

export interface ServerToolResultEvent {
  readonly type: "server_tool_result";
  readonly block: Readonly<Record<string, unknown>>;
}

export interface ContextItemEvent {
  readonly type: "context_item";
  readonly phase: "added" | "done";
  readonly outputIndex: number;
  readonly item: Readonly<Record<string, unknown>>;
}

export interface CompactionStartEvent {
  readonly type: "compaction_start";
}

export interface CompactionDeltaEvent {
  readonly type: "compaction_delta";
  readonly text: string;
}

export interface CompactionStopEvent {
  readonly type: "compaction_stop";
}

export type StreamEvent =
  | { readonly type: "message_start"; readonly id: string }
  | { readonly type: "thinking_delta"; readonly text: string; readonly reasoningSignature?: string }
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "tool_call_start"; readonly callId: string; readonly name: string; readonly reasoningSignature?: string }
  | { readonly type: "tool_call_delta"; readonly callId: string; readonly delta: string }
  | { readonly type: "tool_call_end"; readonly callId: string }
  | { readonly type: "usage"; readonly usage: ProviderUsage }
  | { readonly type: "message_stop"; readonly reason: StopReason; readonly error?: InternalFailure }
  | NativeBlockStartEvent
  | NativeBlockDeltaEvent
  | NativeBlockStopEvent
  | ServerToolResultEvent
  | ContextItemEvent
  | CompactionStartEvent
  | CompactionDeltaEvent
  | CompactionStopEvent;

export type ExtendedStreamEvent = StreamEvent;

export interface SseEvent {
  readonly event: string | null;
  readonly data: string;
}

export interface SseDecodeConfig {
  readonly body: ReadableStream<Uint8Array>;
  readonly coordinator?: unknown;
  readonly signal?: AbortSignal;
  readonly maxLineBytes?: number;
  readonly maxEventBytes?: number;
  readonly idleTimeoutMs?: number;
}

export type StreamMapper = (sse: SseEvent) => StreamEvent | readonly StreamEvent[] | null;

export function isTerminalEvent(event: StreamEvent): boolean {
  return event.type === "message_stop";
}
