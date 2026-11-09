ALTER TABLE provider_models ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE provider_models ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_provider_models_source ON provider_models(source);
