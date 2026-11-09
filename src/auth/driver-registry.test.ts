import { describe, expect, test } from "bun:test";
import { createAuthDriverRegistry } from "./driver-registry.js";
import { OAuthStateManager } from "./login-session.js";
import { AntigravityOAuthDriver } from "./drivers/antigravity.js";
import { AnthropicOAuthDriver } from "./drivers/anthropic.js";
import { ClineOAuthDriver } from "./drivers/cline.js";
import { ClinePassOAuthDriver } from "./drivers/cline-pass.js";
import { CodexOAuthDriver } from "./drivers/codex.js";
import { CursorOAuthDriver } from "./drivers/cursor.js";
import { GithubCopilotOAuthDriver } from "./drivers/github-copilot.js";

describe("driver-registry canonical OAuth drivers", () => {
  test("registers all intended OAuth drivers with canonical ids", () => {
    const registry = createAuthDriverRegistry();
    expect(registry.has("codex")).toBe(true);
    expect(registry.has("claude-code")).toBe(true);
    expect(registry.has("claude")).toBe(true);
    expect(registry.has("antigravity")).toBe(true);
    expect(registry.has("cline")).toBe(true);
    expect(registry.has("cline-pass")).toBe(true);
    expect(registry.has("zai-coding-plan")).toBe(true);
    expect(registry.has("zhipu-coding-plan")).toBe(false);
    expect(registry.has("kimi-code")).toBe(true);
    expect(registry.has("github-copilot")).toBe(true);
    expect(registry.has("cursor")).toBe(true);
    expect(registry.has("devin")).toBe(true);
    // The legacy Claude alias must resolve to the canonical driver without duplicating registry entries.
    expect(registry.list()).toHaveLength(10);
    const ids = new Set(registry.list().map((e) => e.providerId));
    expect(ids.has("claude-code")).toBe(true);
    expect(ids.has("claude")).toBe(false);
  });

  test("driver providerIds are canonical and getCapabilities resolves", () => {
    const registry = createAuthDriverRegistry();
    const codex = registry.get("codex")!;
    const claude = registry.get("claude-code")!;
    expect(registry.get("claude")).toBe(claude);
    const antigravity = registry.get("antigravity")!;
    expect(codex).toBeInstanceOf(CodexOAuthDriver);
    expect(claude).toBeInstanceOf(AnthropicOAuthDriver);
    expect(antigravity).toBeInstanceOf(AntigravityOAuthDriver);
    expect(registry.get("cline")).toBeInstanceOf(ClineOAuthDriver);
    expect(registry.get("cline-pass")).toBeInstanceOf(ClinePassOAuthDriver);

    const claudeCaps = registry.getCapabilities("claude")!;
    expect(claudeCaps.supportsBrowser).toBe(true);
    expect(claudeCaps.supportsRefresh).toBe(true);
    expect(claudeCaps.accessOnly).toBe(false);

    const codexCaps = registry.getCapabilities("codex")!;
    expect(codexCaps.supportsDevice).toBe(true);
    expect(codexCaps.supportsPoll).toBe(true);

    const clineCaps = registry.getCapabilities("cline")!;
    expect(clineCaps.supportsBrowser).toBe(false);
    expect(clineCaps.supportsDevice).toBe(true);
    expect(clineCaps.supportsPoll).toBe(true);
    const clinePassCaps = registry.getCapabilities("cline-pass")!;
    expect(clinePassCaps.supportsBrowser).toBe(false);
    expect(clinePassCaps.supportsDevice).toBe(true);
    expect(clinePassCaps.supportsPoll).toBe(true);

    const zaiCaps = registry.getCapabilities("zai-coding-plan")!;
    expect(zaiCaps.supportsBrowser).toBe(true);
    expect(zaiCaps.supportsDevice).toBe(false);
    expect(zaiCaps.supportsRefresh).toBe(false);
    const kimiCaps = registry.getCapabilities("kimi-code")!;
    expect(kimiCaps.supportsDevice).toBe(true);
    expect(kimiCaps.supportsPoll).toBe(true);
    const ghCaps = registry.getCapabilities("github-copilot")!;
    expect(ghCaps.supportsDevice).toBe(true);
    expect(registry.has("github")).toBe(true);
    expect(registry.getCapabilities("github")?.supportsDevice).toBe(true);

    expect(registry.getCapabilities("unknown")).toBeNull();
    expect(registry.get("unknown")).toBeNull();
  });

  test("registry register replacement and initial overrides", () => {
    const custom = new CodexOAuthDriver();
    const registry = createAuthDriverRegistry([{ providerId: "codex", driver: custom }]);
    expect(registry.get("codex")).toBe(custom);
  });
});

