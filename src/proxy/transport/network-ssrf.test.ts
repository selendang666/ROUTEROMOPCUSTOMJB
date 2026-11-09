import { describe, test, expect } from "bun:test";
import { assertPublicUrl, assertPublicUrlAtDispatch, isBlockedIp, SsrfGuardError } from "./network.js";

describe("isBlockedIp malformed handling", () => {
  test("private IPs are blocked", () => {
    expect(isBlockedIp("10.0.0.1")).toBe(true);
    expect(isBlockedIp("192.168.1.1")).toBe(true);
    expect(isBlockedIp("127.0.0.1")).toBe(true);
  });
  test("malformed addresses are treated unsafe (blocked)", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("")).toBe(true);
    expect(isBlockedIp("999.999.999.999")).toBe(true);
    expect(isBlockedIp("evil.example.com")).toBe(true);
  });
  test("public IPs are not blocked", () => {
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("1.1.1.1")).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  test("blocks private IP literal", () => {
    expect(() => assertPublicUrl("http://10.0.0.1/test")).toThrow(SsrfGuardError);
    expect(() => assertPublicUrl("http://192.168.1.5/")).toThrow(SsrfGuardError);
  });
  test("blocks localhost", () => {
    expect(() => assertPublicUrl("http://localhost/test")).toThrow(SsrfGuardError);
  });
});

describe("assertPublicUrlAtDispatch DNS rebinding and malformed", () => {
  test("private DNS answer is blocked", async () => {
    const lookup = async () => [{ address: "10.0.0.1" }];
    await expect(assertPublicUrlAtDispatch("http://example.com/test", { lookup })).rejects.toThrow(SsrfGuardError);
  });

  test("malformed DNS answer is treated unsafe and blocked", async () => {
    const lookup = async () => [{ address: "not-an-ip" } as unknown as { address: string }];
    await expect(assertPublicUrlAtDispatch("http://example.com/test", { lookup })).rejects.toThrow(SsrfGuardError);
    const emptyLookup = async () => [{ address: "" } as unknown as { address: string }];
    await expect(assertPublicUrlAtDispatch("http://example.com/test", { lookup: emptyLookup })).rejects.toThrow(SsrfGuardError);
  });

  test("empty DNS answer is rejected", async () => {
    const lookup = async () => [] as const;
    await expect(assertPublicUrlAtDispatch("http://example.com/test", { lookup })).rejects.toThrow(SsrfGuardError);
  });

  test("public DNS answer passes", async () => {
    const lookup = async () => [{ address: "8.8.8.8" }];
    const url = await assertPublicUrlAtDispatch("http://example.com/test", { lookup });
    expect(url.hostname).toBe("example.com");
  });

  test("IP literal hostname skips DNS and validates directly", async () => {
    await expect(assertPublicUrlAtDispatch("http://10.0.0.1/test")).rejects.toThrow(SsrfGuardError);
    const url = await assertPublicUrlAtDispatch("http://8.8.8.8/test");
    expect(url.hostname).toBe("8.8.8.8");
  });
});
