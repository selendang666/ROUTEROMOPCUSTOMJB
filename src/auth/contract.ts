// Auth contract — single source of truth for the OAuth driver interface.
// Canonical OAuth contracts.

/** Provider-neutral token material returned by OAuth exchange and refresh drivers. */
export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly scope?: string;
  readonly providerAccountId?: string;
  /** Account email surfaced by providers that inline it (Anthropic, Google). */
  readonly email?: string;
  /** Subscription workspace the token draws limits from; captured at login only. */
  readonly orgId?: string;
  readonly orgName?: string;
}

export interface OAuthStartInput {
  readonly providerId: string;
  readonly redirectUri?: string;
  readonly scopes?: readonly string[];
  readonly state?: string;
  readonly codeChallenge?: string;
  readonly flow?: "browser" | "device";
}

export interface OAuthStartResult {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly expiresAtMs: number;
  readonly userCode?: string;
  readonly verificationUri?: string;
  readonly intervalSeconds?: number;
  readonly flow?: "browser" | "device";
}

export interface OAuthExchangeInput {
  readonly providerId: string;
  readonly code: string;
  readonly state?: string;
  readonly redirectUri?: string;
  readonly codeVerifier?: string;
}

export interface RefreshTokenInput {
  readonly providerId: string;
  readonly accountId: string;
  readonly refreshToken: string;
  /** Persisted provider credential bundle, when a driver needs client metadata. */
  readonly credential?: string | null;
}

export interface RevokeTokenInput {
  readonly providerId: string;
  readonly accountId: string;
  readonly token: string;
}

/** Explicit OAuth lifecycle and entry-flow capabilities. */
export interface AuthDriverCapabilities {
  readonly supportsStart: boolean;
  readonly supportsPoll: boolean;
  readonly supportsExchange: boolean;
  readonly supportsRefresh: boolean;
  readonly supportsRevoke: boolean;
  readonly accessOnly: boolean;
  /** Authorization-code/redirect login can be started by the console. */
  readonly supportsBrowser: boolean;
  /** Device-code login can be started and polled by the console. */
  readonly supportsDevice: boolean;
}

/** Shared provider auth contract; provider-specific wire details stay in providers. */
export interface AuthDriver {
  readonly kind: string;
  readonly capabilities?: AuthDriverCapabilities;
  start?(input: OAuthStartInput): Promise<OAuthStartResult>;
  poll?(state: string): Promise<{ readonly status: "pending" | "completed" | "expired"; readonly intervalSeconds?: number; readonly tokenSet?: TokenSet }>;
  exchange?(input: OAuthExchangeInput): Promise<TokenSet>;
  refresh?(input: RefreshTokenInput): Promise<TokenSet>;
  revoke?(input: RevokeTokenInput): Promise<void>;
}

/**
 * Shared credential-bundle codec for providers that store an OAuth access
 * token either as a raw string or as a JSON object (`{ accessToken, ... }`).
 *
 * Each provider previously re-implemented this trim/parse/extract dance with
 * subtly different edge-case handling. This module is the single source of
 * truth; provider auth drivers and adapters consume it instead of
 * re-deriving the shape.
 */
function parseAccessToken(trimmed: string): string | undefined {
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>).accessToken;
      return typeof value === "string" && value.length > 0 ? value : undefined;
    }
  } catch {
    // Callers decide whether malformed JSON is invalid or a raw credential.
  }
  return undefined;
}

/**
 * Extracts the bearer access token from a stored credential.
 *
 * Accepts:
 *  - a raw token string (returned as-is when non-empty)
 *  - a JSON object with a non-empty `accessToken` string field
 *
 * Returns `undefined` when the credential is empty, malformed JSON, or the
 * object lacks a usable access token. Callers that want to fall back to the
 * raw string on parse failure (instead of treating it as an error) should
 * use {@link extractAccessTokenOrRaw}.
 */
export function extractAccessToken(credential: string): string | undefined {
  const trimmed = credential.trim();
  if (trimmed.length === 0) return undefined;
  return parseAccessToken(trimmed) ?? (trimmed.startsWith("{") ? undefined : trimmed);
}

/**
 * Like {@link extractAccessToken}, but falls back to returning the raw
 * credential string when the JSON parse fails or the object lacks an
 * `accessToken` field. Use this for providers that treat malformed JSON
 * as a raw API key so the upstream returns a typed auth error.
 */
export function extractAccessTokenOrRaw(credential: string): string {
  const trimmed = credential.trim();
  return parseAccessToken(trimmed) ?? trimmed;
}

/** A provider-id keyed {@link AuthDriver} registration. */
export interface AuthDriverEntry {
  readonly providerId: string;
  readonly driver: AuthDriver;
}
