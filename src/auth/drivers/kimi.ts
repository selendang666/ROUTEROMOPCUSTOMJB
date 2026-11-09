// Kimi OAuth driver — device-code flow via auth.kimi.com

import type { AuthDriver, AuthDriverCapabilities, OAuthExchangeInput, OAuthStartInput, OAuthStartResult, RefreshTokenInput, TokenSet } from "../contract.js";
import { OAuthDriverError, OAuthHttpClient, tokenFields } from "../http-client.js";
import type { OAuthDriverOptions } from "../http-client.js";
import os from "node:os";
import packageJson from "../../../package.json" with { type: "json" };

export const KIMI_DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
export const KIMI_DEVICE_AUTHORIZATION_PATH = "/api/oauth/device_authorization";
export const KIMI_TOKEN_PATH = "/api/oauth/token";
// Placeholder client_id — real value is injected via env override or kept as default for test harness.
export const KIMI_CLIENT_ID = (typeof Bun !== "undefined" ? (Bun.env.KIMI_OAUTH_CLIENT_ID?.trim() ?? "") : "") || "17e5f671-d194-4dfb-9706-5516cb48c098";
export const KIMI_OAUTH_TTL_MS = 15 * 60_000;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function oauthHost(): string {
  const envHost = typeof Bun !== "undefined" ? Bun.env.KIMI_OAUTH_HOST?.trim() : undefined;
  if (envHost && envHost.length > 0) return envHost.replace(/\/+$/, "");
  return KIMI_DEFAULT_OAUTH_HOST;
}

function kimiHeaders(deviceId: string): Record<string, string> {
  return {
    "User-Agent": `KimiCLI/${packageJson.version}`,
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": packageJson.version,
    "X-Msh-Device-Name": os.hostname().replace(/[^\x20-\x7E]/g, "").trim() || "unknown",
    "X-Msh-Device-Model": os.arch(),
    "X-Msh-Os-Version": os.version().replace(/[^\x20-\x7E]/g, "").trim() || "unknown",
    "X-Msh-Device-Id": deviceId,
  };
}

interface KimiDeviceSession {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAtMs: number;
  readonly intervalSeconds: number;
}

/**
 * Kimi device-code OAuth driver.
 * Start → POST /api/oauth/device_authorization {client_id, scope:""}
 * Poll  → POST /api/oauth/token grant_type device_code
 */
export class KimiOAuthDriver implements AuthDriver {
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
  private readonly deviceSessions = new Map<string, KimiDeviceSession>();

