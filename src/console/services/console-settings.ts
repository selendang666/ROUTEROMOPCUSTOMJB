import type { PostgresPool } from "../../persistence/pool.js";

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function mergeObject(base: Record<string, unknown>, patch: unknown): Record<string, unknown> {
  const update = recordOf(patch);
  return update === null ? base : { ...base, ...update };
}

function proxySettingsOf(row: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    enabled: row?.enabled === true,
    excludedProviders: Array.isArray(row?.excluded_providers_json) ? row.excluded_providers_json : [],
    smartDynamicRouting: row?.smart_dynamic_routing === true,
    smartDynamicProxyCount: Number(row?.smart_dynamic_proxy_count ?? 2),
    routingPreset: String(row?.routing_preset ?? "auto"),
    targetConcurrent: Number(row?.target_concurrent ?? 0),
    webSearchPreference: String(row?.web_search_preference ?? "auto"),
  };
}

/** Reads and patches console settings across their owning PostgreSQL rows. */
export function createSettingsService(pool: PostgresPool, onSettingsMutation?: () => void) {
  const get = async () => {
    const [settingsRows, proxyRows] = await Promise.all([
      pool`SELECT settings_json, password_hash, password_version, updated_at FROM settings WHERE id = 1` as unknown as Promise<Array<{ settings_json: Record<string, unknown> | null; password_hash: string | null; password_version: number; updated_at: string }>>,
      pool`SELECT * FROM proxy_settings WHERE id = 1` as unknown as Promise<Array<Record<string, unknown>>>,
    ]);
    const row = settingsRows[0];
    // Defensive: Bun's SQL driver returns jsonb parameters faithfully by
    // type, so a healthy row is always an object here. Guard anyway in case
    // a row was ever written by the pre-fix code path (which double-encoded
    // this column into a jsonb string scalar).
    const settingsJson = recordOf(row?.settings_json) ?? {};
    return {
      hasPassword: Boolean(row?.password_hash),
      passwordVersion: Number(row?.password_version ?? 1),
      updatedAt: String(row?.updated_at ?? new Date().toISOString()),
      settings_json: settingsJson,
      runtime: recordOf(settingsJson.runtime) ?? {},
      appearance: recordOf(settingsJson.appearance) ?? {},
      proxySettings: proxySettingsOf(proxyRows[0]),
    };
  };

  return {
    get,
    async patch(body: unknown) {
      const patch = recordOf(body);
      if (patch === null) return { ok: false as const, status: 400 as const, message: "settings patch must be an object" };
      const settingsRows = (await pool`SELECT settings_json FROM settings WHERE id = 1`) as unknown as Array<{ settings_json: Record<string, unknown> | null }>;
      const base = recordOf(settingsRows[0]?.settings_json) ?? {};
      const next = {
        ...base,
        runtime: mergeObject(recordOf(base.runtime) ?? {}, patch.runtime),
        appearance: mergeObject(recordOf(base.appearance) ?? {}, patch.appearance),
      };
      // Bun's SQL driver already serializes object parameters for `::jsonb`
      // casts — pre-stringifying here double-encodes the column into a
      // jsonb *string* scalar. Every later patch() then reads that string
      // back, spreads it character-by-character via `...base`, and writes
      // an even bigger encoded string — unbounded, compounding corruption.
      await pool`UPDATE settings SET settings_json = ${next}::jsonb, updated_at = now() WHERE id = 1`;

      const proxy = recordOf(patch.proxySettings);
      if (proxy !== null) {
        const excludedProviders = Array.isArray(proxy.excludedProviders)
          ? proxy.excludedProviders.filter((value): value is string => typeof value === "string")
          : null;
        await pool`
          UPDATE proxy_settings
          SET enabled = COALESCE(${proxy.enabled === undefined ? null : proxy.enabled === true}, enabled),
              excluded_providers_json = COALESCE(${excludedProviders === null ? null : excludedProviders}::jsonb, excluded_providers_json),
              smart_dynamic_routing = COALESCE(${proxy.smartDynamicRouting === undefined ? null : proxy.smartDynamicRouting === true}, smart_dynamic_routing),
              smart_dynamic_proxy_count = COALESCE(${proxy.smartDynamicProxyCount === undefined ? null : Number(proxy.smartDynamicProxyCount)}, smart_dynamic_proxy_count),
              routing_preset = COALESCE(${proxy.routingPreset === undefined ? null : String(proxy.routingPreset)}, routing_preset),
              target_concurrent = COALESCE(${proxy.targetConcurrent === undefined ? null : Number(proxy.targetConcurrent)}, target_concurrent),
              web_search_preference = COALESCE(${proxy.webSearchPreference === undefined ? null : String(proxy.webSearchPreference)}, web_search_preference),
              updated_at = now()
          WHERE id = 1
        `;
      }
      onSettingsMutation?.();
      return get();
    },
    async resetAll(body: unknown) {
      const value = recordOf(body) ?? {};
      const password = typeof value.password === "string" ? value.password : "";
      const confirmation = typeof value.confirmation === "string" ? value.confirmation : "";
      if (confirmation !== "RESET") return { ok: false as const, status: 400 as const, message: 'confirmation must be "RESET"' };
      const rows = (await pool`SELECT password_hash FROM settings WHERE id = 1`) as unknown as Array<{ password_hash: string | null }>;
      if (rows[0]?.password_hash === null || rows[0] === undefined) return { ok: false as const, status: 401 as const, message: "not initialized" };
      if (!await Bun.password.verify(password, rows[0].password_hash)) return { ok: false as const, status: 401 as const, message: "invalid password" };
      await pool`UPDATE settings SET settings_json = '{}'::jsonb, updated_at = now() WHERE id = 1`;
      const tables = ["proxy_health", "proxies", "provider_account_quota", "provider_account_health", "account_model_locks", "provider_accounts", "provider_models", "model_aliases", "combos", "custom_providers", "share_links", "api_keys", "console_sessions", "filter_rules"] as const;
      for (const table of tables) {
        try { await pool.unsafe(`DELETE FROM ${table}`); } catch {}
      }
      onSettingsMutation?.();
      return { ok: true as const, status: 200 as const, data: { reset: true } };
    },
  };
}
