import type { PostgresPool } from "../../persistence/pool.js";
import { exportBackup, exportBackupStream, validateRestorePayload, applyRestore } from "../../persistence/backup.js";
import type { TelemetryPipeline } from "../../persistence/telemetry/pipeline.js";

/**
 * Backup console service — verbatim from bootstrap 977-997.
 */
export function createBackupService(pool: PostgresPool, telemetry?: TelemetryPipeline) {
  return {
    async export(options?: { includeHistory?: boolean }) {
      if (options?.includeHistory && !telemetry) return { ok: false as const, status: 503 as const, message: "telemetry unavailable for history export" };
      return exportBackup(pool, { telemetry, includeHistory: options?.includeHistory });
    },
    exportStream(options?: { includeHistory?: boolean }): Response | { ok: false; status: number; message: string } {
      if (options?.includeHistory && !telemetry) return { ok: false as const, status: 503 as const, message: "telemetry unavailable for history export" };
      return exportBackupStream(pool, { telemetry, includeHistory: options?.includeHistory });
    },
    async import(body: unknown) {
      const validation = validateRestorePayload(body);
      if (!validation.ok) return { ok: false, status: 400, message: validation.error ?? "invalid backup" };
      if ((validation as unknown as { history?: unknown }).history !== undefined && !telemetry) return { ok: false, status: 503, message: "telemetry unavailable for history restore" };
      const result = await applyRestore(pool, validation as Extract<typeof validation, { ok: true }>, { telemetry });
      return { ok: true, status: 200, data: result };
    },
    async verifyPassword(request: Request, input?: unknown) {
      let body: Record<string, unknown> = typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {};
      if (Object.keys(body).length === 0) {
        try { body = (await request.json()) as Record<string, unknown>; } catch {}
      }
      const password = String(body.password ?? "");
      const rows = (await pool`SELECT password_hash FROM settings WHERE id = 1`) as unknown as Array<{ password_hash: string | null }>;
      const hash = rows[0]?.password_hash ?? null;
      if (!hash) return { ok: false, status: 401, message: "not initialized" };
      const ok = await Bun.password.verify(password, hash);
      return ok ? { ok: true, status: 200, data: {} } : { ok: false, status: 401, message: "invalid password" };
    },
  };
}
