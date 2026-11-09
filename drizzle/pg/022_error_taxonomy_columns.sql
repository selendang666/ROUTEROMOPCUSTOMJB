-- 022_error_taxonomy_columns.sql — queryable upstream error fields, mirrors SQLite/D1 telemetry schema
ALTER TABLE request_events ADD COLUMN IF NOT EXISTS error_provider_code text;
ALTER TABLE request_events ADD COLUMN IF NOT EXISTS error_provider_type text;
ALTER TABLE request_events ADD COLUMN IF NOT EXISTS error_upstream_request_id text;
ALTER TABLE request_events ADD COLUMN IF NOT EXISTS error_retry_after_ms integer;
CREATE INDEX IF NOT EXISTS idx_request_events_provider_code ON request_events(error_provider_code) WHERE error_provider_code IS NOT NULL;
