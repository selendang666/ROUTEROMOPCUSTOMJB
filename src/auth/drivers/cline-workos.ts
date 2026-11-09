import type { TokenSet } from "../contract.js";
import { nonEmpty, OAuthDriverError, OAuthHttpClient } from "../http-client.js";

const WORKOS_API_BASE_URL = "https://api.workos.com";
const WORKOS_DEVICE_AUTHORIZATION_URL = `${WORKOS_API_BASE_URL}/user_management/authorize/device`;
const WORKOS_AUTHENTICATE_URL = `${WORKOS_API_BASE_URL}/user_management/authenticate`;
const CLINE_REGISTER_URL = "https://api.cline.bot/api/v1/auth/register";
const WORKOS_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_DEVICE_EXPIRES_SECONDS = 300;
const DEFAULT_DEVICE_INTERVAL_SECONDS = 5;

export const CLINE_WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";

/** WorkOS device authorization data retained while a user completes login. */
export interface ClineWorkOsDeviceSession {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresAtMs: number;
  readonly intervalSeconds: number;
}

/** Result of one WorkOS device-token polling attempt. */
export type ClineWorkOsPollResult =
  | { readonly status: "pending"; readonly intervalSeconds: number }
  | { readonly status: "expired" }
  | { readonly status: "completed"; readonly tokenSet: TokenSet };

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nestedRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const nested = value[key];
  return typeof nested === "object" && nested !== null && !Array.isArray(nested) ? nested as Record<string, unknown> : value;
}

function registeredTokenSet(data: Record<string, unknown>, nowMs: number): TokenSet {
  const userInfo = nestedRecord(data, "userInfo");
  const accessToken = nonEmpty(data.accessToken);
  const refreshToken = nonEmpty(data.refreshToken);
  if (accessToken === undefined) {
    throw new OAuthDriverError("validation", "Cline WorkOS registration response is missing an access token.", 502, false);
  }
  const expiresAt = nonEmpty(data.expiresAt) ?? nonEmpty(data.expires_at) ?? new Date(nowMs + 3_600_000).toISOString();
  const email = nonEmpty(data.email) ?? nonEmpty(userInfo.email);
  const providerAccountId = nonEmpty(data.userId) ?? nonEmpty(userInfo.clineUserId);
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    expiresAt,
    ...(email === undefined ? {} : { email }),
    ...(providerAccountId === undefined ? {} : { providerAccountId }),
  };
}

/**
 * Requests a production WorkOS device code used by both Cline and ClinePass.
 *
 * @param http OAuth transport used for the device authorization request.
 * @param provider Provider label used in normalized errors.
 * @returns Device data to expose to the user and retain for polling.
 */
export async function requestClineWorkOsDevice(http: OAuthHttpClient, provider: string): Promise<Omit<ClineWorkOsDeviceSession, "expiresAtMs"> & { readonly expiresInSeconds: number }> {
  const data = await http.postForm(
    WORKOS_DEVICE_AUTHORIZATION_URL,
    { client_id: CLINE_WORKOS_CLIENT_ID },
    provider,
    "device authorization",
  );
  const deviceCode = nonEmpty(data.device_code);
  const userCode = nonEmpty(data.user_code);
  const verificationUri = nonEmpty(data.verification_uri);
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
    throw new OAuthDriverError("validation", `${provider} WorkOS device authorization response is missing device credentials.`, 502, false);
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(nonEmpty(data.verification_uri_complete) === undefined ? {} : { verificationUriComplete: nonEmpty(data.verification_uri_complete) }),
    expiresInSeconds: positiveNumber(data.expires_in, DEFAULT_DEVICE_EXPIRES_SECONDS),
    intervalSeconds: Math.max(1, Math.floor(positiveNumber(data.interval, DEFAULT_DEVICE_INTERVAL_SECONDS))),
  };
}

/**
 * Polls WorkOS once and registers completed WorkOS tokens with Cline.
 *
 * @param http OAuth transport used for WorkOS and Cline requests.
 * @param session Device data created by {@link requestClineWorkOsDevice}.
 * @param provider Provider label used in normalized errors.
 * @param nowMs Clock used for expiration and token fallback timestamps.
 * @returns Pending, expired, or completed device-flow state.
 */
export async function pollClineWorkOsDevice(http: OAuthHttpClient, session: ClineWorkOsDeviceSession, provider: string, nowMs: () => number): Promise<ClineWorkOsPollResult> {
  if (session.expiresAtMs <= nowMs()) return { status: "expired" };

  let result;
  try {
    result = await http.postFormResult(
      WORKOS_AUTHENTICATE_URL,
      { grant_type: WORKOS_DEVICE_GRANT, device_code: session.deviceCode, client_id: CLINE_WORKOS_CLIENT_ID },
      provider,
      "device poll",
    );
  } catch {
    return { status: "pending", intervalSeconds: session.intervalSeconds };
  }
  const body = result.body;
  const error = body === null ? undefined : nonEmpty(body.error);
  if (!result.ok) {
    if (error === "authorization_pending") return { status: "pending", intervalSeconds: session.intervalSeconds };
    if (error === "slow_down") return { status: "pending", intervalSeconds: session.intervalSeconds + 1 };
    const description = body === null ? "" : nonEmpty(body.error_description) ?? "";
    throw new OAuthDriverError("device-auth", `${provider} WorkOS device poll failed: ${description || `HTTP ${result.status}`}`, result.status, result.status >= 500 || result.status === 429, result.retryAt);
  }
  if (body === null) {
    throw new OAuthDriverError("malformed-response", `${provider} WorkOS device poll returned an invalid response.`, 502, false);
  }
  const accessToken = nonEmpty(body.access_token);
  const refreshToken = nonEmpty(body.refresh_token);
  if (accessToken === undefined || refreshToken === undefined) {
    throw new OAuthDriverError("validation", `${provider} WorkOS device poll response is missing token fields.`, 502, false);
  }
  const registered = await http.postJson(
    CLINE_REGISTER_URL,
    { accessToken, refreshToken },
    provider,
    "token registration",
  );
  return { status: "completed", tokenSet: registeredTokenSet(registered.data && typeof registered.data === "object" && !Array.isArray(registered.data) ? registered.data as Record<string, unknown> : registered, nowMs()) };
}
