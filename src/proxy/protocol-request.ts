import type { ClientProfile } from "./translate/cross-surface.js";
import type { ContentPart, ImageReference, NormalizedMessage, NormalizedTool, ReasoningConfig, RequestLimits } from "./types/content.js";
import type { ProxyRequest } from "./types/request.js";
import type { ProxyOperation } from "./types/surface.js";
import type { Surface } from "./types/surface.js";
import type { TranslationDiagnostic } from "./types/telemetry.js";
import type { ProtocolError } from "./errors.js";
import { isRecord } from "./validation.js";

// ── Field disposition & request document ────────────────────────────────────

export type FieldDispositionAction = "preserved" | "adapted" | "unsupported" | "dropped-with-diagnostic";

export interface FieldDisposition {
  readonly path: string;
  readonly action: FieldDispositionAction;
  readonly reason: string;
  readonly targetPath?: string;
}

export interface ReasoningIntent {
  readonly mode: ProxyRequest["reasoning"];
  readonly config?: ReasoningConfig;
}

export interface ResponseControls {
  readonly format: ProxyRequest["responseFormat"];
  readonly maxOutputTokens: number | null;
  readonly parallelToolCalls?: boolean;
}

export interface ConversationState {
  readonly instructions?: readonly NormalizedMessage[];
  readonly previousResponseId?: string;
  readonly store?: boolean;
  readonly include?: readonly string[];
  readonly cacheKey?: string;
  readonly contextManagement?: ProxyRequest["contextManagement"];
}

export interface RequestMetadata {
  readonly userId?: string;
  readonly client?: ClientProfile;
  readonly translationDiagnostics?: readonly TranslationDiagnostic[];
}

export interface SourceWireMetadata {
  readonly surface: Surface;
  readonly stream: boolean;
  readonly limits: RequestLimits;
  readonly hasWirePayload: boolean;
}

export interface RequestDocument {
  readonly model: string;
  readonly messages: readonly NormalizedMessage[];
  readonly tools: readonly NormalizedTool[];
  readonly reasoning: ReasoningIntent;
  readonly response: ResponseControls;
  readonly conversation: ConversationState;
  readonly media: readonly ImageReference[];
  readonly metadata: RequestMetadata;
  readonly source: SourceWireMetadata;
  /** Bounded, explicitly selected extensions; raw wire payload is never copied here. */
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly dispositions: readonly FieldDisposition[];
}

export interface RequestDocumentOptions {
  readonly client?: ClientProfile;
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly translationDiagnostics?: readonly TranslationDiagnostic[];
}

export function toRequestDocument(request: ProxyRequest, options: RequestDocumentOptions = {}): RequestDocument {
  const dispositions: FieldDisposition[] = [
    disposition("model", "preserved", "canonical model identifier"),
    disposition("messages", "preserved", "canonical conversation blocks"),
    disposition("tools", "preserved", "canonical tool definitions"),
    disposition("reasoning", "preserved", "canonical reasoning intent"),
    disposition("images", "preserved", "canonical media references"),
  ];
  if (request.wirePayload !== undefined) dispositions.push(disposition("wirePayload", "preserved", "owned by same-surface preservation policy"));
  return {
    model: request.model,
    messages: request.messages,
    tools: request.tools,
    reasoning: { mode: request.reasoning, ...(request.reasoningConfig === undefined ? {} : { config: request.reasoningConfig }) },
    response: { format: request.responseFormat, maxOutputTokens: request.maxOutputTokens },
    conversation: {
      ...(request.include === undefined ? {} : { include: request.include }),
      ...(request.contextManagement === undefined ? {} : { contextManagement: request.contextManagement }),
      ...(request.cacheKey === undefined ? {} : { cacheKey: request.cacheKey }),
    },
    media: request.images,
    metadata: {
      ...(request.metadataUserId === undefined ? {} : { userId: request.metadataUserId }),
      ...(options.client === undefined ? {} : { client: options.client }),
      ...(options.translationDiagnostics === undefined ? {} : { translationDiagnostics: options.translationDiagnostics }),
    },
    source: {
      surface: request.sourceSurface,
      stream: request.stream,
      limits: request.limits,
      hasWirePayload: request.wirePayload !== undefined,
    },
    extensions: options.extensions ?? {},
    dispositions,
  };
}

export function withFieldDisposition(document: RequestDocument, field: FieldDisposition): RequestDocument {
  return { ...document, dispositions: [...document.dispositions, field] };
}

function disposition(path: string, action: FieldDispositionAction, reason: string, targetPath?: string): FieldDisposition {
  return { path, action, reason, ...(targetPath === undefined ? {} : { targetPath }) };
}

// ── Bounded body reading ────────────────────────────────────────────────────

/** Result of bounded body reading, distinguishing oversized from malformed JSON. */
export type JsonBodyResult = { readonly ok: true; readonly value: unknown; readonly byteLength: number } | { readonly ok: false; readonly reason: "too_large" | "invalid" };

