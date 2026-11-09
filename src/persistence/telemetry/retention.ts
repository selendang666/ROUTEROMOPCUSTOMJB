import type { Database } from "bun:sqlite";

const RETENTION_BATCH = 500;
const MAX_CONSOLE_ROWS = 10_000;
const MAX_CHUNKS_PER_RUN = 8;

async function deleteBatched(db: Database, table: string, column: string, cutoff: string): Promise<number> {
  let removed = 0;
  for (let chunk = 0; chunk < MAX_CHUNKS_PER_RUN; chunk++) {
    const res = db.run(`DELETE FROM ${table} WHERE ${column} < ? LIMIT ${RETENTION_BATCH}`, [cutoff]);
    const changes = (res as unknown as { changes: number }).changes ?? 0;
    removed += changes;
    if (changes < RETENTION_BATCH) break;
    await Bun.sleep(0);
  }
  return removed;
}

export interface RetentionOptions {
  readonly logRetentionDays?: number;
  readonly payloadRetentionDays?: number;
}

export interface RetentionResult {
  readonly requestEvents: number;
  readonly payloads: number;
  readonly consoleLogs: number;
  readonly consoleCapped: number;
}

export async function retainTelemetryData(db: Database, options: RetentionOptions = {}): Promise<RetentionResult> {
  const logDays = options.logRetentionDays ?? 30;
  const payloadDays = options.payloadRetentionDays ?? 7;
  const logCutoff = new Date(Date.now() - logDays * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const payloadCutoff = new Date(Date.now() - payloadDays * 86_400_000).toISOString().slice(0, 19).replace("T", " ");

  const requestEvents = await deleteBatched(db, "request_events", "created_at", logCutoff);
  const payloads = await deleteBatched(db, "request_payloads", "updated_at", payloadCutoff);
  const consoleLogs = await deleteBatched(db, "console_logs", "ts", logCutoff);

  // cap console_logs to 10k newest
  const boundary = db.query("SELECT id FROM console_logs ORDER BY id DESC LIMIT 1 OFFSET ?").get(MAX_CONSOLE_ROWS) as { id: number } | null;
  let consoleCapped = 0;
  if (boundary) {
    for (let chunk = 0; chunk < MAX_CHUNKS_PER_RUN; chunk++) {
      const res = db.run("DELETE FROM console_logs WHERE id <= ? LIMIT ?", [boundary.id, RETENTION_BATCH]);
      const changes = (res as unknown as { changes: number }).changes ?? 0;
      consoleCapped += changes;
      if (changes < RETENTION_BATCH) break;
      await Bun.sleep(0);
    }
  }

  return { requestEvents, payloads, consoleLogs, consoleCapped };
}
