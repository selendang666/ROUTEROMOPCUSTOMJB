CREATE TABLE IF NOT EXISTS buyers (
  id text PRIMARY KEY,
  api_key_id text NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
  subdomain text NOT NULL UNIQUE,
  email text NOT NULL,
  license_key text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_buyers_status ON buyers(status);
CREATE INDEX IF NOT EXISTS idx_buyers_expires ON buyers(expires_at);
CREATE INDEX IF NOT EXISTS idx_buyers_api_key ON buyers(api_key_id);
