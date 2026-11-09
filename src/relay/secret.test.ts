import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { encryptForTesting } from "../persistence/crypto.js";
import type { PostgresPool } from "../persistence/pool.js";
import { createRelaySecretService } from "./secret.js";

const encrypted = encryptForTesting("relay-secret", { encryptionKey: Buffer.from("01234567890123456789012345678901") });

describe("relay secret service", () => {
  test("returns only a masked configured state", async () => {
    const pool = (async (strings: TemplateStringsArray) => {
      const query = strings.join("");
      if (query.includes("settings_json")) return [{ settings_json: { relay: { vercel: { secretEncrypted: encrypted } } } }];
      return [];
    }) as unknown as PostgresPool;
    const service = createRelaySecretService(pool, { encryptionKey: Buffer.from("01234567890123456789012345678901") });

    expect(await service.get()).toEqual({ configured: true, masked: "••••cret" });
  });

  test("rejects platform token fields", async () => {
    const pool = (async (strings: TemplateStringsArray) => {
      const query = strings.join("");
      if (query.includes("settings_json")) return [{ settings_json: {} }];
      return [];
    }) as unknown as PostgresPool;

    const result = await createRelaySecretService(pool, { encryptionKey: Buffer.from("01234567890123456789012345678901") }).update({ token: "vercel-platform-token" });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });
  test("does not expose encrypted storage", async () => {
    const pool = (async (strings: TemplateStringsArray) => {
      const query = strings.join("");
      if (query.includes("settings_json")) return [{ settings_json: { relay: { vercel: { secretEncrypted: encrypted } } } }];
      return [];
    }) as unknown as PostgresPool;

    const result = await createRelaySecretService(pool, { encryptionKey: Buffer.from("01234567890123456789012345678901") }).get();
    expect(JSON.stringify(result)).not.toContain("iv:tag:ciphertext");
  });
});
