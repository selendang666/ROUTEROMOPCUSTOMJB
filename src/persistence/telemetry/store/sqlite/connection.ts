import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

/**
 * Creates a tuned SQLite database for high-throughput telemetry.
 * WAL + NORMAL + bounded configurable cache + busy_timeout avoids writer starvation
 * when dashboards read concurrently under 100k+ rows.
 * Async mkdir avoids blocking the event loop at startup; callers should
 * await this before first write and start it in parallel with migrations.
 */
export async function createTunedDatabase(path: string): Promise<Database> {
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  const requestedCacheMb = Number(Bun.env.OHMYOMOP_ROUTER_TELEMETRY_CACHE_MB);
  const cacheMb = Number.isFinite(requestedCacheMb)
    ? Math.min(Math.max(Math.floor(requestedCacheMb), 4), 256)
    : 32;
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=NORMAL");
  db.run(`PRAGMA cache_size=-${cacheMb * 1024}`);
  db.run("PRAGMA temp_store=FILE");
  db.run("PRAGMA wal_autocheckpoint=1000");
  db.run("PRAGMA journal_size_limit=67108864");
  db.run("PRAGMA busy_timeout=5000");
  db.run("PRAGMA auto_vacuum=INCREMENTAL");
  return db;
}
