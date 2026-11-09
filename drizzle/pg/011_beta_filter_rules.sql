-- Replace placeholder think tags with real Oh My Omop - Router 20-beta defaults (14 pudidil rules)
DELETE FROM filter_rules WHERE rule_id IN ('strip_think_tags','strip_reasoning_tags','strip_identity_hint');

INSERT INTO filter_rules (rule_id, pattern, replacement, is_active, is_regex, sort_order) VALUES
  ('remove_billing_header', 'x-(?:anthropic-)?billing-header:?\s*[^\n]*', '', true, true, 10),
  ('remove_cc_entrypoint', 'cc_entrypoint=\w+', '', true, true, 20),
  ('remove_cc_version', 'cc_version=[\w.]+', '', true, true, 30),
  ('remove_cch_hash', 'c?ch=[a-f0-9]+', '', true, true, 40),
  ('remove_claude_code_github_url', 'https?://github\.com/anthropics/claude-code[^\s]*', '', true, true, 50),
  ('remove_claude_code_identity', 'You are Claude Code[^.]*\.', '', true, true, 60),
  ('remove_anthropic_cli_ref', 'Anthropic''s official (?:CLI|tool|agent)[^.]*\.?', '', true, true, 70),
  ('remove_cursor_identity', 'You are (?:a )?(?:powerful )?(?:AI )?(?:assistant|agent) (?:made|built|created) by (?:Cursor|Anysphere)[^.]*\.?', '', true, true, 80),
  ('remove_windsurf_identity', 'You are (?:Windsurf|Cascade|Codeium)[^.]*\.', '', true, true, 90),
  ('remove_cline_identity', 'You are Cline[^.]*\.', '', true, true, 100),
  ('remove_ai_coding_agent', '(?:autonomous|agentic) (?:AI |coding )?(?:agent|assistant)[^.]*\.', '', true, true, 110),
  ('remove_mcp_server_ref', 'MCP (?:server|client|protocol)[^.]*\.?', '', true, true, 120),
  ('remove_powered_by_anthropic', 'powered by (?:Claude|Anthropic)[^.]*\.?', '', true, true, 130),
  ('replace_claude_code_mention', 'Claude Code', 'the assistant', true, false, 140)
ON CONFLICT (rule_id) DO NOTHING;
