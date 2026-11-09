#!/usr/bin/env bun
export {};
/**
 * k6-cache — stable vs volatile prompt cache hit drill.
 * Sends two workloads and reports which prefix hits via provider cachedTokens.
 *
 * Usage:
 *   bun scripts/k6-cache.ts --url http://127.0.0.1:12800 --key $PROXY_API_KEY --model anthropic/claude-3-5-sonnet
 *
 * Requires a real provider that supports prompt caching (Anthropic). For OpenAI, check cachedTokens in usage.
 */

const STABLE_SYSTEM = `You are Oh My Omop - Router. Rules: Be helpful. Repo context: ${"x".repeat(200)} — STABLE PREFIX (no timestamp/UUID) — keep this identical.`;
const VOLATILE_SYSTEM = (now: string) => `You are Oh My Omop - Router. Current time: ${now} — VOLATILE — this timestamp kills the prefix.`;

function parseArgs(): { url: string; key: string; model: string } {
  const m = new Map<string, string>();
  for (let i = 2; i < Bun.argv.length; i += 1) {
    const a = Bun.argv[i] ?? "";
    if (a.startsWith("--")) {
      const [k, v] = a.split("=", 2);
      if (v !== undefined) m.set(k.slice(2), v);
      else m.set(k.slice(2), String(Bun.argv[++i] ?? ""));
    }
  }
  return {
    url: m.get("url") ?? Bun.env.PUBLIC_ORIGIN ?? "http://127.0.0.1:12800",
    key: m.get("key") ?? Bun.env.PROXY_API_KEY ?? "",
    model: m.get("model") ?? "anthropic/claude-3-5-sonnet",
  };
}

async function chat(url: string, key: string, system: string): Promise<{ cached: number; status: number }> {
  const res = await fetch(`${url.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ model: "anthropic/claude-3-5-sonnet", messages: [{ role: "system", content: [{ type: "text", text: system }] }, { role: "user", content: [{ type: "text", text: "ping" }] }], stream: false }),
  });
  const json = (await res.json().catch(() => ({}))) as { usage?: { cached_tokens?: number; cachedTokens?: number } };
  return { cached: Number(json.usage?.cached_tokens ?? json.usage?.cachedTokens ?? 0), status: res.status };
}

async function main(): Promise<void> {
  const { url, key, model } = parseArgs();
  if (!key) throw new Error("Missing --key $PROXY_API_KEY");
  console.log(`[k6-cache] model=${model} url=${url}`);

  // Warm stable twice — second should hit if provider caches
  const s1 = await chat(url, key, STABLE_SYSTEM);
  await Bun.sleep(500);
  const s2 = await chat(url, key, STABLE_SYSTEM);
  await Bun.sleep(500);
  const v1 = await chat(url, key, VOLATILE_SYSTEM(new Date().toISOString()));
  await Bun.sleep(500);
  const v2 = await chat(url, key, VOLATILE_SYSTEM(new Date().toISOString()));

  const report = {
    stable: { firstCached: s1.cached, secondCached: s2.cached, hit: s2.cached > 0 },
    volatile: { firstCached: v1.cached, secondCached: v2.cached, hit: v2.cached > 0 },
    hint: "stable secondCached >0 means prefix kept; volatile should stay 0",
    stableSystemLength: STABLE_SYSTEM.length,
  };
  console.log(JSON.stringify(report, null, 2));
  await Bun.write("local/k6-cache-report.json", JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
