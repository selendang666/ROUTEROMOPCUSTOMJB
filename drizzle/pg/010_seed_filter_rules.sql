INSERT INTO filter_rules (rule_id, pattern, replacement, is_active, is_regex, sort_order)
VALUES
  ('strip_think_tags', '<think>[\s\S]*?</think>', '', true, true, 10),
  ('strip_reasoning_tags', '<reasoning>[\s\S]*?</reasoning>', '', true, true, 20),
  ('strip_identity_hint', '(?i)You are (Claude|Meta AI|ChatGPT|Gemini)[^.]*\.', '', true, true, 30)
ON CONFLICT (rule_id) DO NOTHING;
