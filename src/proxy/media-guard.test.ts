import { describe, expect, test } from "bun:test";
import { classifyImageReference, pushImageReference } from "./media-guard.js";
import type { ImageReference } from "./types/content.js";
import { MAX_DATA_URL_LENGTH, MAX_IMAGE_COUNT } from "./validation.js";
import { isProtocolError } from "./errors.js";

describe("classifyImageReference", () => {
  test("accepts valid data URL", () => {
    const url = "data:image/png;base64,abcd";
    const r = classifyImageReference(url, "images[0]");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reference.kind).toBe("data");
      expect(r.reference.mediaType).toBe("image/png");
    }
  });

  test("data URL missing comma rejected", () => {
    const r = classifyImageReference("data:image/png;base64abcd", "images[0]");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("images[0]");
  });

  test("data URL exceeds max length rejected", () => {
    const long = "data:image/png;base64," + "a".repeat(MAX_DATA_URL_LENGTH);
    const r = classifyImageReference(long, "images[0]");
    expect(r.ok).toBe(false);
  });

  test("media type exceeding limit rejected", () => {
    const longType = "a".repeat(200);
    const r = classifyImageReference(`data:${longType};base64,abc`, "images[0]");
    expect(r.ok).toBe(false);
  });

  test("data URL with no media type accepted (mediaType null)", () => {
    const r = classifyImageReference("data:;base64,abc", "images[0]");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reference.mediaType).toBeNull();
  });

  test("accepts valid https URL", () => {
    const r = classifyImageReference("https://example.com/image.png", "images[0]");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reference.kind).toBe("url");
  });

  test("rejects non-string", () => {
    const r = classifyImageReference(123, "images[0]");
    expect(r.ok).toBe(false);
  });

  test("rejects empty string", () => {
    const r = classifyImageReference("   ", "images[0]");
    expect(r.ok).toBe(false);
  });

  test("rejects URL with embedded credentials", () => {
    const r = classifyImageReference("https://user:pass@example.com/img.png", "images[0]");
    expect(r.ok).toBe(false);
  });

  test("rejects unsupported scheme", () => {
    const r = classifyImageReference("ftp://example.com/img.png", "images[0]");
    expect(r.ok).toBe(false);
  });

  test("rejects private IPv4", () => {
    const r = classifyImageReference("http://192.168.1.1/img.png", "images[0]");
    expect(r.ok).toBe(false);
  });

  test("rejects loopback 127.0.0.1", () => {
    const r = classifyImageReference("http://127.0.0.1/img.png", "images[0]");
    expect(r.ok).toBe(false);
  });

  test("rejects localhost name", () => {
    const r = classifyImageReference("http://localhost/img.png", "images[0]");
    expect(r.ok).toBe(false);
  });

  test("rejects .local private-use name", () => {
    const r = classifyImageReference("http://myhost.local/img.png", "images[0]");
    expect(r.ok).toBe(false);
  });

  test("rejects single-label host", () => {
    const r = classifyImageReference("http://intranet/img.png", "images[0]");
    expect(r.ok).toBe(false);
  });

  test("rejects loopback IPv6 ::1", () => {
    const r = classifyImageReference("http://[::1]/img.png", "images[0]");
    expect(r.ok).toBe(false);
  });

  test("rejects malformed URL", () => {
    const r = classifyImageReference("https://[invalid]/img.png", "images[0]");
    // URL constructor may throw; classified as malformed
    expect(r.ok).toBe(false);
  });

  test("trims whitespace before classification", () => {
    const r = classifyImageReference("  https://example.com/a.png  ", "images[0]");
    expect(r.ok).toBe(true);
  });
});

describe("pushImageReference", () => {
  test("pushes within bound", () => {
    const target: ImageReference[] = [];
    const r = classifyImageReference("https://example.com/a.png", "images[0]");
    if (r.ok) {
      const err = pushImageReference(target, r.reference, "images");
      expect(err).toBeNull();
      expect(target.length).toBe(1);
    }
  });

  test("rejects when exceeding MAX_IMAGE_COUNT", () => {
    const target: ImageReference[] = Array.from({ length: MAX_IMAGE_COUNT }, (_, i) => ({ kind: "url" as const, value: `https://example.com/${i}.png`, mediaType: null }));
    const r = classifyImageReference("https://example.com/overflow.png", "images[64]");
    if (r.ok) {
      const err = pushImageReference(target, r.reference, "images[64]");
      expect(err).not.toBeNull();
      expect(isProtocolError(err!)).toBe(true);
      expect(target.length).toBe(MAX_IMAGE_COUNT);
    }
  });

  test("data URL reference also counted", () => {
    const target: ImageReference[] = [];
    const r = classifyImageReference("data:image/jpeg;base64,abc", "images[0]");
    if (r.ok) {
      const err = pushImageReference(target, r.reference, "images");
      expect(err).toBeNull();
    }
  });
});
