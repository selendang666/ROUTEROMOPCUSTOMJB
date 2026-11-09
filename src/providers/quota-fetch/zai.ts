import type { FetchLike, ProviderQuotaResult } from "./shared.js";
import { getJson, percentWindow, record, text, number } from "./shared.js";



function parseZaiQuota(body: unknown): ProviderQuotaResult {
  const root = record(body) ?? {};
  const data = record(root.data) ?? root;
  // Try multiple shapes: quota, remainingFraction, quota_remaining
  const remaining = number(data.remainingFraction) ?? number(data.remaining) ?? number((data.quota as Record<string, unknown> | undefined)?.remainingFraction);
  const limit = number(data.limit) ?? null;
  const used = number(data.used) ?? null;
  if (remaining === null && used === null) {
    // If shape is quota object with percent
    const percent = number(data.percentUsed) ?? number((data.quota as Record<string, unknown> | undefined)?.percentUsed);
    if (percent !== null) {
      return { source: "zai", plan: text(data.plan) ?? text(data.tier) ?? "Z.AI", windows: [percentWindow("quota", "Quota", percent, null, used, limit)], error: null };
    }
    // No quota data — mark as no plan
    return { source: "zai", plan: null, windows: [], error: "No ZAI plan" };
  }
  const usedPercent = remaining !== null ? (1 - Math.min(1, Math.max(0, remaining))) * 100 : used !== null && limit !== null && limit > 0 ? (used / limit) * 100 : null;
  if (usedPercent === null) return { source: "zai", plan: null, windows: [], error: "No ZAI plan" };
  return {
    source: "zai",
    plan: text(data.plan) ?? text(data.tier) ?? "Z.AI",
    windows: [percentWindow("quota", "Quota", usedPercent, null, used, limit)],
    error: null,
  };
}

export async function fetchZaiQuota(credential: string, _token: unknown, fetcher: FetchLike): Promise<ProviderQuotaResult> {
  const token = credential.trim();
  if (!token) throw new Error("ZAI credential is empty.");
  const headers = { authorization: `Bearer ${token}` };
  try {
    const body = await getJson("https://api.z.ai/api/paas/v4/quota", headers, fetcher);
    return parseZaiQuota(body);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/\b404\b/.test(msg)) return { source: "zai", plan: null, windows: [], error: "No ZAI plan" };
    // Fallback: try billing endpoint (may 404 silently)
    try {
      const fallback = await getJson("https://api.z.ai/api/coding/paas/v4/billing", headers, fetcher);
      return parseZaiQuota(fallback);
    } catch {
      throw error;
    }
  }
}
