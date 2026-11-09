import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { PostgresPool } from "./pool.js";
import { createPostgresPool, getPool } from "./pool.js";
import type { MigrationRecord, MigrationStatus } from "./types.js";

const MIGRATIONS_DIR = join(import.meta.dir, "../../drizzle/pg");

const ADVISORY_LOCK_ID = 727727;

function parseVersion(tag: string): number | null {
  const m = tag.match(/^(\d+)_/);
  return m ? Number(m[1]) : null;
}

interface DrizzleJournal {
  readonly entries: readonly DrizzleJournalEntry[];
}

interface DrizzleJournalEntry {
  readonly tag: string;
}

interface RuntimeMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

function parseJournal(value: unknown): DrizzleJournal {
  if (typeof value !== "object" || value === null || !("entries" in value)) throw new Error("Invalid Drizzle migration journal");
  const entries = (value as { readonly entries: unknown }).entries;
  if (!Array.isArray(entries)) throw new Error("Invalid Drizzle migration journal entries");
  return {
    entries: entries.map((entry) => {
      if (typeof entry !== "object" || entry === null || !("tag" in entry) || typeof (entry as { readonly tag: unknown }).tag !== "string") {
        throw new Error("Invalid Drizzle migration journal entry");
      }
      return { tag: (entry as { readonly tag: string }).tag };
    }),
  };
}

async function loadDrizzleMigrations(dir = MIGRATIONS_DIR): Promise<RuntimeMigration[]> {
  const [journalText, drizzleMigrations] = await Promise.all([
    readFile(join(dir, "meta", "_journal.json"), "utf8"),
    Promise.resolve(readMigrationFiles({ migrationsFolder: dir })),
  ]);
  const journal = parseJournal(JSON.parse(journalText) as unknown);
  if (journal.entries.length !== drizzleMigrations.length) {
    throw new Error(`Drizzle migration journal mismatch: ${journal.entries.length} entries, ${drizzleMigrations.length} files`);
  }
  const out: RuntimeMigration[] = [];
  for (let i = 0; i < journal.entries.length; i++) {
    const entry = journal.entries[i]!;
    const migration = drizzleMigrations[i]!;
    const version = parseVersion(entry.tag);
    const name = `${entry.tag}.sql`;
    if (version === null) throw new Error(`Invalid migration filename: ${name}`);
    const sql = migration.sql.join("\n--> statement-breakpoint\n");
    if (!sql.trim()) throw new Error(`Empty migration: ${name}`);
    out.push({ version, name, sql, checksum: migration.hash });
  }
  out.sort((a, b) => a.version - b.version);
  for (let i = 0; i < out.length; i++) {
    const expected = i + 1;
    if (out[i]!.version !== expected) throw new Error(`Migration gap: expected version ${expected}, got ${out[i]!.version} (${out[i]!.name})`);
  }
  return out;
}

async function ensureMigrationsTable(pool: PostgresPool): Promise<void> {
  await pool`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
}

export type { MigrationRecord, MigrationStatus };

export async function getMigrationStatus(pool?: PostgresPool): Promise<MigrationStatus> {
  const p = pool ?? getPool();
  const files = await loadDrizzleMigrations();
  await ensureMigrationsTable(p);
  const rows = await p`SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version` as unknown as Array<{ version: number; name: string; checksum: string; applied_at: string }>;
  const applied: MigrationRecord[] = rows.map((r) => ({ version: r.version, name: r.name, checksum: r.checksum, appliedAt: String(r.applied_at) }));
  const appliedMap = new Map(applied.map((a) => [a.version, a]));
  const pending: RuntimeMigration[] = [];
  let error: string | undefined;
  for (const f of files) {
    const existing = appliedMap.get(f.version);
    if (!existing) { pending.push(f); continue; }
    if (existing.checksum !== f.checksum || existing.name !== f.name) {
      error = `Checksum/name mismatch for version ${f.version}: expected ${f.name} ${f.checksum}, got ${existing.name} ${existing.checksum}`;
    }
  }
  // Extra applied not in files = partially applied/out-of-order
  for (const a of applied) {
    if (!files.some((f) => f.version === a.version)) error = `Applied migration ${a.version} (${a.name}) not found in files`;
  }
  const currentVersion = applied.length ? Math.max(...applied.map((a) => a.version)) : null;
  const expectedVersion = files.length ? files[files.length - 1]!.version : 0;
  const ok = !error && pending.length === 0 && currentVersion === expectedVersion;
  const statusError = error ?? (pending.length ? `Pending migrations: ${pending.map((x) => x.name).join(", ")}` : undefined);
  return { currentVersion, expectedVersion, applied, pending: pending.map((x) => ({ version: x.version, name: x.name, checksum: x.checksum })), ok: pending.length === 0 && !error, error: ok ? undefined : statusError };
}

export interface MigrationResult { readonly applied: number; readonly currentVersion: number; }

export async function runMigrations(pool?: PostgresPool): Promise<MigrationResult> {
  const p = pool ?? getPool();
  const files = await loadDrizzleMigrations();
  await ensureMigrationsTable(p);
  // Advisory lock — prevents concurrent migration runs across instances.
  await p`SELECT pg_advisory_lock(${ADVISORY_LOCK_ID})`;
  try {
    const rows = await p`SELECT version, name, checksum FROM schema_migrations ORDER BY version` as unknown as Array<{ version: number; name: string; checksum: string }>;
    const appliedMap = new Map(rows.map((r) => [r.version, r]));
    // Validate existing checksums fail closed.
    for (const f of files) {
      const existing = appliedMap.get(f.version);
      if (existing && (existing.checksum !== f.checksum || existing.name !== f.name)) {
        throw new Error(`Migration ${f.version} checksum/name mismatch — refusing to continue. Expected ${f.name} ${f.checksum}, found ${existing.name} ${existing.checksum}`);
      }
    }
    // Detect extra applied (partial/out-of-order)
    for (const r of rows) {
      if (!files.some((f) => f.version === r.version)) throw new Error(`Database has extra migration version ${r.version} (${r.name}) not in files — failing closed`);
    }
    // Detect missing earlier file (gap)
    const maxApplied = rows.length ? Math.max(...rows.map((r) => r.version)) : 0;
    for (const f of files) {
      if (f.version <= maxApplied && !appliedMap.has(f.version)) throw new Error(`Missing migration ${f.version} (${f.name}) — failing closed`);
    }
    let appliedCount = 0;
    for (const f of files) {
      if (appliedMap.has(f.version)) continue;
      // Each migration in its own transaction.
      await p.begin(async (tx: PostgresPool) => {
        await tx.unsafe(f.sql);
        await tx`INSERT INTO schema_migrations (version, name, checksum) VALUES (${f.version}, ${f.name}, ${f.checksum})`;
      });
      appliedCount++;
    }
    const currentVersion = files.length ? files[files.length - 1]!.version : 0;
    return { applied: appliedCount, currentVersion };
  } finally {
    try { await p`SELECT pg_advisory_unlock(${ADVISORY_LOCK_ID})`; } catch {}
  }
}

// CLI entry for migration application or status inspection.
if (import.meta.main) {
  (async () => {
    try {
      const pool = createPostgresPool();
      if (process.argv.includes("--status")) {
        const status = await getMigrationStatus(pool);
        console.log(JSON.stringify(status));
        await pool.close();
        process.exit(status.ok ? 0 : 1);
      }
      const result = await runMigrations(pool);
      console.log(`Migrations ok — current version ${result.currentVersion}, applied ${result.applied}`);
      await pool.close();
      process.exit(0);
    } catch (e) {
      console.error(`Migration failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  })();
}