/** Result of bounded byte reading. */
export type BoundedBytesResult = { readonly ok: true; readonly value: Uint8Array } | { readonly ok: false; readonly reason: "too_large" | "invalid" };

/** Error raised by a bounded request stream once its byte limit is exceeded. */
export class BoundedBodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BoundedBodyTooLargeError";
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export const utf8Encoder = new TextEncoder();

export interface HeaderSnapshot {
  readonly apiKeyHeader: string | null;
  readonly authorization: string | null;
  readonly clientName: string | null;
  readonly userAgent: string | null;
  readonly helperMethod: string | null;
  readonly requestId: string | null;
  readonly accept: string | null;
  readonly contentType: string | null;
  readonly fingerprint: string | null;
  readonly forwardedProto: string | null;
}

/** Wraps a request body with a streaming byte limit, cancelling the source on overflow. */
export function boundedRequest(request: Request, maxBytes: number): Request {
  if (request.body === null) throw new Error("request body is missing");
  const reader = request.body.getReader();
  let totalBytes = 0;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          release();
          controller.close();
          return;
        }
        totalBytes += chunk.value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          release();
          controller.error(new BoundedBodyTooLargeError());
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    cancel(reason) {
      if (!released) void reader.cancel(reason).finally(release);
    },
  });
  const init: RequestInit & { duplex: "half" } = {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
    duplex: "half",
  };
  return new Request(request.url, init);
}

/** Reads a bounded byte body, stopping and cancelling as soon as the limit is exceeded. */
export async function readBoundedBytes(request: Request, maxBytes: number): Promise<BoundedBytesResult> {
  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
  if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > maxBytes) return { ok: false, reason: "too_large" };
  if (request.body === null) return { ok: false, reason: "invalid" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        try { await reader.cancel(); } catch { /* preserve the size classification */ }
        return { ok: false, reason: "too_large" };
      }
      chunks.push(chunk.value);
    }
  } catch {
    return { ok: false, reason: "invalid" };
  } finally {
    reader.releaseLock();
  }
  const value = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, value };
}

/** Reads a bounded JSON body and parses it on Bun's async HTTP path. */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<JsonBodyResult> {
  const bytes = await readBoundedBytes(request, maxBytes);
  if (!bytes.ok) return bytes;
  try {
    return { ok: true, value: JSON.parse(utf8.decode(bytes.value)) as unknown, byteLength: bytes.value.byteLength };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

// ── Normalize result ────────────────────────────────────────────────────────

/** Pipeline-provided context every normalizer needs beyond the wire body. */
export interface NormalizeInput {
  readonly signal: AbortSignal;
  readonly limits: RequestLimits;
  readonly operation?: ProxyOperation;
  /** When false, normalizer omits wirePayload to save ~10-64 KiB per request. Default false. Payload capture still via separate sink. */
  readonly includeWirePayload?: boolean;
}

/**
 * Validate/normalize outcome: either a fully narrowed
 * `NormalizedProviderRequest` or a typed, sanitized failure.
 */
export type NormalizeResult =
  | { readonly ok: true; readonly request: ProxyRequest }
  | { readonly ok: false; readonly error: ProtocolError };

export function normalizeOk(request: ProxyRequest): NormalizeResult {
  return { ok: true, request };
}

export function normalizeFail(error: ProtocolError): NormalizeResult {
  return { ok: false, error };
}

/** Concatenates text blocks of a normalized message, joined by newline. */
export function messageText(message: NormalizedMessage): string {
  return message.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
}

/**
 * Coerces a wire value into a plain object: objects pass through, JSON
 * strings are parsed, and anything else falls back to an empty object. Used
 * by cross-protocol response translation for tool-call arguments.
 */
export function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return isRecord(value) ? value : {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Returns visible text blocks without exposing reasoning or native metadata. */
export function visibleTextParts(message: NormalizedMessage): readonly string[] {
  return message.content
    .filter((block): block is Extract<ContentPart, { type: "text" }> => block.type === "text")
    .map((block) => block.text);
}

/** Returns the canonical visible text for a normalized message. */
export function visibleMessageText(message: NormalizedMessage): string {
  return messageText(message);
}

/** Groups tool-result blocks by call ID while preserving source order. */
export function groupToolResults(blocks: readonly ContentPart[]): ReadonlyMap<string, readonly ContentPart[]> {
  const grouped = new Map<string, ContentPart[]>();
  for (const block of blocks) {
    if (block.type !== "tool_result") continue;
    const current = grouped.get(block.toolCallId);
    if (current === undefined) grouped.set(block.toolCallId, [block]);
    else current.push(block);
  }
  return grouped;
}

/** Returns all ordered tool-result parts, retaining empty and error results. */
export function orderedToolResultParts(message: NormalizedMessage): readonly ContentPart[] {
  return message.content.filter((block): block is Extract<ContentPart, { type: "tool_result" }> => block.type === "tool_result");
}
