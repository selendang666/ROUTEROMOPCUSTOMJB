CREATE TABLE IF NOT EXISTS cli_tools (
  tool_id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cli_mappings (
  tool_id text NOT NULL,
  slot_key text NOT NULL,
  source_model text NOT NULL,
  target_model text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tool_id, slot_key)
);
CREATE INDEX IF NOT EXISTS idx_cli_mappings_source ON cli_mappings(tool_id, source_model);
