-- 020_telemetry_aggregates.sql — indexes for dashboard telemetry aggregation paths
-- Covers trace_id, created_at/started_at, provider, model, api_key_id, and console-log access paths.
-- Reversible via DROP IF EXISTS; idempotent via IF NOT EXISTS.

ALTER TABLE request_events ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_request_events_trace_id_agg ON request_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_request_events_created_at_agg ON request_events(created_at);
CREATE INDEX IF NOT EXISTS idx_request_events_started_at_agg ON request_events(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_events_provider_agg ON request_events(provider) WHERE provider IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_request_events_model_agg ON request_events(model) WHERE model IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_request_events_api_key_id_agg ON request_events(api_key_id) WHERE api_key_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_request_events_provider_created_agg ON request_events(provider, created_at) WHERE provider IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_request_events_model_created_agg ON request_events(model, created_at) WHERE model IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_request_events_api_key_created_agg ON request_events(api_key_id, created_at) WHERE api_key_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_request_events_status_created_agg ON request_events(status, created_at);
CREATE INDEX IF NOT EXISTS idx_request_events_client_ip_created_agg ON request_events(client_ip, created_at) WHERE client_ip IS NOT NULL;

-- Console logs: newest-first id and scope-filtered tail queries
CREATE INDEX IF NOT EXISTS idx_console_logs_id_desc_agg ON console_logs(id DESC);
CREATE INDEX IF NOT EXISTS idx_console_logs_scope_id_agg ON console_logs(scope, id DESC);
CREATE INDEX IF NOT EXISTS idx_console_logs_level_id_agg ON console_logs(level, id DESC);
