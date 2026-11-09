CREATE OR REPLACE FUNCTION ohmyomop_router_api_key_acl_jsonb(value text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  parsed jsonb;
  items text[];
BEGIN
  IF value IS NULL OR btrim(value) = '' THEN
    RETURN NULL;
  END IF;

  BEGIN
    parsed := value::jsonb;
    IF jsonb_typeof(parsed) = 'array' THEN
      RETURN NULLIF(parsed, '[]'::jsonb);
    END IF;
  EXCEPTION WHEN invalid_text_representation THEN
    NULL;
  END;

  SELECT array_agg(trimmed)
  INTO items
  FROM (
    SELECT btrim(item) AS trimmed
    FROM unnest(string_to_array(value, ',')) AS item
  ) AS split
  WHERE trimmed <> '';

  RETURN CASE WHEN items IS NULL THEN NULL ELSE to_jsonb(items) END;
END;
$$;

ALTER TABLE api_keys
  ALTER COLUMN provider_allowlist TYPE jsonb USING ohmyomop_router_api_key_acl_jsonb(provider_allowlist),
  ALTER COLUMN model_allowlist TYPE jsonb USING ohmyomop_router_api_key_acl_jsonb(model_allowlist),
  ALTER COLUMN model_denylist TYPE jsonb USING ohmyomop_router_api_key_acl_jsonb(model_denylist);

DROP FUNCTION ohmyomop_router_api_key_acl_jsonb(text);

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS notes_title text,
  ADD COLUMN IF NOT EXISTS notes_subtitle text,
  ADD COLUMN IF NOT EXISTS notes_body text,
  ADD COLUMN IF NOT EXISTS key_encrypted text;