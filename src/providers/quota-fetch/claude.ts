import type { FetchLike, OAuthQuotaToken, ProviderQuotaResult, ProviderQuotaWindow } from "./shared.js";
import { authCredential, getJson, percentWindow, record, text, number, isoDate } from "./shared.js";


import { claudeCodeOAuthBetas } from "../oauth-provider/claude-code.js";

const CLAUDE_CACHE_TTL_MS = 5 * 60_000;
const CLAUDE_COOLDOWN_MS = 3 * 60_000;
let cached: { at: number; result: ProviderQuotaResult } | null = null;
let cooldownUntil = 0;

function parseClaudeQuota(body: unknown): ProviderQuotaResult {
  const payload = record(body) ?? {};
  const windows: ProviderQuotaWindow[] = [];
  const add = (key: string, label: string, kind: string): void => {
    const value = record(payload[key]);
    if (value) windows.push(percentWindow(kind, label, number(value.utilization), isoDate(value.resets_at)));
  };
  add("five_hour", "5 Hour", "session");
  add("seven_day", "7 Day", "weekly");
  return { source: "claude", plan: text(payload.plan_type) ?? text(payload.plan), windows, error: null };
}

export async function fetchClaudeQuota(credential: string, token: OAuthQuotaToken, fetcher: FetchLike): Promise<ProviderQuotaResult> {
  const now = Date.now();
  if (cooldownUntil > now) return { source: "claude", plan: null, windows: [], error: `Quota temporarily unavailable — retry after ${Math.ceil((cooldownUntil - now)/1000)}s` };
  if (cached !== null && now - cached.at < CLAUDE_CACHE_TTL_MS) return cached.result;
  const fields = authCredential(credential);
  const access = text(token?.accessToken) ?? text(fields.accessToken) ?? credential;
  try {
    const body = await getJson("https://api.anthropic.com/api/oauth/usage", {
      authorization: `Bearer ${access}`,
      "anthropic-beta": claudeCodeOAuthBetas.join(","),
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": "cli",
      "x-client-request-id": crypto.randomUUID(),
      "accept-encoding": "gzip, deflate, br",
      connection: "keep-alive",
    }, fetcher);
    const result = parseClaudeQuota(body);
    cached = { at: now, result };
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/429|rate/i.test(msg)) cooldownUntil = now + CLAUDE_COOLDOWN_MS;
    throw error;
  }
}