describe("OAuth state one-time and bounded", () => {
  test("state is one-time use and expired swept", () => {
    let now = 1000000;
    const manager = new OAuthStateManager({ ttlMs: 50, maxStates: 10, nowMs: () => now });
    const record = manager.create({ providerId: "claude-code", state: "state-1" });
    expect(record.state).toBe("state-1");
    expect(manager.consume("state-1", "claude-code", now)).not.toBeNull();
    expect(manager.consume("state-1", "claude-code", now)).toBeNull();
    // expired
    const r2 = manager.create({ providerId: "codex", state: "state-2" });
    expect(r2.state).toBe("state-2");
    now += 80;
    expect(manager.consume("state-2", "codex", now)).toBeNull();
  });

  test("state evicts oldest when over maxStates", () => {
    const manager = new OAuthStateManager({ ttlMs: 10_000, maxStates: 2 });
    manager.create({ providerId: "codex", state: "s1" });
    manager.create({ providerId: "codex", state: "s2" });
    manager.create({ providerId: "codex", state: "s3" });
    const now = Date.now();
    expect(manager.consume("s1", "codex", now)).toBeNull();
    expect(manager.consume("s2", "codex", now)).not.toBeNull();
    expect(manager.consume("s3", "codex", now)).not.toBeNull();
  });
});

