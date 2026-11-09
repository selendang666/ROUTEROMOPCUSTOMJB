// AuthorizationCodeDriver — shared base class for authorization-code providers.
// Shared authorization-code driver base.

import type { OAuthExchangeInput, OAuthStartInput, OAuthStartResult, TokenSet } from "./contract.js";
import { OAUTH_STATE_TTL_MS, OAuthDriverError, OAuthHttpClient } from "./http-client.js";
import type { OAuthDriverOptions } from "./http-client.js";

/** Shared {@link OAuthStartResult} shaping and PKCE/state handling for authorization-code drivers. */
export abstract class AuthorizationCodeDriver {
  protected readonly http: OAuthHttpClient;
  protected readonly nowMs: () => number;
  readonly kind = "oauth" as const;

  constructor(options: OAuthDriverOptions = {}) {
    this.http = new OAuthHttpClient(options);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  protected abstract get providerId(): string;

  /** Returns the authorization URL for the given provider using injected state/challenge. */
  protected buildStart(input: OAuthStartInput, params: Record<string, string>): OAuthStartResult {
    const state = input.state && input.state.length > 0 ? input.state : crypto.randomUUID();
    const url = new URL(this.authorizeUrl());
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("state", state);
    return { authorizationUrl: url.toString(), state, expiresAtMs: this.nowMs() + OAUTH_STATE_TTL_MS };
  }

  protected challenge(input: OAuthStartInput): string {
    if (input.codeChallenge && input.codeChallenge.length > 0) return input.codeChallenge;
    throw new OAuthDriverError("validation", `${this.providerId} requires a PKCE code challenge for its authorization flow.`, 400, false);
  }

  protected abstract authorizeUrl(): string;
}

// Re-export token shapes so driver files only import from base.
export type { OAuthExchangeInput, OAuthStartInput, OAuthStartResult, TokenSet };
