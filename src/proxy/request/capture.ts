import type { PayloadCapture } from "../types/telemetry.js";
import { isRecord } from "../validation.js";
/**
 * Payload capture — bounded, redacted, request/response observability.
 */



export const MAX_CAPTURE_BYTES = 16 * 1024;
const REDACTION_LOOKAHEAD_CHARS = MAX_CAPTURE_BYTES * 4;
const REDACT_KEY = /(authorization|api[_-]?key|token|secret|password|cookie|credential)/i;
const REDACT_TEXT = /((?:authorization|x-api-key|api-key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|cookie|credential)\s*[:=]\s*(?:Bearer\s+)?)[^,\s&}"']+/gi;
const REDACT_BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;


function redactText(value: string): string {
  return value.replace(REDACT_TEXT, (_match, prefix: string) => `${prefix}[REDACTED]`).replace(REDACT_BEARER, "Bearer [REDACTED]");
}

function utf8JsonStringBytes(value: string): number {
  let bytes = 2;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"' || character === "\\" || code < 0x20) bytes += code < 0x20 ? 6 : 2;
    else bytes += Buffer.byteLength(character, "utf8");
  }
  return bytes;
}

function jsonByteLength(value: unknown, depth = 0, seen = new WeakSet<object>()): number {
  if (value === null) return 4;
  if (typeof value === "string") return utf8JsonStringBytes(value);
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") return Buffer.byteLength(Number.isFinite(value) ? String(value) : "null", "utf8");
  if (typeof value !== "object") return 4;
  if (depth > 8 || seen.has(value)) return 11;
  seen.add(value);
  let bytes = Array.isArray(value) ? 2 : 2;
  let first = true;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!first) bytes += 1;
      first = false;
      bytes += jsonByteLength(item, depth + 1, seen);
    }
  } else if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      if (!first) bytes += 1;
      first = false;
      bytes += utf8JsonStringBytes(key) + 1 + jsonByteLength(value[key], depth + 1, seen);
    }
  }
  seen.delete(value);
  return bytes;
}

class BoundedWriter {
  readonly chunks: string[] = [];
  bytes = 0;
  truncated = false;

  append(value: string): void {
    if (this.truncated || value.length === 0) return;
    const valueBytes = Buffer.byteLength(value, "utf8");
    const remaining = MAX_CAPTURE_BYTES - this.bytes;
    if (valueBytes <= remaining) {
      this.chunks.push(value);
      this.bytes += valueBytes;
      return;
    }
    if (remaining > 0) {
      let end = Math.min(value.length, remaining);
      while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > remaining) end -= 1;
      if (end > 0) {
        const prefix = value.slice(0, end);
        this.chunks.push(prefix);
        this.bytes += Buffer.byteLength(prefix, "utf8");
      }
    }
    this.truncated = true;
  }

  markTruncated(): void {
    this.truncated = true;
  }

  text(): string {
    return this.chunks.join("");
  }
}

function writeBoundedJson(value: unknown, writer: BoundedWriter, depth = 0, seen = new WeakSet<object>()): void {
  if (writer.truncated) return;
  if (depth > 8) {
    writer.append(JSON.stringify("[TRUNCATED]"));
    writer.markTruncated();
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    writer.append(JSON.stringify(value) ?? "null");
    return;
  }
  if (typeof value === "string") {
    const window = redactText(value.slice(0, REDACTION_LOOKAHEAD_CHARS));
    writer.append(JSON.stringify(window) ?? "\"[REDACTED]\"");
    if (value.length > REDACTION_LOOKAHEAD_CHARS) writer.markTruncated();
    return;
  }
  if (typeof value !== "object" || seen.has(value)) {
    writer.append(JSON.stringify("[TRUNCATED]"));
    writer.markTruncated();
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    writer.append("[");
    for (let index = 0; index < value.length && !writer.truncated; index += 1) {
      if (index > 0) writer.append(",");
      writeBoundedJson(value[index], writer, depth + 1, seen);
    }
    if (!writer.truncated) writer.append("]");
  } else if (isRecord(value)) {
    writer.append("{");
    let first = true;
    for (const key of Object.keys(value)) {
      if (writer.truncated) break;
      if (!first) writer.append(",");
      first = false;
      writer.append(JSON.stringify(key));
      writer.append(":");
      if (REDACT_KEY.test(key)) writer.append(JSON.stringify("[REDACTED]"));
      else writeBoundedJson(value[key], writer, depth + 1, seen);
    }
    if (!writer.truncated) writer.append("}");
  }
  seen.delete(value);
}

function buildPayloadArtifact(value: unknown, truncated = false, originalBytes?: number): { text: string; truncated: boolean; originalBytes: number; capturedBytes: number } {
  if (typeof value === "string") {
    const original = originalBytes ?? Buffer.byteLength(value, "utf8");
    const writer = new BoundedWriter();
    writer.append(redactText(value.slice(0, REDACTION_LOOKAHEAD_CHARS)));
    if (value.length > REDACTION_LOOKAHEAD_CHARS) writer.markTruncated();
    const text = writer.text();
    return { text, truncated: truncated || writer.truncated || Buffer.byteLength(value, "utf8") > MAX_CAPTURE_BYTES, originalBytes: original, capturedBytes: Buffer.byteLength(text, "utf8") };
  }
  const writer = new BoundedWriter();
  writeBoundedJson(value, writer);
  const text = writer.text();
  const original = originalBytes ?? jsonByteLength(value);
  return { text, truncated: truncated || writer.truncated || original > MAX_CAPTURE_BYTES, originalBytes: original, capturedBytes: Buffer.byteLength(text, "utf8") };
}

export function createPayloadCapture(requestId: string, sink: { save(requestId: string, kind: "client_request" | "provider_request" | "provider_response" | "client_response", artifact: { text: string; truncated: boolean; originalBytes: number; capturedBytes: number }): void }): PayloadCapture {
  const pending = new Set<Promise<void>>();
  const save = (kind: "client_request" | "provider_request" | "provider_response" | "client_response", value: unknown, truncated = false, originalBytes?: number): void => {
    sink.save(requestId, kind, buildPayloadArtifact(value, truncated, originalBytes));
  };
  return {
    request(value): void { save("client_request", value); },
    response(value): void { save("client_response", value); },
    observeResponse(response): Response {
      if (response.body === null) return response;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let capturedBytes = 0;
      let originalBytes = 0;
      let truncated = false;
      let finalized = false;
      let settleCapture: (() => void) | null = null;
      const captureDone = new Promise<void>((resolve) => { settleCapture = resolve; });
      const finalize = (): void => {
        if (finalized) return;
        finalized = true;
        try {
          const decoder = new TextDecoder();
          let text = "";
          for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
          text += decoder.decode();
          save("provider_response", text, truncated, originalBytes);
        } catch {
        } finally {
          settleCapture?.();
        }
      };
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              finalize();
              controller.close();
              return;
            }
            const chunk = next.value;
            originalBytes += chunk.byteLength;
            if (capturedBytes < MAX_CAPTURE_BYTES) {
              const remaining = MAX_CAPTURE_BYTES - capturedBytes;
              const captured = chunk.slice(0, remaining);
              chunks.push(captured);
              capturedBytes += captured.byteLength;
              if (captured.byteLength < chunk.byteLength) truncated = true;
            } else {
              truncated = true;
            }
            controller.enqueue(chunk);
          } catch (error) {
            finalize();
            controller.error(error);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            finalize();
          }
        },
      });
      pending.add(captureDone);
      void captureDone.then(() => pending.delete(captureDone));
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
    async settle(): Promise<void> { await Promise.all(pending); },
  };
}
