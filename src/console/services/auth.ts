import { createHash } from "node:crypto";
import type { PostgresPool } from "../../persistence/pool.js";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  const parts = header.split(";");
  for (const part of parts) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

const PLACEHOLDER_PATTERN_AUTH = /(?:^|[^a-z0-9])(?:change-me|replace-with|password)/i;

/**
 * Session + auth + setup console services — verbatim from bootstrap 498-611.
 * Includes IP bruteforce constants and cookie verification.
 */
export function createAuthServices(
  pool: PostgresPool,
  ipBanRepo: { recordFailure(ip: string, opts: { maxFailures: number; banDurationMs: number; reason?: string }): Promise<unknown> },
  clientIpForBan: (request: Request) => string | null,
) {
  const BRUTEFORCE_MAX_FAILURES = 10;
  const BRUTEFORCE_BAN_DURATION_MS = 6 * 60 * 60 * 1000;

  const session = {
    async verify(request: Request) {
      const raw = readCookie(request, "ohmyomop_router_console");
      if (!raw) return null;
      const tokenHash = sha256Hex(raw);
      const rows = (await pool`SELECT id, token_hash, expires_at, revoked_at FROM console_sessions WHERE token_hash = ${tokenHash}`) as unknown as Array<{ id: string; expires_at: string | null; revoked_at: string | null }>;
      const row = rows[0];
      if (!row) return null;
      if (row.revoked_at !== null) return null;
      if (row.expires_at !== null && new Date(row.expires_at).getTime() <= Date.now()) return null;
      return { id: row.id };
    },
  };

  const auth = {
    async login(request: Request) {
      let body: Record<string, unknown> = {};
      try { body = (await request.json()) as Record<string, unknown>; } catch {}
      const password = typeof body.password === "string" ? body.password : typeof body.currentPassword === "string" ? body.currentPassword : "";
      const rows = (await pool`SELECT password_hash FROM settings WHERE id = 1`) as unknown as Array<{ password_hash: string | null }>;
      const hash = rows[0]?.password_hash ?? null;
      if (!hash) return { ok: false, status: 401, message: "console not initialized" };
      const ok = await Bun.password.verify(password, hash);
      if (!ok) {
        const sourceIp = clientIpForBan(request);
        if (sourceIp) {
          await ipBanRepo
            .recordFailure(sourceIp, { maxFailures: BRUTEFORCE_MAX_FAILURES, banDurationMs: BRUTEFORCE_BAN_DURATION_MS, reason: "failed_login" })
            .catch(() => undefined);
        }
        return { ok: false, status: 401, message: "invalid password" };
      }
      const token = crypto.randomUUID() + "-" + crypto.randomUUID();
      const tokenHash = sha256Hex(token);
      const id = crypto.randomUUID();
      await pool`INSERT INTO console_sessions (id, token_hash, data, expires_at) VALUES (${id}, ${tokenHash}, ${{ createdAt: new Date().toISOString() }}::jsonb, ${(new Date(Date.now() + 7 * 24 * 3600 * 1000)).toISOString()}::timestamptz)`;
      return { ok: true, status: 200, data: { token, id } };
    },
    async logout(request: Request) {
      const raw = readCookie(request, "ohmyomop_router_console");
      if (raw) {
        const tokenHash = sha256Hex(raw);
        await pool`UPDATE console_sessions SET revoked_at = now() WHERE token_hash = ${tokenHash}`;
      }
      return { ok: true, status: 200, data: {} };
    },
    async session(request: Request) {
      const verified = await session.verify(request);
      if (!verified) return { ok: false, status: 401, message: "unauthenticated" };
      return { ok: true, status: 200, data: verified };
    },
    async changePassword(currentPassword: unknown, newPassword: unknown, confirmPassword: unknown, request?: Request) {
      if (typeof newPassword !== "string" || typeof confirmPassword !== "string" || newPassword !== confirmPassword) {
        return { ok: false, status: 400, message: "password confirmation mismatch" };
      }
      if (newPassword.length < 8) {
        return { ok: false, status: 400, message: "password must be at least 8 characters" };
      }
      if (PLACEHOLDER_PATTERN_AUTH.test(newPassword)) {
        return { ok: false, status: 400, message: "password must not be a placeholder value" };
      }
      const rows = (await pool`SELECT password_hash FROM settings WHERE id = 1`) as unknown as Array<{ password_hash: string | null }>;
      const hash = rows[0]?.password_hash ?? null;
      if (!hash) {
        return { ok: false, status: 409, message: "console not initialized" };
      }
      if (typeof currentPassword !== "string" || currentPassword.length === 0) {
        if (request) {
          const sourceIp = clientIpForBan(request);
          if (sourceIp) {
            await ipBanRepo
              .recordFailure(sourceIp, { maxFailures: BRUTEFORCE_MAX_FAILURES, banDurationMs: BRUTEFORCE_BAN_DURATION_MS, reason: "failed_change_password" })
              .catch(() => undefined);
          }
        }
        return { ok: false, status: 401, message: "current password required" };
      }
      const ok = await Bun.password.verify(currentPassword, hash);
      if (!ok) {
        if (request) {
          const sourceIp = clientIpForBan(request);
          if (sourceIp) {
            await ipBanRepo
              .recordFailure(sourceIp, { maxFailures: BRUTEFORCE_MAX_FAILURES, banDurationMs: BRUTEFORCE_BAN_DURATION_MS, reason: "failed_change_password" })
              .catch(() => undefined);
          }
        }
        return { ok: false, status: 401, message: "current password incorrect" };
      }
      const nextHash = await Bun.password.hash(newPassword as string, { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 });
      await pool`UPDATE settings SET password_hash = ${nextHash}, password_version = password_version + 1, updated_at = now() WHERE id = 1`;
      await pool`UPDATE console_sessions SET revoked_at = now() WHERE revoked_at IS NULL`;
      return { ok: true, status: 200, message: "password updated" };
    },
  };

  const setup = {
    async status() {
      const rows = (await pool`SELECT password_hash FROM settings WHERE id = 1`) as unknown as Array<{ password_hash: string | null }>;
      const hash = rows[0]?.password_hash ?? null;
      return { initialized: Boolean(hash) };
    },
    async setup(request: Request) {
      const rows = (await pool`SELECT password_hash FROM settings WHERE id = 1`) as unknown as Array<{ password_hash: string | null }>;
      const hash = rows[0]?.password_hash ?? null;
      if (hash) return { ok: false, status: 409, message: "console already initialized" };
      let body: Record<string, unknown> = {};
      try { body = (await request.json()) as Record<string, unknown>; } catch {}
      const password = typeof body.password === "string" ? body.password : "";
      const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : typeof body.confirm === "string" ? body.confirm : "";
      if (!password || !confirmPassword) return { ok: false, status: 400, message: "password and confirmPassword required" };
      if (password !== confirmPassword) return { ok: false, status: 400, message: "password confirmation mismatch" };
      if (password.length < 8) return { ok: false, status: 400, message: "password must be at least 8 characters" };
      const nextHash = await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 });
      await pool`UPDATE settings SET password_hash = ${nextHash}, password_version = 1, updated_at = now() WHERE id = 1`;
      const token = crypto.randomUUID() + "-" + crypto.randomUUID();
      const tokenHash = sha256Hex(token);
      const id = crypto.randomUUID();
      await pool`INSERT INTO console_sessions (id, token_hash, data, expires_at) VALUES (${id}, ${tokenHash}, ${{ createdAt: new Date().toISOString(), role: "admin" }}::jsonb, ${(new Date(Date.now() + 7 * 24 * 3600 * 1000)).toISOString()}::timestamptz)`;
      return { ok: true, status: 201, data: { token, id, role: "admin" } };
    },
  };

  return { session, auth, setup };
}
