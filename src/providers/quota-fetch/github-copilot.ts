import type { FetchLike, ProviderQuotaResult } from "./shared.js";
import { getJson, percentWindow, record, text, number, isoDate } from "./shared.js";



function parseGithubQuota(body: unknown): ProviderQuotaResult {
  const root = record(body) ?? {};
  const data = record(root.data) ?? root;
  const snapshots = record(data.quota_snapshots) ?? {};
  const reset = isoDate(data.quota_reset_date);
  const snapshotTypes: readonly [string, string][] = [
    ["premium_interactions", "Premium Requests"],
    ["chat", "Chat Requests"],
    ["completions", "Completions"],
  ];
  const snapshotWindows = snapshotTypes.flatMap(([key, label]) => {
    const quota = record(snapshots[key]);
    if (!quota) return [];
    if (quota.unlimited === true) return [percentWindow(String(key), String(label), null, reset)];
    const remaining = number(quota.remaining);
    const percentRemaining = number(quota.percent_remaining);
    const entitlement = number(quota.entitlement);
    const usedPercent = percentRemaining !== null
      ? 100 - percentRemaining
      : remaining !== null && entitlement !== null && entitlement > 0
        ? ((entitlement - remaining) / entitlement) * 100
        : null;
    if (usedPercent === null) return [];
    return [percentWindow(String(key), String(label), usedPercent, reset, entitlement === null || remaining === null ? null : entitlement - remaining, entitlement)];
  });
  if (snapshotWindows.length > 0) return { source: "github-copilot", plan: text(data.copilot_plan) ?? "GitHub Copilot", windows: snapshotWindows, error: null };
  const remaining = number(data.quota_remaining) ?? number(data.remaining) ?? number(data.remainingFraction);
  const percent = number(data.quota_percent) ?? number(data.percentUsed) ?? number(data.quotaPercent);
  let usedPercent: number | null = percent;
  if (usedPercent === null && remaining !== null) usedPercent = remaining <= 1 ? (1 - remaining) * 100 : remaining <= 100 ? 100 - remaining : null;
  const used = number(data.used) ?? number(data.quota_used);
  const limit = number(data.limit) ?? number(data.quota_limit);
  if (usedPercent === null && used !== null && limit !== null && limit > 0) usedPercent = (used / limit) * 100;
  if (usedPercent === null) return { source: "github-copilot", plan: text(data.copilot_plan) ?? text(data.plan) ?? "GitHub Copilot", windows: [], error: null };
  return {
    source: "github-copilot",
    plan: text(data.plan) ?? text(data.tier) ?? "GitHub Copilot",
    windows: [percentWindow("quota", "Quota", usedPercent, null, used, limit)],
    error: null,
  };
}

function githubApiBase(credential: string): string {
  // Allow credential JSON to carry enterprise domain hint? Check for domain field.
  try {
    if (credential.trim().startsWith("{")) {
      const parsed = JSON.parse(credential) as Record<string, unknown>;
      const domain = typeof parsed.domain === "string" ? parsed.domain.trim() : "";
      if (domain) return domain.replace(/\/+$/, "");
    }
  } catch {
    // ignore
  }
  const env = typeof Bun !== "undefined" ? Bun.env.GITHUB_API_BASE?.trim() : undefined;
  if (env && env.length > 0) return env.replace(/\/+$/, "");
  return "https://api.github.com";
}

export async function fetchGithubCopilotQuota(credential: string, _token: unknown, fetcher: FetchLike): Promise<ProviderQuotaResult> {
  const raw = credential.trim();
  if (!raw) throw new Error("GitHub Copilot credential is empty.");
  // Extract bare token if credential is JSON bundle
  let token = raw;
  try {
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.accessToken === "string" && parsed.accessToken) token = parsed.accessToken;
    }
  } catch {
    // raw is token
  }
  const base = githubApiBase(raw);
  const headers = { authorization: `Bearer ${token}` };
  // Enterprise uses /api/v3/copilot_internal/user else /copilot_internal/user
  const isEnterprise = base !== "https://api.github.com";
  const url = isEnterprise ? `${base}/api/v3/copilot_internal/user` : `${base}/copilot_internal/user`;
  try {
    const body = await getJson(url, headers, fetcher);
    return parseGithubQuota(body);
  } catch {
    // fallback to alternate path
    const alt = isEnterprise ? `${base}/copilot_internal/user` : `${base}/api/v3/copilot_internal/user`;
    const body = await getJson(alt, headers, fetcher);
    return parseGithubQuota(body);
  }
}
