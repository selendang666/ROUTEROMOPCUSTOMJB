ALTER TABLE request_events ADD COLUMN api_key_id TEXT;
ALTER TABLE request_events ADD COLUMN api_key_prefix TEXT;
CREATE INDEX IF NOT EXISTS idx_request_events_api_key_created ON request_events(api_key_id, created_at);
