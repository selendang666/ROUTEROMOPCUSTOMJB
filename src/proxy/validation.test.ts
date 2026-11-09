import { describe, expect, test } from "bun:test";
import {
  boundJsonLength,
  isRecord,
  narrowArray,
  narrowBoolean,
  narrowMessageArray,
  narrowNumber,
  narrowObject,
  narrowRecord,
  narrowString,
  normalizeStream,
  narrowText,
  narrowList,
  nullableNumber,
  MAX_MODEL_LENGTH,
  MAX_TOOL_SCHEMA_LENGTH,
} from "./validation.js";
import { isProtocolError } from "./errors.js";

describe("isRecord", () => {
  test("true for plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });
  test("false for arrays, null, primitives", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(42)).toBe(false);
  });
});

describe("narrowRecord / narrowText / narrowList / nullableNumber", () => {
  test("narrowRecord returns object or null", () => {
    expect(narrowRecord({ a: 1 })).toEqual({ a: 1 });
    expect(narrowRecord([])).toBeNull();
    expect(narrowRecord(null)).toBeNull();
  });
  test("narrowText returns string or null", () => {
    expect(narrowText("hello")).toBe("hello");
    expect(narrowText(123)).toBeNull();
  });
  test("narrowList returns array or empty", () => {
    expect(narrowList([1, 2])).toEqual([1, 2]);
    expect(narrowList("x")).toEqual([]);
  });
  test("nullableNumber finite or null", () => {
    expect(nullableNumber(3.14)).toBe(3.14);
    expect(nullableNumber(NaN)).toBeNull();
    expect(nullableNumber(Infinity)).toBeNull();
    expect(nullableNumber("1")).toBeNull();
  });
});

describe("narrowString", () => {
  test("valid string passes", () => {
    expect(narrowString("hello", "field", 10)).toBe("hello");
  });
  test("wrong type returns ProtocolError", () => {
    const r = narrowString(123, "model", 10);
    expect(isProtocolError(r)).toBe(true);
  });
  test("exceeds maxLength returns error", () => {
    const r = narrowString("a".repeat(300), "model", MAX_MODEL_LENGTH);
    expect(isProtocolError(r)).toBe(true);
  });
  test("exact maxLength passes", () => {
    const s = "a".repeat(MAX_MODEL_LENGTH);
    expect(narrowString(s, "model", MAX_MODEL_LENGTH)).toBe(s);
  });
});

describe("narrowNumber", () => {
  test("valid finite number", () => {
    expect(narrowNumber(42, "temp", {})).toBe(42);
  });
  test("NaN / Infinity rejected", () => {
    expect(isProtocolError(narrowNumber(NaN, "x", {}))).toBe(true);
    expect(isProtocolError(narrowNumber(Infinity, "x", {}))).toBe(true);
    expect(isProtocolError(narrowNumber("1" as unknown as number, "x", {}))).toBe(true);
  });
  test("integer constraint", () => {
    expect(isProtocolError(narrowNumber(1.5, "count", { integer: true }))).toBe(true);
    expect(narrowNumber(2, "count", { integer: true })).toBe(2);
  });
  test("min/max bounds", () => {
    expect(isProtocolError(narrowNumber(-1, "x", { min: 0 }))).toBe(true);
    expect(isProtocolError(narrowNumber(10, "x", { max: 5 }))).toBe(true);
    expect(narrowNumber(3, "x", { min: 0, max: 5 })).toBe(3);
  });
  test("boundary inclusive", () => {
    expect(narrowNumber(0, "x", { min: 0, max: 5 })).toBe(0);
    expect(narrowNumber(5, "x", { min: 0, max: 5 })).toBe(5);
  });
});

describe("narrowBoolean", () => {
  test("accepts booleans", () => {
    expect(narrowBoolean(true, "stream")).toBe(true);
    expect(narrowBoolean(false, "stream")).toBe(false);
  });
  test("rejects non-boolean", () => {
    expect(isProtocolError(narrowBoolean(1 as unknown as boolean, "stream"))).toBe(true);
    expect(isProtocolError(narrowBoolean("true" as unknown as boolean, "stream"))).toBe(true);
  });
});

describe("normalizeStream", () => {
  test("null/undefined => false", () => {
    expect(normalizeStream(null)).toBe(false);
    expect(normalizeStream(undefined)).toBe(false);
  });
  test("boolean passthrough", () => {
    expect(normalizeStream(true)).toBe(true);
    expect(normalizeStream(false)).toBe(false);
  });
  test("non-boolean returns error", () => {
    expect(isProtocolError(normalizeStream("true"))).toBe(true);
  });
});

describe("narrowObject", () => {
  test("plain object passes", () => {
    expect(narrowObject({ a: 1 }, "meta")).toEqual({ a: 1 });
  });
  test("array / null rejected", () => {
    expect(isProtocolError(narrowObject([], "meta"))).toBe(true);
    expect(isProtocolError(narrowObject(null, "meta"))).toBe(true);
  });
});

describe("narrowArray", () => {
  test("valid array within limit", () => {
    expect(narrowArray([1, 2], "items", 5)).toEqual([1, 2]);
  });
  test("exceeds maxLength", () => {
    expect(isProtocolError(narrowArray([1, 2, 3], "items", 2))).toBe(true);
  });
  test("non-array rejected", () => {
    expect(isProtocolError(narrowArray("x", "items", 5))).toBe(true);
  });
});

describe("narrowMessageArray", () => {
  test("returns special overflow message when too long", () => {
    const arr = Array.from({ length: 5 }, (_, i) => i);
    const err = narrowMessageArray(arr, "messages", 2);
    expect(isProtocolError(err)).toBe(true);
    if (isProtocolError(err)) expect(err.safeMessage).toContain("/compact");
  });
});

describe("boundJsonLength", () => {
  test("null when within limit", () => {
    expect(boundJsonLength({ a: 1 }, "schema", 100)).toBeNull();
  });
  test("error when serialized exceeds limit", () => {
    const big = { data: "x".repeat(MAX_TOOL_SCHEMA_LENGTH) };
    const err = boundJsonLength(big, "schema", 100);
    expect(err).not.toBeNull();
    expect(isProtocolError(err!)).toBe(true);
  });
  test("handles circular references as serializable error", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    const err = boundJsonLength(obj, "schema", 1_000_000);
    expect(err).not.toBeNull();
  });
  test("empty object within limit", () => {
    expect(boundJsonLength({}, "f", 10)).toBeNull();
  });
});
