import type { AuthDriver, AuthDriverCapabilities, OAuthExchangeInput, OAuthStartInput, OAuthStartResult, RefreshTokenInput, TokenSet } from "../contract.js";
import { createPkce, OAuthDriverError, OAuthHttpClient, tokenFields } from "../http-client.js";
import type { OAuthDriverOptions } from "../http-client.js";

export const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
export const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
export const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

const CURSOR_OAUTH_TTL_MS = 10 * 60_000;

interface CursorPollSession {
  readonly uuid: string;
  readonly verifier: string;
  readonly challenge: string;
  readonly expiresAtMs: number;
  pollDelayMs: number;
  nextPollAtMs: number;
}

export class CursorOAuthDriver implements AuthDriver {
  readonly kind = "oauth" as const;
  readonly capabilities: AuthDriverCapabilities = {
    supportsStart: true,
    supportsPoll: true,
    supportsExchange: true,
    supportsRefresh: true,
    supportsRevoke: false,
    accessOnly: false,
    supportsBrowser: false,
    supportsDevice: true,
  };

  private readonly http: OAuthHttpClient;
  private readonly nowMs: () => number;
  private readonly sessions = new Map<string, CursorPollSession>();

  constructor(options: OAuthDriverOptions = {}) {
    this.http = new OAuthHttpClient(options);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async start(input: OAuthStartInput): Promise<OAuthStartResult> {
    const state = input.state && input.state.length > 0 ? input.state : crypto.randomUUID();
    const { verifier, challenge } = await createPkce();
    const uuid = crypto.randomUUID();
    const params = new URLSearchParams({
      challenge,
      uuid,
      mode: "login",
      redirectTarget: "cli",
    });
    const authorizationUrl = `${CURSOR_LOGIN_URL}?${params.toString()}`;
    const expiresAtMs = this.nowMs() + CURSOR_OAUTH_TTL_MS;
    this.sessions.set(state, { uuid, verifier, challenge, expiresAtMs, pollDelayMs: 1000, nextPollAtMs: this.nowMs() + 1000 });
    return { authorizationUrl, verificationUri: CURSOR_LOGIN_URL, state, expiresAtMs, flow: "device" };
  }

  async poll(state: string): Promise<{ readonly status: "pending" | "completed" | "expired"; readonly intervalSeconds?: number; readonly tokenSet?: TokenSet }> {
    const session = this.sessions.get(state);
    if (!session) return { status: "expired" };
    if (session.expiresAtMs <= this.nowMs()) {
      this.sessions.delete(state);
      return { status: "expired" };
    }
    const now = this.nowMs();
    if (session.nextPollAtMs > now) return { status: "pending", intervalSeconds: Math.ceil((session.nextPollAtMs - now) / 1000) };
    let data: Record<string, unknown>;
    try {
      const url = new URL(CURSOR_POLL_URL);
      url.searchParams.set("uuid", session.uuid);
      url.searchParams.set("verifier", session.verifier);
      data = await this.http.getJson(url.toString(), "cursor", "poll");
    } catch (error) {
      if (error instanceof OAuthDriverError && error.status === 404) {
        session.pollDelayMs = Math.min(session.pollDelayMs * 1.2, 10_000);
        session.nextPollAtMs = this.nowMs() + session.pollDelayMs;
        return { status: "pending", intervalSeconds: Math.ceil(session.pollDelayMs / 1000) };
      }
      throw error;
    }
    const access = typeof data.accessToken === "string" ? data.accessToken : typeof data.access_token === "string" ? data.access_token : undefined;
    const refresh = typeof data.refreshToken === "string" ? data.refreshToken : typeof data.refresh_token === "string" ? data.refresh_token : undefined;
    if (!access) return { status: "pending", intervalSeconds: 2 };
    const expiresAtMs = typeof data.expiresIn === "number" ? this.nowMs() + data.expiresIn * 1000 - 5 * 60_000 : this.nowMs() + 3_600_000;
    this.sessions.delete(state);
    return {
      status: "completed",
      tokenSet: {
        accessToken: access,
        refreshToken: refresh,
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    };
  }

  async exchange(input: OAuthExchangeInput): Promise<TokenSet> {
    const polled = await this.poll(input.state ?? input.code);
    if (polled.status === "completed" && polled.tokenSet) return polled.tokenSet;
    // Fallback: treat code as apiKey exchange via Authorization header
    const data = await this.http.postJson(CURSOR_REFRESH_URL, {}, "cursor", "token exchange", { authorization: `Bearer ${input.code}` });
    const access = typeof (data as Record<string, unknown>).accessToken === "string" ? (data as Record<string, unknown>).accessToken as string : typeof (data as Record<string, unknown>).access_token === "string" ? (data as Record<string, unknown>).access_token as string : undefined;
    const refresh = typeof (data as Record<string, unknown>).refreshToken === "string" ? (data as Record<string, unknown>).refreshToken as string : typeof (data as Record<string, unknown>).refresh_token === "string" ? (data as Record<string, unknown>).refresh_token as string : input.code;
    if (!access) throw new OAuthDriverError("validation", "cursor token exchange missing access token", 502, false);
    const expiresAtMs = this.getExpiry(access);
    return { accessToken: access, refreshToken: refresh, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  async refresh(input: RefreshTokenInput): Promise<TokenSet> {
    const data = await this.http.postJson(CURSOR_REFRESH_URL, {}, "cursor", "token refresh", { authorization: `Bearer ${input.refreshToken}` });
    const access = typeof (data as Record<string, unknown>).accessToken === "string" ? (data as Record<string, unknown>).accessToken as string : typeof (data as Record<string, unknown>).access_token === "string" ? (data as Record<string, unknown>).access_token as string : undefined;
    const refresh = typeof (data as Record<string, unknown>).refreshToken === "string" ? (data as Record<string, unknown>).refreshToken as string : typeof (data as Record<string, unknown>).refresh_token === "string" ? (data as Record<string, unknown>).refresh_token as string : input.refreshToken;
    if (!access) throw new OAuthDriverError("validation", "cursor token refresh missing access token", 502, false);
    const expiresAtMs = this.getExpiry(access);
    return { accessToken: access, refreshToken: refresh, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  private getExpiry(token: string): number {
    try {
      const parts = token.split(".");
      if (parts.length === 3 && parts[1]) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown };
        if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) return payload.exp * 1000 - 5 * 60 * 1000;
      }
    } catch {}
    return this.nowMs() + 3_600_000;
  }
}
