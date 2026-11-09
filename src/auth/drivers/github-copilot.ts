// GitHub Copilot OAuth driver — device-code flow

import type { AuthDriver, AuthDriverCapabilities, OAuthExchangeInput, OAuthStartInput, OAuthStartResult, RefreshTokenInput, TokenSet } from "../contract.js";
import { OAuthDriverError, OAuthHttpClient } from "../http-client.js";
import type { OAuthDriverOptions } from "../http-client.js";

export const GITHUB_DEFAULT_API = "https://api.github.com";
export const GITHUB_DEFAULT_DOMAIN = "https://github.com";
// Public Copilot OAuth app client_id. Allow env override.
export const GITHUB_COPILOT_CLIENT_ID =
  (typeof Bun !== "undefined" ? (Bun.env.GITHUB_COPILOT_CLIENT_ID?.trim() ?? "") : "") || "Ov23li8tweQw6odWQebz";

export const GITHUB_DEVICE_CODE_PATH = "/login/device/code";
export const GITHUB_ACCESS_TOKEN_PATH = "/login/oauth/access_token";
export const GITHUB_COPILOT_FAR_FUTURE_MS = 8_000_000_000_000_000;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function domainFor(input?: string): { apiBase: string; githubBase: string } {
  const raw = input?.trim();
  if (raw && raw.length > 0) {
    // Enterprise domain handling: allow "github-copilot:enterprise.example.com" split handled by caller
    // Here raw is already domain part.
    const normalized = raw.replace(/\/+$/, "");
    if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
      const url = new URL(normalized);
      return { apiBase: `${url.protocol}//${url.host}`, githubBase: `${url.protocol}//${url.host}` };
    }
    // Bare host
    return { apiBase: `https://${normalized}`, githubBase: `https://${normalized}` };
  }
  const envApi = typeof Bun !== "undefined" ? Bun.env.GITHUB_API_BASE?.trim() : undefined;
  const envGh = typeof Bun !== "undefined" ? Bun.env.GITHUB_DOMAIN?.trim() : undefined;
  return {
    apiBase: envApi && envApi.length > 0 ? envApi.replace(/\/+$/, "") : GITHUB_DEFAULT_API,
    githubBase: envGh && envGh.length > 0 ? envGh.replace(/\/+$/, "") : GITHUB_DEFAULT_DOMAIN,
  };
}

function enterpriseDomainFromProviderId(providerId: string): string | undefined {
  const idx = providerId.indexOf(":");
  if (idx < 0) return undefined;
  return providerId.slice(idx + 1).trim() || undefined;
}

interface GithubDeviceSession {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalSeconds: number;
  readonly expiresAtMs: number;
  readonly githubBase: string;
  pollDelayMs: number;
  nextPollAtMs: number;
}

/**
 * GitHub Copilot device-code OAuth driver.
 * Device flow only; refresh returns far-future same token (Copilot tokens are long-lived).
 */
export class GithubCopilotOAuthDriver implements AuthDriver {
  readonly kind = "oauth" as const;
  readonly capabilities: AuthDriverCapabilities = {
    supportsStart: true,
    supportsPoll: true,
    supportsExchange: true,
    supportsRefresh: true,
    supportsRevoke: false,
    accessOnly: true,
    supportsBrowser: false,
    supportsDevice: true,
  };

  private readonly http: OAuthHttpClient;
  private readonly nowMs: () => number;
  private readonly deviceSessions = new Map<string, GithubDeviceSession>();

