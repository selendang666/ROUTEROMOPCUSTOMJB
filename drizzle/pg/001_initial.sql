-- 001_initial.sql — fresh PostgreSQL authority, incompatible with legacy storage.
-- All timestamps timestamptz. Typed, indexed, no compatibility layer.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  id integer PRIMARY KEY CHECK (id = 1),
  password_hash text,
  password_version integer NOT NULL DEFAULT 1,
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  initialized_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS api_keys (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  rate_limit_rpm integer CHECK (rate_limit_rpm IS NULL OR rate_limit_rpm > 0),
  daily_token_limit integer CHECK (daily_token_limit IS NULL OR daily_token_limit > 0),
  monthly_token_limit integer CHECK (monthly_token_limit IS NULL OR monthly_token_limit > 0),
  one_time_token_limit integer CHECK (one_time_token_limit IS NULL OR one_time_token_limit > 0),
  one_time_tokens_used integer NOT NULL DEFAULT 0,
  max_concurrent_requests integer CHECK (max_concurrent_requests IS NULL OR max_concurrent_requests > 0),
  provider_allowlist text,
  model_allowlist text,
  model_denylist text,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(active) WHERE active = true;

CREATE TABLE IF NOT EXISTS provider_accounts (
  id text PRIMARY KEY,
  provider text NOT NULL,
  name text NOT NULL,
  credential_kind text NOT NULL CHECK (credential_kind IN ('api_key','oauth','manual','none')),
  credential_encrypted text NOT NULL,
  credential_hint text NOT NULL DEFAULT '',
  priority integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  cooldown_until timestamptz,
  cooldown_level integer NOT NULL DEFAULT 0,
  consecutive_use_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, name)
);
CREATE INDEX IF NOT EXISTS idx_provider_accounts_provider_priority ON provider_accounts(provider, priority, name, id);
CREATE INDEX IF NOT EXISTS idx_provider_accounts_cooldown ON provider_accounts(cooldown_until) WHERE cooldown_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_provider_accounts_active ON provider_accounts(active, provider) WHERE active = true;

CREATE TABLE IF NOT EXISTS provider_account_health (
  account_id text PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy','cooling_down','error','disabled')),
  error_kind text,
  status_code integer,
  sanitized_message text,
  occurred_at timestamptz,
  retry_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_account_health_retry ON provider_account_health(retry_at) WHERE retry_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_model_locks (
  account_id text NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  model_id text NOT NULL,
  retry_at timestamptz NOT NULL,
  error_kind text,
  status_code integer,
  sanitized_message text,
  failure_count integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_account_model_locks_retry ON account_model_locks(retry_at) WHERE retry_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS oauth_refresh_leases (
  account_id text PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  generation integer NOT NULL,
  token_fingerprint text NOT NULL,
  lease_until_ms bigint NOT NULL,
  acquired_at_ms bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_leases_expiry ON oauth_refresh_leases(lease_until_ms);

CREATE TABLE IF NOT EXISTS provider_models (
  provider text NOT NULL,
  model_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model_id)
);
CREATE INDEX IF NOT EXISTS idx_provider_models_enabled ON provider_models(provider, enabled) WHERE enabled = true;

CREATE TABLE IF NOT EXISTS model_aliases (
  alias text PRIMARY KEY,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS combos (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  models_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  strategy text NOT NULL DEFAULT 'fallback',
  sticky_limit integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS custom_providers (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('openai-compatible','anthropic-compatible')),
  base_url text NOT NULL,
  credential_encrypted text NOT NULL DEFAULT '',
  timeout_seconds integer NOT NULL DEFAULT 30,
  models_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  headers_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proxies (
  id text PRIMARY KEY,
  name text NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('http','https','socks5')),
  is_relay boolean NOT NULL DEFAULT false,
  host text NOT NULL,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username text,
  password_encrypted text,
  priority integer NOT NULL DEFAULT 100,
  weight integer NOT NULL DEFAULT 100,
  max_concurrency integer NOT NULL DEFAULT 8,
  active boolean NOT NULL DEFAULT true,
  cooldown_until timestamptz,
  cooldown_level integer NOT NULL DEFAULT 0,
  consecutive_use_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_test_at timestamptz,
  last_test_success_at timestamptz,
  last_test_success_latency_ms integer,
  last_test_error_at timestamptz,
  last_test_error text,
  last_test_status_code integer
);
CREATE INDEX IF NOT EXISTS idx_proxies_priority ON proxies(priority, name, id);
CREATE INDEX IF NOT EXISTS idx_proxies_cooldown ON proxies(cooldown_until) WHERE cooldown_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS proxy_health (
  proxy_id text PRIMARY KEY REFERENCES proxies(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'healthy',
  error_kind text,
  status_code integer,
  sanitized_message text,
  occurred_at timestamptz,
  retry_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_proxy_health_retry ON proxy_health(retry_at) WHERE retry_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS proxy_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  enabled boolean NOT NULL DEFAULT false,
  excluded_providers_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  smart_dynamic_routing boolean NOT NULL DEFAULT false,
  smart_dynamic_proxy_count integer NOT NULL DEFAULT 2,
  routing_preset text NOT NULL DEFAULT 'auto',
  target_concurrent integer NOT NULL DEFAULT 0,
  web_search_preference text NOT NULL DEFAULT 'auto',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO proxy_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS access_rules (
  scope text PRIMARY KEY,
  mode text NOT NULL DEFAULT 'open',
  entries_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS share_links (
  id text PRIMARY KEY,
  api_key_id text NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  kind text NOT NULL DEFAULT 'monitor',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  used_at timestamptz,
  last_viewed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_share_links_api_key ON share_links(api_key_id);
CREATE INDEX IF NOT EXISTS idx_share_links_active ON share_links(active, kind, expires_at);

CREATE TABLE IF NOT EXISTS console_sessions (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_console_sessions_token ON console_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_console_sessions_expires ON console_sessions(expires_at) WHERE expires_at IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS request_events (
  id bigserial PRIMARY KEY,
  trace_id text NOT NULL,
  endpoint text NOT NULL,
  surface text NOT NULL,
  api_key_id text,
  api_key_prefix text,
  provider text,
  model text,
  status integer NOT NULL,
  error_kind text,
  stream boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  duration_ms integer NOT NULL,
  input_tokens integer,
  output_tokens integer,
  cached_tokens integer,
  total_tokens integer,
  usage_source text NOT NULL DEFAULT 'unknown',
  meta_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_name text NOT NULL DEFAULT 'unknown',
  client_source text NOT NULL DEFAULT 'unknown',
  message_count integer NOT NULL DEFAULT 0,
  tool_count integer NOT NULL DEFAULT 0,
  image_count integer NOT NULL DEFAULT 0,
  tfft_ms integer,
  client_ip text
);

CREATE TABLE IF NOT EXISTS console_logs (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  level text NOT NULL,
  scope text NOT NULL,
  msg text NOT NULL
);

