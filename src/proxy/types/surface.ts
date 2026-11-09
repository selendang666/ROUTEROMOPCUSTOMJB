/**
 * Surface + primitive domain — source
 */

export type Surface = "openai-chat" | "openai-responses" | "anthropic-messages" | "web-search" | "images";

export type ProxyOperation = "invoke" | "compact";

export type ProviderProtocol = "openai" | "anthropic" | "gemini" | "compatible" | "exa" | "devin";

export type CredentialKind = "api_key" | "oauth" | "manual" | "none";

export type RouteScope = "account" | "proxy" | "provider";

export type RouteStatus = "healthy" | "cooling_down" | "error" | "disabled";

export type CooldownKind = "permanent" | "transient" | "quota";

export type ProviderFailureCode =
  | "auth_invalidated"
  | "usage_limit"
  | "rate_limit_transient"
  | "context_overflow"
  | "stale_response_state"
  | "empty_provider_body"
  | "provider_finish_error"
  | "content_blocked"
  | "tool_schema_rejected"
  | "optional_parameter_rejected"
  | "stream_pre_response_timeout"
  | "stream_idle_timeout"
  | "stream_total_timeout"
  | "caller_aborted"
  | "unknown_provider_failure";

export type ErrorSource = "internal" | "upstream" | "client";

export type ReasoningEffort = "xhigh" | "high" | "medium" | "low" | "minimal" | "none";

export type ReasoningSummary = "auto" | "concise" | "detailed";

export type ReasoningMode = "standard" | "pro";

export type ReasoningContext = "auto" | "current_turn" | "all_turns";
