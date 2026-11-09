-- 023_console_log_context.sql — structured context for console_logs, account/proxy/reasoning attribution for request_events
ALTER TABLE console_logs ADD COLUMN IF NOT EXISTS context_json jsonb;
ALTER TABLE request_events ADD COLUMN IF NOT EXISTS account_id text;
ALTER TABLE request_events ADD COLUMN IF NOT EXISTS proxy_id text;
ALTER TABLE request_events ADD COLUMN IF NOT EXISTS reasoning_tokens integer;
CREATE INDEX IF NOT EXISTS idx_request_events_account_id ON request_events(account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_request_events_proxy_id ON request_events(proxy_id) WHERE proxy_id IS NOT NULL;
