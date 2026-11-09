CREATE TABLE IF NOT EXISTS provider_account_quota (
  account_id text PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
  source text,
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'refreshing', 'ready', 'error')),
  plan text,
  windows_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provider_account_quota_status
  ON provider_account_quota(status, last_attempt_at);
