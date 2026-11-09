import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import { createDrizzlePG } from "../db.js";
import { createApiKeyRepository } from "./api-keys.js";
import { createAccountRepository } from "./accounts.js";
import { createProxyRepository } from "./proxies.js";
import { createRoutingConfigRepository } from "./routing-config.js";
import { createCliMappingRepository } from "./cli-tools.js";
import { createFilterRuleRepository } from "./filter-rules.js";
import { createIpBanRepository, createRateLimitRepository, createConsoleSessionRepository } from "./security.js";
import { createShareRepository } from "./share.js";
import { createSettingsRepository } from "./settings.js";

const DATABASE_URL = Bun.env.DATABASE_URL;

const shouldRun = DATABASE_URL?.startsWith("postgres://") || DATABASE_URL?.startsWith("postgresql://");
const describeOrSkip = shouldRun ? describe : describe.skip;

describeOrSkip("drizzle repository integration (Laragon)", () => {
  let pool: InstanceType<typeof SQL>;
  let schema: string;
  beforeAll(async () => {
    if (!shouldRun) return;
    schema = `it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    pool = new SQL({ url: DATABASE_URL!, max: 5 }) as InstanceType<typeof SQL>;
    // Use a disposable schema to isolate from dev data, but keep PG search_path on public for normal tests
    // Instead we use unique IDs and cleanup via deletes; no schema switch needed to keep Drizzle table refs on public
  });

  afterAll(async () => {
    if (pool) await pool.close();
  });

  test("api-keys CRUD + lookup + revoke", async () => {
    const db = createDrizzlePG(pool as unknown as never);
    const repo = createApiKeyRepository(db);
    const id = `it_apikey_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const secret = `sk-it-${id}-secret-1234567890`;
    const created = await repo.create({ id, name: `it-${id}`, key: secret });
    expect(created.id).toBeDefined();

    const listed = await repo.list();
    expect(listed.some((r) => (r as Record<string, unknown>).id === id)).toBe(true);

    const bySecret = await repo.getBySecret(secret);
    expect((bySecret as Record<string, unknown>)?.id).toBe(id);

    await repo.touch(id);
    await repo.consumeOneTimeTokens(id, 2);
    await repo.update(id, { name: `it-${id}-renamed` });
    const updated = await repo.getById(id);
    expect((updated as Record<string, unknown>)?.name).toBe(`it-${id}-renamed`);

    await repo.revoke(id);
    const afterRevoke = await repo.getBySecret(secret);
    expect(afterRevoke).toBeNull();

    // Cleanup via Drizzle
    await db.delete((await import("../schema/pg.js")).apiKeys).where((await import("drizzle-orm")).eq((await import("../schema/pg.js")).apiKeys.id, id));
  });

  test("accounts + route snapshot cache invalidation", async () => {
    const db = createDrizzlePG(pool as unknown as never);
    const repo = createAccountRepository(db);
    const id = `it_acct_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await repo.create({ id, provider: "openai", name: `it-${id}`, credentialKind: "api_key", credential: "sk-test-123" });
    const listed = await repo.list("openai");
    expect(listed.some((r) => (r as Record<string, unknown>).id === id)).toBe(true);
    const cred = await repo.getCredential(id);
    expect(cred).toBe("sk-test-123");
    await repo.update(id, { name: `it-${id}-u` });
    const snap1 = await repo.getRouteSnapshot();
    const snap2 = await repo.getRouteSnapshot();
    expect(snap1).toBe(snap2); // cached
    repo.invalidateRouteSnapshot();
    const snap3 = await repo.getRouteSnapshot();
    expect(snap3).not.toBe(snap1);
    await repo.remove(id);
    const gone = await repo.get(id);
    expect(gone).toBeNull();
  });

  test("proxies + routing-config + cli-tools + filter-rules + settings", async () => {
    const db = createDrizzlePG(pool as unknown as never);
    const proxies = createProxyRepository(db);
    const routing = createRoutingConfigRepository(db);
    const cli = createCliMappingRepository(db);
    const filters = createFilterRuleRepository(db);
    const settings = createSettingsRepository(db);

    const proxyId = `it_proxy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await proxies.create({ id: proxyId, name: `it-${proxyId}`, protocol: "http", host: "127.0.0.1", port: 8080 });
    expect((await proxies.list()).some((r) => r.id === proxyId)).toBe(true);

    await routing.createAlias(`it-alias-${proxyId}`, "openai/gpt-4o");
    expect((await routing.listAliases()).some((r) => (r as Record<string, unknown>).alias === `it-alias-${proxyId}`)).toBe(true);
    await routing.removeAlias(`it-alias-${proxyId}`);

    const comboId = `it_combo_${proxyId}`;
    await routing.createCombo({ id: comboId, name: `it-combo-${proxyId}`, models: ["openai/gpt-4o"] });
    expect((await routing.listCombos()).some((r) => (r as Record<string, unknown>).id === comboId)).toBe(true);
    await routing.removeCombo(comboId);

    const toolId = `it_tool_${proxyId}`;
    await cli.setEnabled(toolId, true, []);
    await cli.upsert({ toolId, slotKey: "slot1", sourceModel: "a", targetModel: "b", enabled: true });
    expect((await cli.list(toolId)).length).toBe(1);
    await cli.delete(toolId, "slot1");
    await cli.reset(toolId);
    expect((await cli.getSettings(toolId))).toBeNull();

    const rule = await filters.create({ pattern: `it-${proxyId}`, replacement: "x", isRegex: false });
    expect((await filters.list()).some((r) => r.id === rule.id)).toBe(true);
    await filters.update(rule.id, { pattern: `it-${proxyId}-u` });
    expect(await filters.remove(rule.id)).toBe(true);
    expect(await filters.remove(999999999)).toBe(false);

    const all = await settings.getAll();
    expect(all).not.toBeNull();
    const settingsKey = `it_${proxyId}`;
    const patched = await settings.patchSettingsJson({ [settingsKey]: true });
    expect(patched[settingsKey]).toBe(true);
    // Settings is a shared singleton row (id = 1) — remove the probe key so
    // repeat runs don't accumulate litter in the real settings_json column.
    await pool`UPDATE settings SET settings_json = settings_json - ${settingsKey} WHERE id = 1`;

    // cleanup proxy
    const pg = await import("../schema/pg.js");
    const { eq } = await import("drizzle-orm");
    await db.delete(pg.proxies).where(eq(pg.proxies.id, proxyId));
  });

  test("security: ip-ban + rate-limit + console sessions + share", async () => {
    const db = createDrizzlePG(pool as unknown as never);
    const ipBans = createIpBanRepository(db);
    const rate = createRateLimitRepository(db);
    const sessions = createConsoleSessionRepository(db);
    const share = createShareRepository(db);

    const ip = `10.255.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
    expect(await ipBans.isBanned(ip)).toBe(false);
    const rec = await ipBans.recordFailure(ip, { maxFailures: 1, banDurationMs: 60000, reason: "failed_login" });
    expect(rec?.banned).toBe(true);
    expect(await ipBans.isBanned(ip)).toBe(true);
    expect((await ipBans.list()).some((r) => r.ip === ip)).toBe(true);
    expect(await ipBans.unban(ip)).toBe(true);
    expect(await ipBans.isBanned(ip)).toBe(false);

    const rl = await rate.touch(ip, "open", 100);
    expect(rl.count).toBeGreaterThan(0);
    expect(rl.remaining).toBeLessThanOrEqual(100);
    await rate.pruneStale(0);

    const sid = `it_sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const hash = `hash_${sid}`;
    await sessions.create({ id: sid, tokenHash: hash, data: { it: true } });
    expect(await sessions.findById(sid)).not.toBeNull();
    expect(await sessions.findByTokenHash(hash)).not.toBeNull();
    await sessions.revokeByTokenHash(hash);
    await sessions.pruneExpired();
    const pg = await import("../schema/pg.js");
    const { eq } = await import("drizzle-orm");
    await db.delete(pg.consoleSessions).where(eq(pg.consoleSessions.id, sid));

    // share: getByToken on random token should be null, touchView should not throw
    expect(await share.getByToken("not-a-real-token-12345678901234567890")).toBeNull();
    await share.touchView("not-a-real-token-12345678901234567890");
  });
});
