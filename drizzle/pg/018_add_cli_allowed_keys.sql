-- 018_add_cli_allowed_keys.sql — persist allowed API keys for Claude remote mapping
ALTER TABLE cli_tools ADD COLUMN IF NOT EXISTS allowed_api_key_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
