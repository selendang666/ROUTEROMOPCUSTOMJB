CREATE TABLE IF NOT EXISTS ip_bans (
  ip inet PRIMARY KEY,
  reason text NOT NULL DEFAULT 'failed_login',
  failed_attempts integer NOT NULL DEFAULT 1,
  ban_started_at timestamptz NOT NULL DEFAULT now(),
  ban_expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ip_bans_expires ON ip_bans(ban_expires_at);