  constructor(options: OAuthDriverOptions = {}) {
    this.http = new OAuthHttpClient(options);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async start(input: OAuthStartInput): Promise<OAuthStartResult> {
    const enterprise = enterpriseDomainFromProviderId(input.providerId);
    const { githubBase } = domainFor(enterprise);
    const state = input.state && input.state.length > 0 ? input.state : crypto.randomUUID();
    const data = await this.http.postJson(
      `${githubBase}${GITHUB_DEVICE_CODE_PATH}`,
      { client_id: GITHUB_COPILOT_CLIENT_ID, scope: "read:user" },
      "github-copilot",
      "device authorization",
      { accept: "application/json", "user-agent": "opencode/1.3.15" },
    );

    const deviceCode = nonEmpty(data.device_code);
    const userCode = nonEmpty(data.user_code);
    const verificationUri = nonEmpty(data.verification_uri) ?? nonEmpty(data.verification_url) ?? `${githubBase}/login/device`;
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : typeof data.expires_in === "string" ? Number.parseInt(data.expires_in, 10) : 900;
    const interval = typeof data.interval === "number" ? data.interval : typeof data.interval === "string" ? Number.parseInt(data.interval, 10) : 5;
    if (!deviceCode || !userCode) {
      throw new OAuthDriverError("validation", "github-copilot device authorization response is missing device credentials.", 502, true);
    }
    const expiresAtMs = this.nowMs() + (Number.isFinite(expiresIn) ? expiresIn : 900) * 1000;
    this.deviceSessions.set(state, {
      deviceCode,
      userCode,
      verificationUri: verificationUri ?? `${githubBase}/login/device`,
      intervalSeconds: Math.max(1, Math.floor(Number.isFinite(interval) ? interval : 5)),
      expiresAtMs,
      githubBase,
      pollDelayMs: Math.max(1, Math.floor(Number.isFinite(interval) ? interval : 5)) * 1000,
      nextPollAtMs: this.nowMs(),
    });
    return {
      authorizationUrl: verificationUri ?? `${githubBase}/login/device`,
      verificationUri: verificationUri ?? `${githubBase}/login/device`,
      userCode,
      intervalSeconds: Math.max(1, Math.floor(Number.isFinite(interval) ? interval : 5)),
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
    const now = this.nowMs();
    if (session.nextPollAtMs > now) return { status: "pending", intervalSeconds: Math.ceil((session.nextPollAtMs - now) / 1000) };
    const result = await this.http.postJsonResult(
      `${session.githubBase}${GITHUB_ACCESS_TOKEN_PATH}`,
      {
        client_id: GITHUB_COPILOT_CLIENT_ID,
        device_code: session.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
      "github-copilot",
      "device poll",
      { accept: "application/json", "user-agent": "opencode/1.3.15" },
    );
    const err = (result.body as Record<string, unknown> | null)?.error as string | undefined;
    if (err === "authorization_pending" || err === "slow_down" || result.status === 428) {
      if (err === "slow_down") session.pollDelayMs = Math.min(session.pollDelayMs + 5_000, 10_000);
      session.nextPollAtMs = this.nowMs() + session.pollDelayMs;
      return { status: "pending", intervalSeconds: Math.ceil(session.pollDelayMs / 1000) };
    }
    if (!result.ok || result.body === null) {
      if (result.status === 404 || result.status === 403) return { status: "pending", intervalSeconds: session.intervalSeconds };
      throw new OAuthDriverError("device-auth", `github-copilot device poll failed with HTTP ${result.status}.`, result.status, result.status >= 500 || result.status === 429, result.retryAt);
    }
    const access = nonEmpty(result.body.access_token);
    if (!access) return { status: "pending", intervalSeconds: session.intervalSeconds };
    // GitHub returns access_token without refresh_token / expires_in; treat as far-future.
    this.deviceSessions.delete(state);
    return {
      status: "completed",
      tokenSet: {
        accessToken: access,
        expiresAt: new Date(this.nowMs() + GITHUB_COPILOT_FAR_FUTURE_MS).toISOString(),
      },
    };
  }

  async exchange(input: OAuthExchangeInput): Promise<TokenSet> {
    const polled = await this.poll(input.state ?? input.code);
    if (polled.status === "completed" && polled.tokenSet) return polled.tokenSet;
    // Direct exchange fallback: input.code as device_code with stored githubBase or default
    const { githubBase } = domainFor(undefined);
    const data = await this.http.postJson(
      `${githubBase}${GITHUB_ACCESS_TOKEN_PATH}`,
      { client_id: GITHUB_COPILOT_CLIENT_ID, device_code: input.code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
      "github-copilot",
      "token exchange",
      { accept: "application/json", "user-agent": "opencode/1.3.15" },
    );
    const access = nonEmpty(data.access_token);
    if (!access) throw new OAuthDriverError("validation", "github-copilot token exchange missing access token.", 502, false);
    return {
      accessToken: access,
      expiresAt: new Date(this.nowMs() + GITHUB_COPILOT_FAR_FUTURE_MS).toISOString(),
    };
  }

  async refresh(input: RefreshTokenInput): Promise<TokenSet> {
    // Copilot tokens are long-lived / far-future; refresh returns same token with far-future expiry.
    // If a real refresh_token is present, treat it as access.
    const token = input.refreshToken.trim();
    if (!token) throw new OAuthDriverError("validation", "github-copilot refresh is missing token.", 400, false);
    return {
      accessToken: token,
      expiresAt: new Date(this.nowMs() + GITHUB_COPILOT_FAR_FUTURE_MS).toISOString(),
    };
  }
}
