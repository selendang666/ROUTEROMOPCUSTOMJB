// OAuth login session manager + state manager. Bounded, in-memory interactive
// OAuth login sessions with one-time state.
import type { TokenSet, OAuthStartResult } from "./contract.js";
import type { AuthDriverRegistry } from "./driver-registry.js";
import { OAuthDriverError, createPkce } from "./http-client.js";

export const OAUTH_LOGIN_SESSION_TTL_MS = 15 * 60_000;

export const OAUTH_MAX_LOGIN_SESSIONS = 500;

export type OAuthSessionStatus = "waiting-for-user" | "exchanging-code" | "completed" | "failed" | "cancelled" | "expired";

export interface OAuthLoginSessionView {
  readonly sessionId: string;
  readonly providerId: string;
  readonly name: string;
  readonly status: OAuthSessionStatus;
  readonly authorizationUrl: string | null;
  readonly redirectUri: string | null;
  readonly userCode: string | null;
  readonly verificationUri: string | null;
  readonly intervalSeconds: number | null;
  readonly accountId: string | null;
  readonly errorKind: string | null;
  readonly errorMessage: string | null;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export type OAuthSessionErrorKind = "not_found" | "conflict" | "invalid_request" | "state_mismatch" | "authorization_denied" | "expired" | "driver_unavailable";

/** Typed failure from the interactive OAuth session lifecycle; `status` is the HTTP status to surface. */
export class OAuthSessionError extends Error {
  readonly kind: OAuthSessionErrorKind;
  readonly status: number;

