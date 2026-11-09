import { describe, expect, test } from "bun:test";
import type { PostgresPool } from "../persistence/pool.js";
import { getPrivacySnapshot, initPrivacySnapshot, maskClientIp, presentClientIp, refreshPrivacySnapshot } from "./privacy.js";

function poolStub(settingsJson: unknown): PostgresPool {
  const fn = (() => Promise.resolve([{ settings_json: settingsJson }])) as unknown as PostgresPool;
  return fn;
}

describe("initPrivacySnapshot / refreshPrivacySnapshot", () => {
  test("reads privacyMode: full from settings_json.runtime and populates the snapshot", async () => {
    await initPrivacySnapshot(poolStub({ runtime: { privacyMode: "full" } }));
    expect(getPrivacySnapshot().privacyMode).toBe("full");
  });

  test("missing runtime key falls back to masked", async () => {
    await initPrivacySnapshot(poolStub({}));
    expect(getPrivacySnapshot().privacyMode).toBe("masked");
  });

  test("unrecognized privacyMode string falls back to masked", async () => {
    await initPrivacySnapshot(poolStub({ runtime: { privacyMode: "bogus" } }));
    expect(getPrivacySnapshot().privacyMode).toBe("masked");
  });

  test("refreshPrivacySnapshot re-reads the live value and flips the cached mode", async () => {
    await initPrivacySnapshot(poolStub({ runtime: { privacyMode: "masked" } }));
    expect(getPrivacySnapshot().privacyMode).toBe("masked");
    await refreshPrivacySnapshot(poolStub({ runtime: { privacyMode: "full" } }));
    expect(getPrivacySnapshot().privacyMode).toBe("full");
  });
});

describe("maskClientIp", () => {
  test("masks the last octet of a dot-quad IPv4 address", () => {
    expect(maskClientIp("1.2.3.4")).toBe("1.2.3.*");
  });

  test("masks the last hextet of a colon-separated IPv6 address", () => {
    expect(maskClientIp("2001:db8::1")).toBe("2001:db8::*");
  });

  test("falls back to trailing-two-char masking for opaque values", () => {
    expect(maskClientIp("weird")).toBe("wei**");
  });

  test("passes through null/undefined unchanged", () => {
    expect(maskClientIp(null)).toBeNull();
    expect(maskClientIp(undefined)).toBeUndefined();
  });
});

describe("presentClientIp", () => {
  test("full mode returns the raw IP", () => {
    expect(presentClientIp("1.2.3.4", "full")).toBe("1.2.3.4");
  });

  test("masked mode returns the masked IP", () => {
    expect(presentClientIp("1.2.3.4", "masked")).toBe("1.2.3.*");
  });
});
