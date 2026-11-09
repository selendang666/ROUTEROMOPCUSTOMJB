import type { AuthDriver, AuthDriverCapabilities, OAuthExchangeInput, OAuthStartInput, OAuthStartResult, RefreshTokenInput, TokenSet } from "../contract.js";
import { createPkce, OAuthDriverError, OAuthHttpClient } from "../http-client.js";
import type { OAuthDriverOptions } from "../http-client.js";

export const DEVIN_WEBAPP_URL = "https://app.devin.ai";
export const DEVIN_AUTHORIZE_URL = `${DEVIN_WEBAPP_URL}/auth/cli/continue`;
export const DEVIN_TOKEN_URL = "https://api.devin.ai/auth/cli/token";
export const DEVIN_CALLBACK_PORT = 59653;
export const DEVIN_CALLBACK_PATH = "/callback";
export const DEVIN_CALLBACK_URL = `http://127.0.0.1:${DEVIN_CALLBACK_PORT}${DEVIN_CALLBACK_PATH}`;
const DEVIN_OAUTH_TTL_MS = 10 * 60_000;
const DEVIN_FALLBACK_EXPIRES_MS = 365 * 24 * 60 * 60 * 1000;

export class DevinOAuthDriver implements AuthDriver {
  readonly kind = "oauth" as const;
  readonly capabilities: AuthDriverCapabilities = {
    supportsStart: true,
    supportsPoll: false,
    supportsExchange: true,
    supportsRefresh: true,
    supportsRevoke: false,
    accessOnly: false,
    supportsBrowser: true,
    supportsDevice: false,
  };

  private readonly http: OAuthHttpClient;
  private readonly nowMs: () => number;
  private readonly verifierByState = new Map<string, string>();

  constructor(options: OAuthDriverOptions = {}) {
    this.http = new OAuthHttpClient(options);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async start(input: OAuthStartInput): Promise<OAuthStartResult> {
    const state = input.state && input.state.length > 0 ? input.state : crypto.randomUUID();
    const redirectUri = DEVIN_CALLBACK_URL;
    const pkce = await createPkce();
    this.verifierByState.set(state, pkce.verifier);
    const params = new URLSearchParams({
      redirect_uri: redirectUri,
      state,
      prompt: "select_account",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    });
    return {
      authorizationUrl: `${DEVIN_AUTHORIZE_URL}?${params.toString()}`,
      state,
      expiresAtMs: this.nowMs() + DEVIN_OAUTH_TTL_MS,
      flow: "browser",
    };
  }

  async exchange(input: OAuthExchangeInput): Promise<TokenSet> {
    // Prioritize stored verifier (generated in start) to match our challenge; fallback to session-provided verifier
    const stored = input.state ? this.verifierByState.get(input.state) : undefined;
    const verifier = stored ?? input.codeVerifier ?? "";
    if (!verifier) throw new OAuthDriverError("validation", "devin PKCE verifier missing for exchange", 400, false);
    const data = await this.http.postJson(DEVIN_TOKEN_URL, { code: input.code, code_verifier: verifier }, "devin", "token exchange");
    const token = typeof data.token === "string" ? data.token : typeof data.access_token === "string" ? data.access_token : typeof data.accessToken === "string" ? data.accessToken : undefined;
    if (!token) throw new OAuthDriverError("validation", "devin token exchange missing token", 502, false);
    if (input.state) this.verifierByState.delete(input.state);
    const expiresAtMs = this.getTokenExpiry(token);
    return {
      accessToken: token,
      refreshToken: token,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async refresh(input: RefreshTokenInput): Promise<TokenSet> {
    // Devin tokens are long-lived; re-use expiry from JWT or fallback 365d
    const token = input.refreshToken;
    const expiresAtMs = this.getTokenExpiry(token);
    return { accessToken: token, refreshToken: token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  private getTokenExpiry(token: string): number {
    try {
      const parts = token.split(".");
      if (parts.length === 3 && parts[1]) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown };
        if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) return payload.exp * 1000 - 5 * 60 * 1000;
      }
    } catch {}
    return this.nowMs() + DEVIN_FALLBACK_EXPIRES_MS;
  }
}
