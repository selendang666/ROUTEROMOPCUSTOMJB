UPDATE filter_rules
SET pattern = 'Anthropic''?s official (?:CLI|tool|agent)[^.]*\.?',
    updated_at = now()
WHERE rule_id = 'remove_anthropic_cli_ref';