  constructor(kind: OAuthSessionErrorKind, message: string, status = 400) {
    super(message);
    this.name = "OAuthSessionError";
    this.kind = kind;
    this.status = status;
  }
}

export interface OAuthStartSessionInput {
  readonly providerId: string;
  readonly name: string;
  readonly redirectUri?: string;
  readonly scopes?: readonly string[];
  readonly flow?: "browser" | "device";
}

export interface OAuthStartSessionResult {
  readonly sessionId: string;
  readonly providerId: string;
  readonly name: string;
  readonly status: OAuthSessionStatus;
  readonly authorizationUrl: string;
  readonly redirectUri: string | null;
  readonly userCode: string | null;
  readonly verificationUri: string | null;
  readonly intervalSeconds: number | null;
  readonly state: string;
  readonly expiresAtMs: number;
  readonly flow: "browser" | "device";
}

/** Structured completion payload; `value` accepts a callback URL or query string. */
export interface OAuthCompleteSessionInput {
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
  readonly codeVerifier?: string;
  readonly redirectUri?: string;
  readonly value?: string;
}

export interface OAuthSessionManagerOptions {
  readonly drivers: AuthDriverRegistry;
  readonly stateManager?: OAuthStateManager;
  readonly ttlMs?: number;
  readonly maxSessions?: number;
  readonly nowMs?: () => number;
  readonly randomSessionId?: () => string;
}

/** Structured completion payload; `value` accepts a callback URL or query string. */
export function parseOAuthCallbackValue(value: string): { readonly code?: string; readonly state?: string; readonly error?: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return {};
  let query: string;
  if (trimmed.startsWith("?") || trimmed.startsWith("&")) {
    query = trimmed.slice(1);
  } else if (trimmed.includes("=") && !trimmed.includes("://")) {
    query = trimmed;
  } else {
    try {
      query = new URL(trimmed).search.slice(1);
    } catch {
      return {};
    }
  }
  const parts = new URLSearchParams(query);
  const code = (parts.get("code") ?? parts.get("token"))?.trim();
  const state = parts.get("state")?.trim();
  const error = parts.get("error")?.trim();
  return { code: code && code.length > 0 ? code : undefined, state: state && state.length > 0 ? state : undefined, error: error && error.length > 0 ? error : undefined };
}

interface SessionRecord {
  readonly sessionId: string;
  readonly providerId: string;
  readonly name: string;
  readonly state: string;
  readonly stateRecord: OAuthStateRecord;
  readonly redirectUri: string | null;
  readonly userCode: string | null;
  readonly verificationUri: string | null;
  readonly intervalSeconds: number | null;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  status: OAuthSessionStatus;
  accountId: string | null;
  errorKind: string | null;
  errorMessage: string | null;
  tokenSet: TokenSet | null;
  readonly authorizationUrl: string;
  readonly deviceFlow: boolean;
}

/**
 * Bounded, in-memory interactive OAuth login sessions.
 *
 * `start` drives the provider's authorization-code flow (PKCE + state through
 * the shared {@link OAuthStateManager}); `complete` validates the state once,
 * exchanges the code through the provider driver, and hands the resulting
 * {@link TokenSet} back to the caller for durable persistence. Sessions expire
 * after a bounded TTL and are evicted past a hard size cap, so abandoned
 * logins cannot grow process memory forever.
 */
export class OAuthLoginSessionManager {
  private readonly drivers: AuthDriverRegistry;
  private readonly stateManager: OAuthStateManager;
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly nowMs: () => number;
  private readonly randomSessionId: () => string;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(options: OAuthSessionManagerOptions) {
    this.drivers = options.drivers;
    this.stateManager = options.stateManager ?? new OAuthStateManager();
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? OAUTH_LOGIN_SESSION_TTL_MS));
    this.maxSessions = Math.max(1, Math.floor(options.maxSessions ?? OAUTH_MAX_LOGIN_SESSIONS));
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.randomSessionId = options.randomSessionId ?? (() => crypto.randomUUID());
  }

  async start(input: OAuthStartSessionInput): Promise<OAuthStartSessionResult> {
    const name = input.name.trim().replace(/[\r\n]+/g, " ");
    const boundedName = name.length > 120 ? `${name.slice(0, 120)}…` : name;
    if (boundedName.length === 0) throw new OAuthSessionError("invalid_request", "Account name is required.");
    const driver = this.drivers.get(input.providerId);
    if (driver === null) throw new OAuthSessionError("invalid_request", "provider does not support OAuth login", 400);
    if (driver.start === undefined) throw new OAuthSessionError("invalid_request", "provider does not support an interactive OAuth login", 400);
    const pkce = await createPkce();
    const secureStateValue = secureState();
    let startResult: OAuthStartResult;
    try {
      startResult = await driver.start({
        providerId: input.providerId,
        redirectUri: input.redirectUri,
        scopes: input.scopes,
        state: secureStateValue,
        codeChallenge: pkce.challenge,
        flow: input.flow,
      });
      if (startResult.state !== secureStateValue) throw new OAuthSessionError("invalid_request", "OAuth driver returned mismatched state", 502);
    } catch (error) {
      if (error instanceof OAuthSessionError) throw error;
      throw this.driverStartFailure(error, input.providerId);
    }
    const stateRecord = this.stateManager.create({ providerId: input.providerId, redirectUri: input.redirectUri, codeVerifier: pkce.verifier, codeChallenge: pkce.challenge, state: startResult.state });
    const now = this.nowMs();
    this.evictExpired(now);
    while (this.sessions.size >= this.maxSessions) this.evictOldest();
    const sessionId = this.randomSessionId();
    const session: SessionRecord = {
      sessionId,
      providerId: input.providerId,
      name: boundedName,
      state: startResult.state,
      stateRecord,
      redirectUri: input.redirectUri ?? null,
      userCode: startResult.userCode ?? null,
      verificationUri: startResult.verificationUri ?? null,
      intervalSeconds: startResult.intervalSeconds ?? null,
      createdAtMs: now,
      expiresAtMs: Math.min(startResult.expiresAtMs, now + this.ttlMs),
      status: "waiting-for-user",
      accountId: null,
      errorKind: null,
      errorMessage: null,
      tokenSet: null,
      authorizationUrl: startResult.authorizationUrl,
      deviceFlow: startResult.flow === "device" || driver.poll !== undefined,
    };
    this.sessions.set(sessionId, session);
    return {
      sessionId,
      providerId: session.providerId,
      name: session.name,
      status: session.status,
      authorizationUrl: session.authorizationUrl,
      redirectUri: session.redirectUri,
      userCode: session.userCode,
      verificationUri: session.verificationUri,
      intervalSeconds: session.intervalSeconds,
      state: session.state,
      expiresAtMs: session.expiresAtMs,
      flow: session.deviceFlow ? "device" : "browser",
    };
  }

  /** Returns the session view; expired sessions are surfaced with status "expired" (never deleted here — only bounded on create). */
  get(sessionId: string): OAuthLoginSessionView | null {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return null;
    if (this.expired(session)) session.status = "expired";
    return this.view(session);
  }

  /** Returns completed token material for the console persistence handoff. */
  getTokenSet(sessionId: string): TokenSet | null {
    const session = this.sessions.get(sessionId);
    return session?.status === "completed" ? session.tokenSet : null;
  }

  /** Cancels a pending session exactly once; false when the session does not exist. */
  cancel(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return false;
    if (session.status === "waiting-for-user") session.status = "cancelled";
    return true;
  }

  /** Binds the persisted account id onto a completed session (console persistence handoff). */
  attachAccountId(sessionId: string, accountId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.status !== "completed") return false;
    session.accountId = accountId;
    return true;
  }

  /** Polls a provider device flow and records a completed token set when ready. */
  async poll(sessionId: string): Promise<OAuthLoginSessionView> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new OAuthSessionError("not_found", "OAuth login session not found", 404);
    }
    if (this.expired(session)) {
      session.status = "expired";
      return this.view(session);
    }
    if (session.status !== "waiting-for-user") return this.view(session);
    if (!session.deviceFlow) return this.view(session);
    const driver = this.drivers.get(session.providerId);
    if (driver?.poll === undefined) return this.view(session);

    try {
      const result = await driver.poll(session.state);
      if (result.status === "completed" && result.tokenSet !== undefined) {
        session.status = "completed";
        session.tokenSet = result.tokenSet;
      } else if (result.status === "expired") {
        session.status = "expired";
      }
      return this.view(session);
    } catch (error) {
      const details = this.driverExchangeFailure(error, session.providerId);
      session.status = "failed";
      session.errorKind = details.kind;
      session.errorMessage = details.message;
      throw new OAuthSessionError(details.kind, details.message, details.status);
    }
  }

  /**
   * Validates callback state and exchanges the authorization code through the
   * provider driver. The state is consumed exactly once through the shared
   * state manager; failures mark the session failed and throw a typed
   * {@link OAuthSessionError}.
   */
  async complete(sessionId: string, input: OAuthCompleteSessionInput): Promise<{ readonly view: OAuthLoginSessionView; readonly tokenSet: TokenSet }> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new OAuthSessionError("not_found", "OAuth login session not found", 404);
    if (this.expired(session)) {
      this.sessions.delete(sessionId);
      throw new OAuthSessionError("expired", "OAuth login session expired");
    }
    if (session.deviceFlow && session.status === "completed" && session.tokenSet !== null) return { view: this.view(session), tokenSet: session.tokenSet };
    if (session.status !== "waiting-for-user") throw new OAuthSessionError("conflict", `OAuth login session is ${session.status}`, 409);
    const parsed = typeof input.value === "string" ? parseOAuthCallbackValue(input.value) : {};
    const code = input.code ?? parsed.code;
    const state = input.state ?? parsed.state;
    const error = input.error ?? parsed.error;
    if (error !== undefined) {
      session.status = "failed";
      session.errorKind = "authorization_denied";
      session.errorMessage = "OAuth authorization was denied.";
      throw new OAuthSessionError("authorization_denied", "OAuth authorization was denied.");
    }
    if (state !== session.state) {
      session.status = "failed";
      session.errorKind = "state_mismatch";
      session.errorMessage = "OAuth state did not match.";
      throw new OAuthSessionError("state_mismatch", "OAuth state did not match.");
    }
    const consumed = this.stateManager.consume(state, session.providerId, this.nowMs());
    if (consumed === null) {
      session.status = "failed";
      session.errorKind = "state_mismatch";
      session.errorMessage = "OAuth authorization state is invalid, expired, or already used.";
      throw new OAuthSessionError("state_mismatch", "OAuth authorization state is invalid, expired, or already used.");
    }
    const effectiveRedirectUri = input.redirectUri ?? session.redirectUri ?? null;
    if ((consumed.redirectUri ?? null) !== effectiveRedirectUri) {
      session.status = "failed";
      session.errorKind = "state_mismatch";
      session.errorMessage = "OAuth redirect URI did not match.";
      throw new OAuthSessionError("state_mismatch", "OAuth redirect URI did not match.");
    }
    if (code === undefined || code.length === 0) {
      session.status = "failed";
      session.errorKind = "invalid_request";
      session.errorMessage = "Authorization code is required.";
      throw new OAuthSessionError("invalid_request", "Authorization code or redirect URL is required.");
    }
    const driver = this.drivers.get(session.providerId);
    if (driver === null || driver.exchange === undefined) {
      session.status = "failed";
      session.errorKind = "driver_unavailable";
      session.errorMessage = "Provider OAuth exchange is unavailable.";
      throw new OAuthSessionError("driver_unavailable", "Provider OAuth exchange is unavailable.", 503);
    }
    session.status = "exchanging-code";
    let tokenSet: TokenSet;
    try {
      tokenSet = await driver.exchange({
        providerId: session.providerId,
        code,
        state,
        redirectUri: input.redirectUri ?? session.redirectUri ?? undefined,
        codeVerifier: input.codeVerifier ?? consumed.codeVerifier ?? undefined,
      });
    } catch (error) {
      const details = this.driverExchangeFailure(error, session.providerId);
      session.status = "failed";
      session.errorKind = details.kind;
      session.errorMessage = details.message;
      throw new OAuthSessionError(details.kind, details.message, details.status);
    }
    session.status = "completed";
    session.tokenSet = tokenSet;
    return { view: this.view(session), tokenSet };
  }

  size(nowMs: number = this.nowMs()): number {
    this.evictExpired(nowMs);
    return this.sessions.size;
  }

  private view(session: SessionRecord): OAuthLoginSessionView {
    return {
      sessionId: session.sessionId,
      providerId: session.providerId,
      name: session.name,
      status: session.status,
      authorizationUrl: session.authorizationUrl,
      redirectUri: session.redirectUri,
      userCode: session.userCode,
      verificationUri: session.verificationUri,
      intervalSeconds: session.intervalSeconds,
      accountId: session.accountId,
      errorKind: session.errorKind,
      errorMessage: session.errorMessage,
      createdAtMs: session.createdAtMs,
      expiresAtMs: session.expiresAtMs,
    };
  }

  private expired(session: SessionRecord): boolean {
    return session.expiresAtMs <= this.nowMs();
  }

  private evictExpired(nowMs: number): void {
    for (const [sessionId, session] of this.sessions) if (session.expiresAtMs <= nowMs) this.sessions.delete(sessionId);
  }

  private evictOldest(): void {
    let oldest: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [sessionId, session] of this.sessions) {
      if (session.createdAtMs < oldestAt) {
        oldest = sessionId;
        oldestAt = session.createdAtMs;
      }
    }
    if (oldest !== null) this.sessions.delete(oldest);
  }

  private driverStartFailure(error: unknown, providerId: string): OAuthSessionError {
    if (error instanceof OAuthDriverError) {
      return new OAuthSessionError("invalid_request", `${providerId} OAuth login could not be started: ${error.message}`, error.status >= 500 ? 502 : 400);
    }
    return new OAuthSessionError("driver_unavailable", `${providerId} OAuth login could not be started`, 502);
  }

  private driverExchangeFailure(error: unknown, providerId: string): { readonly kind: OAuthSessionErrorKind; readonly message: string; readonly status: number } {
    if (error instanceof OAuthDriverError) {
      const bounded = error.message.length > 240 ? `${error.message.slice(0, 240)}…` : error.message;
      const kind: OAuthSessionErrorKind = error.status === 401 || error.status === 403 ? "authorization_denied" : "invalid_request";
      return { kind, message: `${providerId} OAuth exchange failed: ${bounded}`, status: error.status >= 400 && error.status < 500 ? error.status : 502 };
    }
    return { kind: "driver_unavailable", message: `${providerId} OAuth exchange failed`, status: 502 };
  }
}

