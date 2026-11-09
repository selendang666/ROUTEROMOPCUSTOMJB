-- 021_hot_snapshot_indexes.sql — composite covering indexes for the per-request route snapshot fan-out
-- Idempotent via IF NOT EXISTS; additive only.
CREATE INDEX IF NOT EXISTS idx_provider_accounts_active_sort ON provider_accounts(active, provider, priority, name, id);
CREATE INDEX IF NOT EXISTS idx_proxies_active_sort ON proxies(active, priority, name, id);
CREATE INDEX IF NOT EXISTS idx_provider_models_enabled_sort ON provider_models(enabled, provider, model_id);
