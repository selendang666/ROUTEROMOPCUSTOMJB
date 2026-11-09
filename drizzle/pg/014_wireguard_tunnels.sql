CREATE TABLE IF NOT EXISTS wireguard_pool_settings (
  id boolean PRIMARY KEY DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO wireguard_pool_settings (id, enabled)
VALUES (true, true)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS wireguard_tunnels (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  config_path text NOT NULL UNIQUE,
  proxy_id text REFERENCES proxies(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT true,
  runtime_status text NOT NULL DEFAULT 'stopped',
  process_id integer,
  socks_host text NOT NULL,
  socks_port integer NOT NULL UNIQUE,
  egress_ip inet,
  last_health_check_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wireguard_tunnels_runtime_status CHECK (runtime_status IN ('stopped', 'starting', 'running', 'unhealthy', 'failed')),
  CONSTRAINT wireguard_tunnels_socks_port CHECK (socks_port BETWEEN 1 AND 65535)
);

CREATE INDEX IF NOT EXISTS wireguard_tunnels_enabled_status_idx
  ON wireguard_tunnels (enabled, runtime_status);