const DEFAULT_STATE_TTL_MS = 10 * 60_000;

const DEFAULT_MAX_STATES = 10_000;

function secureState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export interface OAuthStateRecord {
  readonly state: string;
  readonly providerId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly redirectUri: string | null;
  readonly codeVerifier: string | null;
  readonly codeChallenge: string | null;
}

export interface OAuthStateOptions {
  readonly ttlMs?: number;
  readonly maxStates?: number;
  readonly nowMs?: () => number;
  readonly randomState?: () => string;
}

/**
 * Bounded, one-time OAuth authorization state. Expired entries are swept on
 * access and the oldest entries are evicted before the hard size cap is
 * exceeded, so an abandoned authorization cannot grow process memory forever.
 */
export class OAuthStateManager {
  private readonly ttlMs: number;
  private readonly maxStates: number;
  private readonly nowMs: () => number;
  private readonly randomState: () => string;
  private readonly states = new Map<string, OAuthStateRecord>();

  constructor(options: OAuthStateOptions = {}) {
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? DEFAULT_STATE_TTL_MS));
    this.maxStates = Math.max(1, Math.floor(options.maxStates ?? DEFAULT_MAX_STATES));
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.randomState = options.randomState ?? secureState;
  }

  create(input: { readonly providerId: string; readonly redirectUri?: string; readonly codeVerifier?: string; readonly codeChallenge?: string; readonly state?: string }): OAuthStateRecord {
    const now = this.nowMs();
    this.sweep(now);
    while (this.states.size >= this.maxStates) this.evictOldest();
    const state = input.state && input.state.length > 0 ? input.state : this.randomState();
    const record: OAuthStateRecord = {
      state,
      providerId: input.providerId,
      createdAtMs: now,
      expiresAtMs: now + this.ttlMs,
      redirectUri: input.redirectUri ?? null,
      codeVerifier: input.codeVerifier ?? null,
      codeChallenge: input.codeChallenge ?? null,
    };
    this.states.set(state, record);
    return record;
  }

  /** Consumes valid state exactly once; expired or provider-mismatched state is rejected. */
  consume(state: string, providerId: string, nowMs: number = this.nowMs()): OAuthStateRecord | null {
    this.sweep(nowMs);
    const record = this.states.get(state);
    if (record === undefined || record.providerId !== providerId || record.expiresAtMs <= nowMs) {
      if (record !== undefined) this.states.delete(state);
      return null;
    }
    this.states.delete(state);
    return record;
  }

  size(nowMs: number = this.nowMs()): number {
    this.sweep(nowMs);
    return this.states.size;
  }

  clear(): void {
    this.states.clear();
  }

  private sweep(nowMs: number): void {
    for (const [state, record] of this.states) if (record.expiresAtMs <= nowMs) this.states.delete(state);
  }

  private evictOldest(): void {
    let oldest: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [state, record] of this.states) {
      if (record.createdAtMs < oldestAt) {
        oldest = state;
        oldestAt = record.createdAtMs;
      }
    }
    if (oldest !== null) this.states.delete(oldest);
  }
}
