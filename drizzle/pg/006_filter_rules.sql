CREATE TABLE IF NOT EXISTS filter_rules (
  id serial PRIMARY KEY,
  rule_id text NOT NULL UNIQUE,
  pattern text NOT NULL,
  replacement text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  is_regex boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_filter_rules_sort ON filter_rules(sort_order, id);
