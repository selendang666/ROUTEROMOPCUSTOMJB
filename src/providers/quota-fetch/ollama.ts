import type { FetchLike, ProviderQuotaResult } from "./shared.js";
import { getJson, number, percentWindow, quotaRecord, record, text } from "./shared.js";



function ratioWindow(kind: string, label: string, value: unknown) {
  const ratio = number(value);
  if (ratio === null) return null;
  const usedPercent = Math.min(100, Math.max(0, ratio * 100));
  return percentWindow(kind, label, usedPercent, null, usedPercent, 100);
}

async function fetchPlan(fetcher: FetchLike, headers: Record<string, string>): Promise<string> {
  try {
    const response = await fetcher("https://ollama.com/api/me", {
      method: "POST",
      headers: { accept: "application/json", "content-length": "0", ...headers },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return "Ollama Cloud";
    const body: unknown = JSON.parse(await response.text());
    const plan = text(record(body)?.Plan);
    return plan === null ? "Ollama Cloud" : `${plan.slice(0, 1).toUpperCase()}${plan.slice(1).toLowerCase()}`;
  } catch {
    return "Ollama Cloud";
  }
}

/** Fetches Ollama Cloud session and weekly usage percentages. */
export async function fetchOllamaQuota(credential: string, fetcher: FetchLike): Promise<ProviderQuotaResult> {
  const headers = { authorization: `Bearer ${credential}` };
  const [usageBody, plan] = await Promise.all([
    getJson("https://ollama.com/api/usage", headers, fetcher),
    fetchPlan(fetcher, headers),
  ]);
  const payload = quotaRecord(usageBody);
  const limits = record(payload.limits) ?? {};
  const windows = [
    ratioWindow("session", "Session (5h)", record(limits.session)?.usage),
    ratioWindow("weekly", "Weekly (7d)", record(limits.weekly)?.usage),
  ].filter((window): window is NonNullable<typeof window> => window !== null);
  return { source: "ollama", plan, windows, error: null };
}
