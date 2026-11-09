// Cline OAuth driver — browser authorization-code flow.
// API-key transport remains implemented by providers/api-key/cline.ts.

import type { AuthDriver, AuthDriverCapabilities, OAuthExchangeInput, OAuthStartInput, OAuthStartResult, RefreshTokenInput, TokenSet } from "../contract.js";
import { OAuthDriverError, OAuthHttpClient } from "../http-client.js";
import type { OAuthDriverOptions } from "../http-client.js";
import { pollClineWorkOsDevice, requestClineWorkOsDevice, type ClineWorkOsDeviceSession } from "./cline-workos.js";

export const CLINE_API_BASE_URL = "https://api.cline.bot";
export const CLINE_AUTHORIZE_URL = `${CLINE_API_BASE_URL}/api/v1/auth/authorize`;
export const CLINE_TOKEN_URL = `${CLINE_API_BASE_URL}/api/v1/auth/token`;
export const CLINE_REFRESH_URL = `${CLINE_API_BASE_URL}/api/v1/auth/refresh`;
export const CLINE_CALLBACK_URL = "http://localhost:1456/callback";
export const CLINE_OAUTH_TTL_MS = 300_000;

function parseCode(code: string): Record<string, unknown> | null {
  try {
    const normalized = code.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const end = decoded.lastIndexOf("}");
    if (end < 0) return null;
    const parsed: unknown = JSON.parse(decoded.slice(0, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function tokenSet(data: Record<string, unknown>, nowMs: number, fallbackRefreshToken?: string): TokenSet {
  const access = typeof data.access_token === "string" ? data.access_token : typeof data.accessToken === "string" ? data.accessToken : undefined;
  const refresh = typeof data.refresh_token === "string" ? data.refresh_token : typeof data.refreshToken === "string" ? data.refreshToken : fallbackRefreshToken;
  if (access === undefined || access.length === 0) throw new OAuthDriverError("validation", "Cline OAuth response is missing an access token.", 502, false);
  const expiresAt = typeof data.expires_at === "string" ? data.expires_at : typeof data.expiresAt === "string" ? data.expiresAt : new Date(nowMs + 3_600_000).toISOString();
  const userInfo = typeof data.userInfo === "object" && data.userInfo !== null && !Array.isArray(data.userInfo) ? data.userInfo as Record<string, unknown> : data;
  return {
    accessToken: access,
    ...(refresh !== undefined && refresh.length > 0 ? { refreshToken: refresh } : {}),
    expiresAt,
    email: typeof data.email === "string" ? data.email : typeof userInfo.email === "string" ? userInfo.email : undefined,
    providerAccountId: typeof data.userId === "string" ? data.userId : typeof userInfo.clineUserId === "string" ? userInfo.clineUserId : undefined,
  };
}

/** Cline browser OAuth flow. */
export class ClineOAuthDriver implements AuthDriver {
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
  private readonly deviceSessions = new Map<string, ClineWorkOsDeviceSession>();

  constructor(options: OAuthDriverOptions = {}) {
    this.http = new OAuthHttpClient(options);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async start(input: OAuthStartInput): Promise<OAuthStartResult> {
    const state = input.state && input.state.length > 0 ? input.state : crypto.randomUUID();
    const device = await requestClineWorkOsDevice(this.http, "cline");
    const expiresAtMs = this.nowMs() + device.expiresInSeconds * 1000;
    this.deviceSessions.set(state, { ...device, expiresAtMs });
    return {
      authorizationUrl: device.verificationUriComplete ?? device.verificationUri,
      state,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      intervalSeconds: device.intervalSeconds,
      expiresAtMs,
      flow: "device",
    };
  }

  async poll(state: string): Promise<{ readonly status: "pending" | "completed" | "expired"; readonly intervalSeconds?: number; readonly tokenSet?: TokenSet }> {
    const session = this.deviceSessions.get(state);
    if (session === undefined) return { status: "expired" };
    const result = await pollClineWorkOsDevice(this.http, session, "cline", this.nowMs);
    if (result.status !== "pending") this.deviceSessions.delete(state);
    return result;
  }

  async exchange(input: OAuthExchangeInput): Promise<TokenSet> {
    const decoded = parseCode(input.code);
    if (decoded !== null) return tokenSet(decoded, this.nowMs());
    const response = await this.http.postJson(
      CLINE_TOKEN_URL,
      { grant_type: "authorization_code", code: input.code, client_type: "extension", redirect_uri: input.redirectUri ?? CLINE_CALLBACK_URL },
      "cline",
      "token exchange",
    );
    const body = typeof response.data === "object" && response.data !== null && !Array.isArray(response.data) ? response.data as Record<string, unknown> : response;
    return tokenSet(body, this.nowMs());
  }

  async refresh(input: RefreshTokenInput): Promise<TokenSet> {
    const response = await this.http.postJson(CLINE_REFRESH_URL, { refreshToken: input.refreshToken, grantType: "refresh_token" }, "cline", "token refresh");
    const body = typeof response.data === "object" && response.data !== null && !Array.isArray(response.data) ? response.data as Record<string, unknown> : response;
    return tokenSet(body, this.nowMs(), input.refreshToken);
  }
}
