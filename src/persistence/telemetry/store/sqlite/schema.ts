import type { Database } from "bun:sqlite";

export function ensureTelemetrySchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS request_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    surface TEXT NOT NULL,
    provider TEXT,
    model TEXT NOT NULL,
    status INTEGER NOT NULL,
    error_kind TEXT,
    error_provider_code TEXT,
    error_provider_type TEXT,
    error_upstream_request_id TEXT,
    error_retry_after_ms INTEGER,
    client_ip TEXT,
    api_key_id TEXT,
    api_key_prefix TEXT,
    meta_json TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_tokens INTEGER,
    total_tokens INTEGER,
    tffb_ms INTEGER,
    tfft_ms INTEGER,
    message_count INTEGER,
    tool_count INTEGER,
    image_count INTEGER,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.run("CREATE INDEX IF NOT EXISTS idx_request_events_trace_id ON request_events(trace_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_request_events_created_at ON request_events(created_at)");
  db.run("CREATE INDEX IF NOT EXISTS idx_request_events_provider_created ON request_events(provider, created_at)");
  db.run("CREATE INDEX IF NOT EXISTS idx_request_events_status ON request_events(status)");
  // Additional indexes for dashboard aggregation paths: trace_id, created_at, provider, model, api_key_id, and console-log access
  db.run("CREATE INDEX IF NOT EXISTS idx_request_events_model_created ON request_events(model, created_at)");
  db.run("CREATE INDEX IF NOT EXISTS idx_request_events_provider ON request_events(provider)");
  db.run("CREATE INDEX IF NOT EXISTS idx_request_events_model ON request_events(model)");
  db.run("CREATE INDEX IF NOT EXISTS idx_request_events_api_key_id ON request_events(api_key_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_request_events_client_ip_created ON request_events(client_ip, created_at)");
  // Payloads for bounded debug capture (16 KiB per artifact, PII redacted)
  db.run(`CREATE TABLE IF NOT EXISTS request_payloads (
    request_id TEXT PRIMARY KEY,
    client_request TEXT,
    provider_request TEXT,
    provider_response TEXT,
    client_response TEXT,
    client_request_meta TEXT,
    provider_request_meta TEXT,
    provider_response_meta TEXT,
    client_response_meta TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS idx_request_payloads_updated_at ON request_payloads(updated_at)");
  // Console logs (bounded, 10k cap via retention)
  db.run(`CREATE TABLE IF NOT EXISTS console_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    level TEXT NOT NULL,
    scope TEXT NOT NULL,
    msg TEXT NOT NULL,
    context_json TEXT
  )`);
  db.run("CREATE INDEX IF NOT EXISTS idx_console_logs_ts ON console_logs(ts)");
  db.run("CREATE INDEX IF NOT EXISTS idx_console_logs_scope_ts ON console_logs(scope, ts)");
  db.run("CREATE INDEX IF NOT EXISTS idx_console_logs_scope_id ON console_logs(scope, id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_console_logs_id_desc ON console_logs(id DESC)");
  db.run("CREATE INDEX IF NOT EXISTS idx_console_logs_level_ts ON console_logs(level, ts)");
  // Migrate existing DBs: add new columns if missing (idempotent)
  const addColumn = (sql: string): void => { try { db.run(sql); } catch { /* column exists */ } };
  addColumn("ALTER TABLE request_events ADD COLUMN tffb_ms INTEGER");
  addColumn("ALTER TABLE request_events ADD COLUMN tfft_ms INTEGER");
  addColumn("ALTER TABLE request_events ADD COLUMN message_count INTEGER");
  addColumn("ALTER TABLE request_events ADD COLUMN tool_count INTEGER");
  addColumn("ALTER TABLE request_events ADD COLUMN image_count INTEGER");
  addColumn("ALTER TABLE request_events ADD COLUMN started_at TEXT");
  addColumn("ALTER TABLE request_events ADD COLUMN finished_at TEXT");
  addColumn("ALTER TABLE request_events ADD COLUMN api_key_id TEXT");
  addColumn("ALTER TABLE request_events ADD COLUMN api_key_prefix TEXT");
  addColumn("ALTER TABLE request_events ADD COLUMN error_provider_code TEXT");
  addColumn("ALTER TABLE request_events ADD COLUMN error_provider_type TEXT");
  addColumn("ALTER TABLE request_events ADD COLUMN error_upstream_request_id TEXT");
  addColumn("ALTER TABLE request_events ADD COLUMN error_retry_after_ms INTEGER");
  addColumn("ALTER TABLE request_events ADD COLUMN account_id TEXT");
  addColumn("ALTER TABLE request_events ADD COLUMN proxy_id TEXT");
  addColumn("ALTER TABLE request_events ADD COLUMN reasoning_tokens INTEGER");
  addColumn("ALTER TABLE console_logs ADD COLUMN context_json TEXT");
  db.run("CREATE INDEX IF NOT EXISTS idx_request_events_provider_code ON request_events(error_provider_code)");
  db.run("CREATE INDEX IF NOT EXISTS idx_request_events_api_key_created ON request_events(api_key_id, created_at)");
  db.run("CREATE INDEX IF NOT EXISTS idx_request_events_account_id ON request_events(account_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_request_events_proxy_id ON request_events(proxy_id)");
}
