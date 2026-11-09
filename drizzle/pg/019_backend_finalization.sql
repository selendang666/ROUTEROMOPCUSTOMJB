-- 019 backend finalization
ALTER TABLE provider_account_health ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0;
ALTER TABLE custom_providers ADD COLUMN IF NOT EXISTS surfaces_json jsonb NOT NULL DEFAULT '["openai-chat"]'::jsonb;
ALTER TABLE custom_providers ADD COLUMN IF NOT EXISTS endpoints_json jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE custom_providers ADD COLUMN IF NOT EXISTS quirks_json jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE custom_providers ADD COLUMN IF NOT EXISTS native_passthrough boolean NOT NULL DEFAULT false;
ALTER TABLE custom_providers ADD COLUMN IF NOT EXISTS compact_path text;
ALTER TABLE custom_providers ADD CONSTRAINT custom_providers_surfaces_json_check CHECK (jsonb_typeof(surfaces_json) = 'array');
ALTER TABLE custom_providers ADD CONSTRAINT custom_providers_endpoints_json_check CHECK (jsonb_typeof(endpoints_json) = 'array');
ALTER TABLE custom_providers ADD CONSTRAINT custom_providers_quirks_json_check CHECK (jsonb_typeof(quirks_json) = 'object');
ALTER TABLE custom_providers ADD CONSTRAINT custom_providers_compact_path_check CHECK (compact_path IS NULL OR (char_length(compact_path) BETWEEN 1 AND 256 AND compact_path LIKE '/%'));
