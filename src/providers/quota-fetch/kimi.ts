import type { FetchLike, ProviderQuotaResult } from "./shared.js";
import { getJson, percentWindow, record, text, number } from "./shared.js";



function kimiApiHost(): string {
  const env = typeof Bun !== "undefined" ? Bun.env.KIMI_API_HOST?.trim() : undefined;
  if (env && env.length > 0) return env.replace(/\/+$/, "");
  return "https://www.kimi.com";
}

function parseKimiQuota(body: unknown): ProviderQuotaResult {
  const root = record(body) ?? {};
  const data = record(root.data) ?? root;
  // shapes: credits, usage, quota
  const remaining = number(data.remaining) ?? number(data.credits) ?? number(data.quota_remaining);
  const limit = number(data.limit) ?? number(data.total) ?? number(data.quota_limit);
  const used = number(data.used) ?? number(data.usage);
  const percentUsed = number(data.percentUsed) ?? number(data.percent_used);
  let usedPercent: number | null = percentUsed;
  if (usedPercent === null) {
    if (remaining !== null && limit !== null && limit > 0) usedPercent = ((limit - remaining) / limit) * 100;
    else if (used !== null && limit !== null && limit > 0) usedPercent = (used / limit) * 100;
    else if (remaining !== null && remaining <= 1) usedPercent = (1 - remaining) * 100;
  }
  if (usedPercent === null) return { source: "kimi-code", plan: text(data.plan) ?? "Kimi", windows: [], error: null };
  return {
    source: "kimi-code",
    plan: text(data.plan) ?? text(data.tier) ?? "Kimi",
    windows: [percentWindow("quota", "Quota", usedPercent, null, used, limit)],
    error: null,
  };
}

export async function fetchKimiQuota(credential: string, _token: unknown, fetcher: FetchLike): Promise<ProviderQuotaResult> {
  const token = credential.trim();
  if (!token) throw new Error("Kimi credential is empty.");
  const host = kimiApiHost();
  const headers = { authorization: `Bearer ${token}` };
  // Try primary billing endpoint
  try {
    const body = await getJson(`${host}/api/billing`, headers, fetcher);
    return parseKimiQuota(body);
  } catch {
    // fallback to api host variant
    const altHost = host === "https://www.kimi.com" ? "https://api.kimi.com" : host;
    const body = await getJson(`${altHost}/v1/usage`, headers, fetcher);
    return parseKimiQuota(body);
  }
}
