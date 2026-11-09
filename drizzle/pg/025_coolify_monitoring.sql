CREATE TABLE IF NOT EXISTS coolify_servers (
  id text PRIMARY KEY,
  name text NOT NULL,
  base_url text NOT NULL,
  api_token_encrypted text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS monitoring_targets (
  id text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'http',
  url text,
  coolify_server_id text REFERENCES coolify_servers(id) ON DELETE CASCADE,
  interval_seconds integer NOT NULL DEFAULT 60,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS monitoring_status (
  target_id text PRIMARY KEY REFERENCES monitoring_targets(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'unknown',
  latency_ms integer,
  detail_json jsonb,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_monitoring_targets_kind ON monitoring_targets(kind);
CREATE INDEX IF NOT EXISTS idx_monitoring_targets_server ON monitoring_targets(coolify_server_id);
