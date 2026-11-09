-- 017_add_tffb_ms.sql — add time to first byte for telemetry
ALTER TABLE request_events ADD COLUMN IF NOT EXISTS tffb_ms integer;
