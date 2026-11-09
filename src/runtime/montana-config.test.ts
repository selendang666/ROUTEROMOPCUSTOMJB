import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authenticateApiKey } from "../api/guard.js";
import { createMontanaApiKeyPort } from "../api/montana-auth.js";
import { createMontanaConfigRuntime, getMontanaConfigRuntime, type MontanaConfigRuntime } from "./montana-config.js";
import { buildOpenCodeHeaders, OpenCodeFreeProvider } from "../providers/api-key/opencode.js";

const runtimes: MontanaConfigRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
});

async function setup(overrides: { readonly keys?: unknown; readonly expires?: string } = {}): Promise<MontanaConfigRuntime> {
  const dir = await mkdtemp(join(tmpdir(), "ohmyomop-router-montana-"));
  await writeFile(join(dir, "keys.json"), JSON.stringify(overrides.keys ?? { keys: [{ key: "local-secret", label: "local", quota: 10, used: 0, ...(overrides.expires === undefined ? {} : { expires: overrides.expires }) }] }));
  await writeFile(join(dir, "persona.md"), "# Locked persona\nStay local.");
  await writeFile(join(dir, "relays.json"), JSON.stringify({ relays: ["https://relay.example"] }));
  await writeFile(join(dir, "upstream.json"), JSON.stringify({ base_url: "https://upstream.example/v1", api_key: "upstream-secret", origin: "https://console.example", models_default: "local-model", extra_headers: { "x-tenant": "tenant-a" }, signature_seed: "seed" }));
  const runtime = await createMontanaConfigRuntime({ configDir: dir, debounceMs: 5 });
  runtimes.push(runtime);
  return runtime;
}

test("preserves the last valid snapshot when a replacement is malformed", async () => {
  const runtime = await setup();
  const before = runtime.snapshot();
  await writeFile(join(runtime.configDir, "upstream.json"), "{not-json");
  await Bun.sleep(80);
  expect(runtime.snapshot()).toEqual(before);
  await writeFile(join(runtime.configDir, "persona.md"), "# New persona");
  await Bun.sleep(80);
  expect(runtime.snapshot().persona).toBe("# New persona");
});

test("file auth uses exact local failures and persists quota with mode 0600", async () => {
  const runtime = await setup({ keys: { keys: [{ key: "expired-secret", quota: 10, used: 0, expires: "2000-01-01T00:00:00.000Z" }] } });
  const database = { getBySecret: async () => null, touch: async () => {} };
  const port = createMontanaApiKeyPort(database, runtime);
  const expired = await authenticateApiKey(new Request("http://localhost/v1/models", { headers: { authorization: "Bearer expired-secret" } }), port);
  expect(expired.response?.status).toBe(401);
  expect(await expired.response?.json()).toMatchObject({ error: { message: "API key expired" } });

  const quotaRuntime = await setup({ keys: { keys: [{ key: "quota-secret", quota: 10, used: 10 }, { key: "persist-secret", quota: 10, used: 0 }] } });
  const quotaPort = createMontanaApiKeyPort(database, quotaRuntime);
  const quota = await authenticateApiKey(new Request("http://localhost/v1/models", { headers: { authorization: "Bearer quota-secret" } }), quotaPort);
  expect(quota.response?.status).toBe(429);
  expect(await quota.response?.json()).toMatchObject({ error: { message: "Quota exceeded" } });

  quotaRuntime.recordUsage("montana:1", 3);
  await quotaRuntime.flush();
  expect(JSON.parse(await readFile(join(quotaRuntime.configDir, "keys.json"), "utf8"))).toMatchObject({ keys: [{ used: 10 }, { used: 3 }] });
  expect((await stat(join(quotaRuntime.configDir, "keys.json"))).mode & 0o777).toBe(0o600);
});

test("uses Montana persona and OpenCode upstream settings when present", async () => {
  const runtime = await setup();
  expect(getMontanaConfigRuntime()).toBe(runtime);
  const headers = buildOpenCodeHeaders({ stream: false, publicAccess: true, path: "/v1/chat/completions" });
  expect(headers.origin).toBe("https://console.example");
  expect(headers["x-tenant"]).toBe("tenant-a");
  expect(new OpenCodeFreeProvider().resolveTarget("", "openai-chat").upstreamModelId).toBe("local-model");
});

test("OpenCode passthrough sends the requested path and default model upstream", async () => {
  await setup();
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody = "";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedBody = String(init?.body ?? "");
    return Response.json({ object: "embedding" });
  }) as typeof fetch;
  try {
    const result = await new OpenCodeFreeProvider().callPassthrough({
      target: { providerId: "opencodeft", modelId: "local-model", upstreamModelId: "local-model", surface: "openai-chat" },
      path: "/v1/embeddings",
      body: { input: "hello" },
      credential: "",
      network: { proxyId: null, url: null },
      signal: new AbortController().signal,
      headers: new Headers(),
      stream: false,
      limits: { maxBodyBytes: 1024, connectTimeoutMs: 1000, firstByteTimeoutMs: 1000, idleTimeoutMs: 1000, totalTimeoutMs: 10000 },
    });
    expect(capturedUrl).toBe("https://upstream.example/v1/embeddings");
    expect(JSON.parse(capturedBody)).toMatchObject({ input: "hello", model: "local-model" });
    expect(await result.response.json()).toEqual({ object: "embedding" });
    await result.release();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
