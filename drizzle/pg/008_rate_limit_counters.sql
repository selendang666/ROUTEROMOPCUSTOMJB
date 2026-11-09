-- 008_rate_limit_counters.sql — sliding-window request counters per (ip|scope).
-- One row per active 60s window. Stale windows are deleted by middleware on each touch.
-- scope: 'open' for /v1/* endpoints, 'console' for /console/api/* authenticated endpoints.
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  ip inet NOT NULL,
  scope text NOT NULL,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (ip, scope, window_started_at)
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_window ON rate_limit_counters(window_started_at);