  constructor(options: OAuthDriverOptions = {}) {
    this.http = new OAuthHttpClient(options);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async start(input: OAuthStartInput): Promise<OAuthStartResult> {
    const host = oauthHost();
    const state = input.state && input.state.length > 0 ? input.state : crypto.randomUUID();
    const deviceId = this.deviceId();
    const data = await this.http.postForm(
      `${host}${KIMI_DEVICE_AUTHORIZATION_PATH}`,
      { client_id: KIMI_CLIENT_ID },
      "kimi-code",
      "device authorization",
      kimiHeaders(deviceId),
    );
    const deviceCode = nonEmpty(data.device_code) ?? nonEmpty(data.deviceCode);
    const userCode = nonEmpty(data.user_code) ?? nonEmpty(data.userCode) ?? nonEmpty(data.user_code_display);
    const verificationUri = nonEmpty(data.verification_uri) ?? nonEmpty(data.verificationUri) ?? nonEmpty(data.verification_url) ?? `${host}/device`;
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : typeof data.expiresIn === "number" ? data.expiresIn : 900;
    const interval = typeof data.interval === "number" ? data.interval : 5;
    if (!deviceCode || !userCode) {
      throw new OAuthDriverError("validation", "kimi device authorization response is missing device credentials.", 502, true);
    }
    const expiresAtMs = this.nowMs() + expiresIn * 1000;
    this.deviceSessions.set(state, {
      deviceCode,
      userCode,
      verificationUri: verificationUri ?? `${host}/device`,
      expiresAtMs,
      intervalSeconds: Math.max(1, Math.floor(interval)),
    });
    return {
      authorizationUrl: verificationUri ?? `${host}/device`,
      verificationUri: verificationUri ?? `${host}/device`,
      userCode,
      intervalSeconds: Math.max(1, Math.floor(interval)),
      state,
      expiresAtMs,
      flow: "device",
    };
  }

  async poll(state: string): Promise<{ readonly status: "pending" | "completed" | "expired"; readonly intervalSeconds?: number; readonly tokenSet?: TokenSet }> {
    const session = this.deviceSessions.get(state);
    if (!session) return { status: "expired" };
    if (session.expiresAtMs <= this.nowMs()) {
      this.deviceSessions.delete(state);
      return { status: "expired" };
    }
    const host = oauthHost();
    const result = await this.http.postFormResult(
      `${host}${KIMI_TOKEN_PATH}`,
      { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: KIMI_CLIENT_ID, device_code: session.deviceCode },
      "kimi-code",
      "device poll",
      kimiHeaders(this.deviceId()),
    );
    if (!result.ok || result.body === null) {
      const err = (result.body as Record<string, unknown> | null)?.error as string | undefined;
      if (result.status === 428 || err === "authorization_pending" || err === "slow_down") {
        const retryInterval = err === "slow_down" ? session.intervalSeconds + 5 : session.intervalSeconds;
        return { status: "pending", intervalSeconds: retryInterval };
      }
      if (result.status === 404 || result.status === 403) return { status: "pending", intervalSeconds: session.intervalSeconds };
      throw new OAuthDriverError("device-auth", `kimi device poll failed with HTTP ${result.status}.`, result.status, result.status >= 500 || result.status === 429, result.retryAt);
    }
    const fields = tokenFields(result.body, "kimi-code", "device poll", this.nowMs(), false);
    this.deviceSessions.delete(state);
    return {
      status: "completed",
      tokenSet: {
        accessToken: fields.access,
        refreshToken: fields.refresh ?? undefined,
        expiresAt: new Date(fields.expiresAtMs).toISOString(),
      },
    };
  }

  async exchange(input: OAuthExchangeInput): Promise<TokenSet> {
    // For kimi, exchange can be used as poll via code = state or direct device_code.
    // If input.code is a stored state, delegate to poll; otherwise treat as device_code exchange.
    const polled = await this.poll(input.state ?? input.code);
    if (polled.status === "completed" && polled.tokenSet) return polled.tokenSet;
    // Fallback: direct token exchange with code as device_code
    const host = oauthHost();
    const data = await this.http.postForm(
      `${host}${KIMI_TOKEN_PATH}`,
      { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: KIMI_CLIENT_ID, device_code: input.code },
      "kimi-code",
      "token exchange",
      kimiHeaders(this.deviceId()),
    );
    const fields = tokenFields(data, "kimi-code", "token exchange", this.nowMs(), false);
    return {
      accessToken: fields.access,
      refreshToken: fields.refresh ?? undefined,
      expiresAt: new Date(fields.expiresAtMs).toISOString(),
    };
  }

  async refresh(input: RefreshTokenInput): Promise<TokenSet> {
    const host = oauthHost();
    const data = await this.http.postForm(
      `${host}${KIMI_TOKEN_PATH}`,
      { grant_type: "refresh_token", client_id: KIMI_CLIENT_ID, refresh_token: input.refreshToken },
      "kimi-code",
      "token refresh",
      kimiHeaders(this.deviceId()),
    );
    const fields = tokenFields(data, "kimi-code", "token refresh", this.nowMs(), false);
    return {
      accessToken: fields.access,
      refreshToken: fields.refresh ?? input.refreshToken,
      expiresAt: new Date(fields.expiresAtMs).toISOString(),
    };
  }

  private deviceId(): string {
    // Persisted device-id pattern mirroring codex driver; for test harness use stable placeholder.
    // Real impl would read ~/.ohmyomop-router/kimi-device-id — avoid FS in driver, generate per-instance.
    const key = "__kimi_device_id";
    const globalStore = globalThis as unknown as Record<string, string | undefined>;
    if (globalStore[key]) return globalStore[key]!;
    const id = crypto.randomUUID();
    globalStore[key] = id;
    return id;
  }
}
