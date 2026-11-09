-- 002_indexes.sql — time-aware and append-heavy indexes.

-- request_events: time-aware indexes for range scans and dashboard queries
CREATE INDEX IF NOT EXISTS idx_request_events_started_at ON request_events(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_events_status_id ON request_events(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_request_events_provider_status ON request_events(provider, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_request_events_api_key_started ON request_events(api_key_id, started_at DESC) WHERE api_key_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_request_events_provider_started ON request_events(provider, started_at DESC) WHERE provider IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_request_events_model_started ON request_events(model, started_at DESC) WHERE model IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_request_events_trace_id ON request_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_request_events_client_ip ON request_events(client_ip, started_at DESC) WHERE client_ip IS NOT NULL;

-- console_logs: time-aware for tail queries
CREATE INDEX IF NOT EXISTS idx_console_logs_ts ON console_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_console_logs_scope_ts ON console_logs(scope, ts DESC);
CREATE INDEX IF NOT EXISTS idx_console_logs_level_ts ON console_logs(level, ts DESC);

-- Foreign key helper indexes (if not already covered)
CREATE INDEX IF NOT EXISTS idx_provider_accounts_updated ON provider_accounts(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_keys_created ON api_keys(created_at DESC);
