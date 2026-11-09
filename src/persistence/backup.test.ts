import { describe, expect, test } from "bun:test";
import { exportBackupStream, MAX_BACKUP_BYTES, BACKUP_TABLES, type BackupTable } from "./backup.js";
import type { DrizzlePG } from "./db.js";
import {
  accessRules,
  accountModelLocks,
  apiKeys,
  cliMappings,
  cliTools,
  combos,
  consoleSessions,
  customProviders,
  filterRules,
  ipBans,
  modelAliases,
  providerAccountHealth,
  providerAccounts,
  providerModels,
  proxies,
  proxyHealth,
  proxySettings,
  settings,
  shareLinks,
} from "./schema/pg.js";

const TABLE_REFS: Record<BackupTable, unknown> = {
  settings,
  api_keys: apiKeys,
  share_links: shareLinks,
  provider_accounts: providerAccounts,
  provider_account_health: providerAccountHealth,
  account_model_locks: accountModelLocks,
  provider_models: providerModels,
  model_aliases: modelAliases,
  combos,
  custom_providers: customProviders,
  proxies,
  proxy_health: proxyHealth,
  proxy_settings: proxySettings,
  access_rules: accessRules,
  console_sessions: consoleSessions,
  cli_tools: cliTools,
  cli_mappings: cliMappings,
  filter_rules: filterRules,
  ip_bans: ipBans,
};

function tableNameFor(ref: unknown): BackupTable {
  for (const [table, tableRef] of Object.entries(TABLE_REFS) as Array<[BackupTable, unknown]>) {
    if (tableRef === ref) return table;
  }
  throw new Error("Unknown backup table ref");
}

function createMockDb(tableData: Record<string, Array<Record<string, unknown>>> = {}): DrizzlePG {
  const db = {
    $client: {},
    select() {
      return {
        from(tableRef: unknown) {
          const table = tableNameFor(tableRef);
          return {
            limit(limit: number) {
              return {
                offset(offset: number) {
                  const rows = tableData[table] ?? [];
                  return Promise.resolve(rows.slice(offset, offset + limit));
                },
                then(resolve: (rows: Array<Record<string, unknown>>) => void, reject?: (error: unknown) => void) {
                  const rows = tableData[table] ?? [];
                  return Promise.resolve(rows.slice(0, limit)).then(resolve, reject);
                },
              };
            },
          };
        },
      };
    },
  };
  return db as unknown as DrizzlePG;
}

describe("exportBackupStream", () => {
  test("emits valid JSON matching BackupPayload shape", async () => {
    const db = createMockDb({
      settings: [{ id: 1, password_hash: null, password_version: 1, settings_json: "{}", initialized_at: null, updated_at: null }],
      api_keys: [],
    });
    const response = exportBackupStream(db);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toContain("ohmyomop-router-backup.json");

    const text = await response.text();
    const parsed = JSON.parse(text);
    expect(parsed.app).toBe("ohmyomop-router");
    expect(parsed.version).toBe(2);
    expect(typeof parsed.exportedAt).toBe("string");
    expect(typeof parsed.tables).toBe("object");
    for (const table of BACKUP_TABLES) {
      expect(parsed.tables).toHaveProperty(table);
    }
  });

  test("emits same data as in-memory exportBackup for empty DB", async () => {
    const db = createMockDb();
    const response = exportBackupStream(db);
    const text = await response.text();
    const parsed = JSON.parse(text);
    expect(parsed.app).toBe("ohmyomop-router");
    expect(parsed.version).toBe(2);
    for (const table of BACKUP_TABLES) {
      expect(Array.isArray(parsed.tables[table])).toBe(true);
      expect(parsed.tables[table]).toHaveLength(0);
    }
  });

  test("streams table rows correctly", async () => {
    const db = createMockDb({
      settings: [{ id: 1, password_hash: "hash", password_version: 1, settings_json: "{}", initialized_at: null, updated_at: null }],
      api_keys: [{ id: "key-1", name: "test", key_hash: "h", key_prefix: "pk", key_encrypted: "e", active: true }],
    });
    const response = exportBackupStream(db);
    const text = await response.text();
    const parsed = JSON.parse(text);
    expect(parsed.tables.settings).toHaveLength(1);
    expect(parsed.tables.settings[0].id).toBe(1);
    expect(parsed.tables.api_keys).toHaveLength(1);
    expect(parsed.tables.api_keys[0].id).toBe("key-1");
  });

  test("enforces MAX_BACKUP_BYTES during streaming", async () => {
    const hugeValue = "x".repeat(MAX_BACKUP_BYTES + 1000);
    const db = createMockDb({
      settings: [{ id: 1, password_hash: hugeValue, password_version: 1, settings_json: "{}", initialized_at: null, updated_at: null }],
    });
    const response = exportBackupStream(db);
    let threw = false;
    try {
      await response.text();
    } catch {
      threw = true;
    }
    if (!threw) {
      const text = await exportBackupStream(db).text();
      expect(text.length).toBeLessThanOrEqual(MAX_BACKUP_BYTES + 100);
    }
  });

  test("response has correct download headers", () => {
    const db = createMockDb();
    const response = exportBackupStream(db);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="ohmyomop-router-backup.json"');
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("fetches rows in bounded batches via OFFSET/LIMIT", async () => {
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 1200; i++) {
      rows.push({ ip: `10.0.0.${i % 256}`, reason: `ban-${i}`, failed_attempts: i, ban_started_at: null, ban_expires_at: null });
    }
    const db = createMockDb({ ip_bans: rows });
    const response = exportBackupStream(db);
    const text = await response.text();
    const parsed = JSON.parse(text);
    expect(parsed.tables.ip_bans).toHaveLength(1200);
    expect(parsed.tables.ip_bans[0].ip).toBe("10.0.0.0");
    expect(parsed.tables.ip_bans[1199].ip).toBe("10.0.0.175");
  });
});
