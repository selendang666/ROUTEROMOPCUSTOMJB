ALTER TABLE custom_providers
  ADD COLUMN IF NOT EXISTS query_params_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS compatibility_profile_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS anthropic_profile_json jsonb NOT NULL DEFAULT '{}'::jsonb;
