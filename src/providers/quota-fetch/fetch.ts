import type { OAuthTokenRecord } from "../../proxy/routing/account.js";
import type { FetchLike, ProviderQuotaResult } from "./shared.js";
import { cleanError, unsupportedQuota } from "./shared.js";
import { fetchAntigravityQuota } from "./antigravity.js";
import { fetchClaudeQuota } from "./claude.js";
import { fetchClineQuota } from "./cline.js";
import { fetchCodexQuota } from "./codex.js";
import { fetchOllamaQuota } from "./ollama.js";
import { fetchZaiQuota } from "./zai.js";
import { fetchKimiQuota } from "./kimi.js";
import { fetchGithubCopilotQuota } from "./github-copilot.js";
import { fetchCursorQuota } from "./cursor.js";
import { fetchDevinQuota } from "./devin.js";

export const QUOTA_FETCHERS: Record<string, (credential: string, token: OAuthTokenRecord | undefined, fetcher: FetchLike) => Promise<ProviderQuotaResult>> = {
  antigravity: (credential, token, fetcher) => fetchAntigravityQuota(credential, token, fetcher),
  claude: (credential, token, fetcher) => fetchClaudeQuota(credential, token, fetcher),
  cline: (credential, token, fetcher) => fetchClineQuota(token?.accessToken ?? credential, fetcher),
  "cline-pass": (credential, token, fetcher) => fetchClineQuota(token?.accessToken ?? credential, fetcher),
  codex: (credential, token, fetcher) => fetchCodexQuota(credential, token, fetcher, new Date().toISOString()),
  ollama: (credential, _token, fetcher) => fetchOllamaQuota(credential, fetcher),
  zaicp: async (credential, token, fetcher) => { const result = await fetchZaiQuota(credential, token, fetcher); return result.source === "zaicp" ? result : { ...result, source: "zaicp" }; },
  zai: (credential, token, fetcher) => fetchZaiQuota(credential, token, fetcher),
  "kimi-code": (credential, token, fetcher) => fetchKimiQuota(credential, token, fetcher),
  github: async (credential, token, fetcher) => { const result = await fetchGithubCopilotQuota(credential, token, fetcher); return result.source === "github" ? result : { ...result, source: "github" }; },
  cursor: (credential, token, fetcher) => fetchCursorQuota(credential, token, fetcher),
  devin: (credential, token, fetcher) => fetchDevinQuota(credential, token, fetcher),
};

/** Dispatches quota collection to the provider-specific quota module. */
export async function fetchProviderQuota(providerId: string, credential: string, token: OAuthTokenRecord | undefined, fetcher: FetchLike = fetch): Promise<ProviderQuotaResult> {
  try {
    const handler = QUOTA_FETCHERS[providerId];
    if (handler === undefined) return unsupportedQuota(providerId);
    return await handler(credential, token, fetcher);
  } catch (error) {
    return { source: providerId, plan: null, windows: [], error: cleanError(error) };
  }
}

export type { FetchLike, OAuthQuotaToken, ProviderQuotaResult, ProviderQuotaWindow } from "./shared.js";
export { unsupportedQuota, cleanError, record, text, number, isoDate, quotaRecord, percentWindow, authCredential, codexJwtAccountId, getJson } from "./shared.js";