describe("OAuth driver refresh contracts", () => {
  test("Cline uses the WorkOS device flow and registers the token", async () => {
    const responses = [
      new Response(JSON.stringify({ device_code: "device-code", user_code: "ABCD-EFGH", verification_uri: "https://app.cline.bot/device", verification_uri_complete: "https://app.cline.bot/device?user_code=ABCD-EFGH", expires_in: 300, interval: 1 }), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ access_token: "workos-access", refresh_token: "workos-refresh", token_type: "Bearer" }), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ success: true, data: { accessToken: "cline-access", refreshToken: "cline-refresh", expiresAt: "2030-01-01T00:00:00.000Z", userInfo: { email: "cline@example.test", clineUserId: "cline-user" } } }), { status: 200, headers: { "content-type": "application/json" } }),
    ];
    let nowMs = 0;
    const driver = new ClineOAuthDriver({ fetch: async () => responses.shift() ?? new Response("unexpected request", { status: 500 }), nowMs: () => nowMs });
    const started = await driver.start({ providerId: "cline", state: "cline-state", flow: "device" });
    expect(started.flow).toBe("device");
    expect(started.authorizationUrl).toBe("https://app.cline.bot/device?user_code=ABCD-EFGH");
    nowMs = 1_000;
    await expect(driver.poll(started.state)).resolves.toMatchObject({ status: "completed", tokenSet: { accessToken: "cline-access", refreshToken: "cline-refresh", email: "cline@example.test" } });
  });

  test("ClinePass uses the same WorkOS device flow", async () => {
    const responses = [
      new Response(JSON.stringify({ device_code: "device-code", user_code: "CP-1234", verification_uri: "https://app.cline.bot/device", expires_in: 300, interval: 1 }), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ access_token: "workos-access", refresh_token: "workos-refresh" }), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ success: true, data: { accessToken: "cline-pass-access", refreshToken: "cline-pass-refresh", expiresAt: "2030-01-01T00:00:00.000Z" } }), { status: 200, headers: { "content-type": "application/json" } }),
    ];
    let nowMs = 0;
    const driver = new ClinePassOAuthDriver({ fetch: async () => responses.shift() ?? new Response("unexpected request", { status: 500 }), nowMs: () => nowMs });
    const started = await driver.start({ providerId: "cline-pass", state: "cline-pass-state", flow: "device" });
    expect(started.flow).toBe("device");
    nowMs = 1_000;
    await expect(driver.poll(started.state)).resolves.toMatchObject({ status: "completed", tokenSet: { accessToken: "cline-pass-access", refreshToken: "cline-pass-refresh" } });
  });

  test("Cline and ClinePass refresh preserve rotated and fallback refresh tokens", async () => {
    const fetch = async () => new Response(JSON.stringify({ success: true, data: { accessToken: "cline-access", refreshToken: "cline-next", expiresAt: new Date(Date.now() + 60_000).toISOString() } }), { status: 200, headers: { "content-type": "application/json" } });
    await expect(new ClineOAuthDriver({ fetch }).refresh({ providerId: "cline", accountId: "account-1", refreshToken: "cline-refresh" })).resolves.toMatchObject({ accessToken: "cline-access", refreshToken: "cline-next" });
    await expect(new ClinePassOAuthDriver({ fetch }).refresh({ providerId: "cline-pass", accountId: "account-2", refreshToken: "cline-refresh" })).resolves.toMatchObject({ accessToken: "cline-access", refreshToken: "cline-next" });
  });

  test("all OAuth drivers normalize a successful refresh response", async () => {
    const fetch = async (input: string | URL | Request) => {
      const url = String(input);
      const payload = url.includes("cline.bot")
        ? { success: true, data: { accessToken: "access", refreshToken: "next-refresh", expiresAt: new Date(Date.now() + 60_000).toISOString(), userInfo: { email: "oauth@example.test" } } }
        : { access_token: "access", refresh_token: "next-refresh", expires_in: 3600, account: { uuid: "account-1", email_address: "oauth@example.test" } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    };
    const input = { accountId: "account-1", refreshToken: "refresh-token" };
    await expect(new CodexOAuthDriver({ fetch }).refresh({ providerId: "codex", ...input })).resolves.toMatchObject({ accessToken: "access", refreshToken: "next-refresh" });
    await expect(new AnthropicOAuthDriver({ fetch }).refresh({ providerId: "claude-code", ...input })).resolves.toMatchObject({ accessToken: "access", refreshToken: "next-refresh" });
    await expect(new AntigravityOAuthDriver({ fetch }).refresh({ providerId: "antigravity", ...input })).resolves.toMatchObject({ accessToken: "access", refreshToken: "next-refresh" });
    await expect(new ClineOAuthDriver({ fetch }).refresh({ providerId: "cline", ...input })).resolves.toMatchObject({ accessToken: "access", refreshToken: "next-refresh" });
    await expect(new ClinePassOAuthDriver({ fetch }).refresh({ providerId: "cline-pass", ...input })).resolves.toMatchObject({ accessToken: "access", refreshToken: "next-refresh" });
  });

  test("Anthropic driver has refresh and exchange", () => {
    const driver = new AnthropicOAuthDriver();
    expect(typeof driver.refresh).toBe("function");
    expect(typeof driver.exchange).toBe("function");
    expect(typeof driver.start).toBe("function");
  });
  test("Antigravity driver has refresh", () => {
    const driver = new AntigravityOAuthDriver();
    expect(typeof driver.refresh).toBe("function");
  });
  test("Codex driver has poll and refresh", () => {
    const driver = new CodexOAuthDriver();
    expect(typeof driver.poll).toBe("function");
    expect(typeof driver.refresh).toBe("function");
  });

  test("Codex browser login is explicitly classified as browser flow", async () => {
    const result = await new CodexOAuthDriver().start({
      providerId: "codex",
      flow: "browser",
      redirectUri: "http://localhost:1455/auth/callback",
      codeChallenge: "test-code-challenge",
    });
    expect(result.flow).toBe("browser");
    expect(result.authorizationUrl).toContain("https://auth.openai.com/oauth/authorize");
    expect(result.authorizationUrl).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback");
  });
  test("Cline drivers have refresh", () => {
    expect(typeof new ClineOAuthDriver().refresh).toBe("function");
    expect(typeof new ClinePassOAuthDriver().refresh).toBe("function");
  });

  test("Cursor uses the browser login URL and GET poll contract", async () => {
    let nowMs = 0;
    let pollUrl = "";
    const driver = new CursorOAuthDriver({
      nowMs: () => nowMs,
      fetch: async (input) => {
        pollUrl = String(input);
        return new Response(JSON.stringify({ accessToken: "cursor-access", refreshToken: "cursor-refresh" }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const started = await driver.start({ providerId: "cursor", state: "cursor-state", flow: "device" });
    expect(started.flow).toBe("device");
    expect(started.authorizationUrl).toContain("mode=login");
    expect(started.authorizationUrl).toContain("redirectTarget=cli");
    nowMs = 1_000;
    await expect(driver.poll(started.state)).resolves.toMatchObject({ status: "completed", tokenSet: { accessToken: "cursor-access", refreshToken: "cursor-refresh" } });
    expect(pollUrl).toContain("https://api2.cursor.sh/auth/poll?uuid=");
    expect(pollUrl).toContain("verifier=");
  });

  test("GitHub Copilot handles JSON pending and slow_down responses", async () => {
    let nowMs = 0;
    const responses = [
      new Response(JSON.stringify({ device_code: "device-code", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ error: "authorization_pending" }), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ error: "slow_down" }), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ access_token: "copilot-access" }), { status: 200, headers: { "content-type": "application/json" } }),
    ];
    const driver = new GithubCopilotOAuthDriver({ nowMs: () => nowMs, fetch: async () => responses.shift() ?? new Response("unexpected", { status: 500 }) });
    const started = await driver.start({ providerId: "github-copilot", state: "copilot-state", flow: "device" });
    nowMs = 5_000;
    await expect(driver.poll(started.state)).resolves.toMatchObject({ status: "pending" });
    nowMs = 10_000;
    await expect(driver.poll(started.state)).resolves.toMatchObject({ status: "pending" });
    nowMs = 20_000;
    await expect(driver.poll(started.state)).resolves.toMatchObject({ status: "completed", tokenSet: { accessToken: "copilot-access" } });
  });
});

describe("OAuth driver single-flight via registry lazy not driver registry but refresher pool shape", () => {
  test("concurrent ensureLoaded-like dedup via manual single-flight", async () => {
    let calls = 0;
    const work = async () => {
      calls++;
      return calls;
    };
    let pending: Promise<number> | null = null;
    const load = () => {
      if (pending === null) pending = work().finally(() => {});
      return pending;
    };
    const [a, b, c] = await Promise.all([load(), load(), load()]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(c).toBe(1);
    expect(calls).toBe(1);
  });
});

