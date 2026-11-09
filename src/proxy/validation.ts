import type { ProtocolError } from "./errors.js";
import { protocolError } from "./errors.js";

/**
 * Bounds applied to every external value during strict normalization.
 * Unknown values are narrowed into these limits or rejected with a typed
 * ProtocolError; nothing from the wire is trusted unbounded.
 */
export const MAX_MODEL_LENGTH = 256;

export const MAX_MESSAGE_COUNT = 2_048;

export const MAX_BLOCKS_PER_MESSAGE = 256;

export const MAX_TEXT_BLOCK_LENGTH = 512_000;

export const MAX_TOOL_COUNT = 128;

export const MAX_TOOL_NAME_LENGTH = 256;

// Claude Code's built-in tools can carry long operational descriptions.
export const MAX_TOOL_DESCRIPTION_LENGTH = 65_536;

export const MAX_TOOL_SCHEMA_LENGTH = 65_536;

export const MAX_TOOL_CALLS_PER_MESSAGE = 64;

export const MAX_TOOL_ARGUMENT_LENGTH = 512_000;

export const MAX_IMAGE_COUNT = 64;

export const MAX_IMAGE_URL_LENGTH = 4_096;

export const MAX_DATA_URL_LENGTH = 8 * 1024 * 1024;

export const MAX_MEDIA_TYPE_LENGTH = 128;

export const MAX_OUTPUT_TOKENS = 2_000_000;

/** True for plain objects (never arrays), the only wire values we read fields from. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns a plain object or null — used to extract optional object wire fields without erroring. */
export function narrowRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Returns a finite number or null — used to extract optional numeric wire fields. */
export function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Normalizes the optional `stream` flag: absent/null is false; otherwise boolean. */
export function normalizeStream(raw: unknown): boolean | ProtocolError {
  if (raw === undefined || raw === null) return false;
  return narrowBoolean(raw, "stream");
}

export function narrowObject(value: unknown, field: string): Record<string, unknown> | ProtocolError {
  if (!isRecord(value)) return protocolError(field, `${field}: expected an object`);
  return value;
}

export function narrowString(value: unknown, field: string, maxLength: number): string | ProtocolError {
  if (typeof value !== "string") return protocolError(field, `${field}: expected a string`);
  if (value.length > maxLength) return protocolError(field, `${field}: exceeds maximum length of ${maxLength} characters`);
  return value;
}

export function narrowBoolean(value: unknown, field: string): boolean | ProtocolError {
  if (typeof value !== "boolean") return protocolError(field, `${field}: expected a boolean`);
  return value;
}

export interface NumberOptions {
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

export function narrowNumber(value: unknown, field: string, options: NumberOptions = {}): number | ProtocolError {
  if (typeof value !== "number" || !Number.isFinite(value)) return protocolError(field, `${field}: expected a finite number`);
  if (options.integer === true && !Number.isInteger(value)) return protocolError(field, `${field}: expected an integer`);
  if (options.min !== undefined && value < options.min) return protocolError(field, `${field}: must be at least ${options.min}`);
  if (options.max !== undefined && value > options.max) return protocolError(field, `${field}: must be at most ${options.max}`);
  return value;
}

export function narrowArray(value: unknown, field: string, maxLength: number): unknown[] | ProtocolError {
  if (!Array.isArray(value)) return protocolError(field, `${field}: expected an array`);
  if (value.length > maxLength) return protocolError(field, `${field}: exceeds maximum length of ${maxLength} items`);
  return value;
}

export function narrowMessageArray(value: unknown, field: string, maxLength: number): unknown[] | ProtocolError {
  if (!Array.isArray(value)) return protocolError(field, `${field}: expected an array`);
  if (value.length > maxLength) {
    return protocolError(
      field,
      `${field}: exceeds maximum length of ${maxLength} items (received ${value.length}). Please use /compact to reduce conversation history, then retry.`,
    );
  }
  return value;
}

/**
 * Bounds the serialized size of a nested value (tool schemas) without
 * copying it. Uses a JSON-length estimator that counts serialized
 * characters without allocating the string, preserving the same rejection
 * threshold as JSON.stringify.
 */
export function boundJsonLength(value: unknown, field: string, maxLength: number): ProtocolError | null {
  let length: number;
  try {
    length = estimateJsonLength(value);
  } catch {
    return protocolError(field, `${field}: could not be serialized`);
  }
  if (length > maxLength) return protocolError(field, `${field}: exceeds ${maxLength} characters when serialized`);
  return null;
}

function estimateJsonLength(value: unknown): number {
  const seen = new WeakSet<object>();
  const inner = (v: unknown): number => {
    if (v === null) return 4;
    const t = typeof v;
    if (t === "string") {
      const s = v as string;
      let extra = 0;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 34 || c === 92) extra += 1;
        else if (c < 32) {
          if (c === 8 || c === 9 || c === 10 || c === 12 || c === 13) extra += 1;
          else extra += 5;
        }
      }
      return 2 + s.length + extra;
    }
    if (t === "number") return String(v).length;
    if (t === "boolean") return v ? 4 : 5;
    if (t === "undefined") return 0;
    if (Array.isArray(v)) {
      const arr = v as unknown[];
      if (seen.has(arr as object)) throw new Error("circular");
      seen.add(arr as object);
      if (arr.length === 0) {
        seen.delete(arr as object);
        return 2;
      }
      let len = 1;
      for (let i = 0; i < arr.length; i++) {
        if (i > 0) len += 1;
        const item = arr[i];
        if (item === undefined || typeof item === "function" || typeof (item as unknown) === "symbol") len += 4;
        else len += inner(item);
      }
      len += 1;
      seen.delete(arr as object);
      return len;
    }
    if (t === "object") {
      const obj = v as Record<string, unknown>;
      if (seen.has(obj)) throw new Error("circular");
      seen.add(obj);
      const keys = Object.keys(obj);
      let filtered: string[] = [];
      for (const k of keys) {
        const val = obj[k];
        if (val === undefined || typeof val === "function" || typeof (val as unknown) === "symbol") continue;
        filtered.push(k);
      }
      if (filtered.length === 0) {
        seen.delete(obj);
        return 2;
      }
      let len = 1;
      for (let i = 0; i < filtered.length; i++) {
        if (i > 0) len += 1;
        const k = filtered[i]!;
        let extra = 0;
        for (let j = 0; j < k.length; j++) {
          const c = k.charCodeAt(j);
          if (c === 34 || c === 92) extra += 1;
          else if (c < 32) {
            if (c === 8 || c === 9 || c === 10 || c === 12 || c === 13) extra += 1;
            else extra += 5;
          }
        }
        len += 2 + k.length + extra + 1;
        len += inner(obj[k]);
      }
      len += 1;
      seen.delete(obj);
      return len;
    }
    return 0;
  };
  return inner(value);
}

/** Returns a finite string or null — used to extract optional string wire fields without erroring. */
export function narrowText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Returns the value as an array, or an empty array when it is not one. */
export function narrowList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
