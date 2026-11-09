// ZAI OAuth driver — Z.AI / Zhipu Coding Plan browser authorization-code flow.
// No PKCE, callback 54548, never-expires token.

import type { AuthDriver, AuthDriverCapabilities, OAuthExchangeInput, OAuthStartInput, OAuthStartResult, RefreshTokenInput, TokenSet } from "../contract.js";
import { OAuthDriverError, OAuthHttpClient } from "../http-client.js";
import type { OAuthDriverOptions } from "../http-client.js";

export const ZAI_AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize";
export const ZAI_TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token";
export const ZAI_BIZ_LOGIN = "https://api.z.ai/api/auth/z/login";
export const ZAI_CALLBACK_PORT = 54548;
export const ZAI_CALLBACK_PATH = "/callback";
export const ZAI_CALLBACK_URL = `http://localhost:${ZAI_CALLBACK_PORT}${ZAI_CALLBACK_PATH}`;
// Never-expires sentinel (100 years in ms) — ZAI tokens do not expire.
export const ZAI_NEVER_EXPIRES_MS = 8.64e15;
export const ZAI_OAUTH_TTL_MS = 300_000;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * ZAI browser OAuth driver.
 * No PKCE — explicit comment matches ZCode reference implementation.
 * Refresh is intentionally unsupported (NEVER_EXPIRES); upstream has no token endpoint for refresh.
 */
export class ZaiOAuthDriver implements AuthDriver {
  readonly kind = "oauth" as const;
  readonly capabilities: AuthDriverCapabilities = {
    supportsStart: true,
    supportsPoll: false,
    supportsExchange: true,
    supportsRefresh: false,
    supportsRevoke: false,
    accessOnly: true,
    supportsBrowser: true,
    supportsDevice: false,
  };

  private readonly http: OAuthHttpClient;
  private readonly nowMs: () => number;

  constructor(options: OAuthDriverOptions = {}) {
    this.http = new OAuthHttpClient(options);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async start(input: OAuthStartInput): Promise<OAuthStartResult> {
    const state = input.state && input.state.length > 0 ? input.state : crypto.randomUUID();
    const redirectUri = input.redirectUri ?? ZAI_CALLBACK_URL;
    const url = new URL(ZAI_AUTHORIZE_URL);
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", redirectUri);
    if (input.scopes && input.scopes.length > 0) url.searchParams.set("scope", input.scopes.join(" "));
    return {
      authorizationUrl: url.toString(),
      state,
      expiresAtMs: this.nowMs() + ZAI_OAUTH_TTL_MS,
      flow: "browser",
    };
  }

  async exchange(input: OAuthExchangeInput): Promise<TokenSet> {
    // input.code is the authorization code from callback URL.
    const code = input.code.trim();
    if (!code) throw new OAuthDriverError("validation", "zai OAuth exchange is missing code.", 400, false);
    const redirectUri = input.redirectUri ?? ZAI_CALLBACK_URL;
    // Primary token exchange
    const data = await this.http.postJson(
      ZAI_TOKEN_URL,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      },
      "zai-coding-plan",
      "token exchange",
    );
    // ZAI returns access_token without expires_in; treat as never-expires.
    const access = nonEmpty(data.access_token) ?? nonEmpty(data.accessToken);
    if (!access) throw new OAuthDriverError("validation", "zai OAuth token exchange response is missing access token.", 502, false);
    const expiresAtMs = typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
      ? this.nowMs() + data.expires_in * 1000
      : this.nowMs() + ZAI_NEVER_EXPIRES_MS;
    // Best-effort biz login enrichment (optional, not required for token issuance)
    let email: string | undefined;
    let providerAccountId: string | undefined;
    try {
      const biz = await this.http.tryGet(
        ZAI_BIZ_LOGIN,
        { authorization: `Bearer ${access}`, accept: "application/json" },
        "zai-coding-plan",
        "biz login",
      );
      if (biz.ok) {
        const parsed: unknown = JSON.parse(biz.text);
        if (typeof parsed === "object" && parsed !== null) {
          const rec = parsed as Record<string, unknown>;
          email = nonEmpty(rec.email) ?? nonEmpty((rec.user as Record<string, unknown> | undefined)?.email);
          providerAccountId = nonEmpty(rec.id) ?? nonEmpty(rec.user_id) ?? nonEmpty((rec.user as Record<string, unknown> | undefined)?.id);
        }
      }
    } catch {
      // best-effort, ignore
    }
    return {
      accessToken: access,
      refreshToken: nonEmpty(data.refresh_token) ?? nonEmpty(data.refreshToken),
      expiresAt: new Date(expiresAtMs).toISOString(),
      providerAccountId,
      email,
    };
  }

  async refresh(_input: RefreshTokenInput): Promise<TokenSet> {
    throw new OAuthDriverError("unsupported_feature", "zai-coding-plan does not support token refresh (NEVER_EXPIRES).", 501, false);
  }
}


