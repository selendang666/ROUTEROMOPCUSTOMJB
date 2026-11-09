import type { ApiKeyPort, ApiKeyRecord } from "../api/guard.js";
import { getMontanaConfigRuntime, type MontanaConfigRuntime } from "../runtime/montana-config.js";

export function createMontanaApiKeyPort(database: ApiKeyPort, runtime: MontanaConfigRuntime | null = getMontanaConfigRuntime()): ApiKeyPort {
  if (runtime === null) return database;
  return {
    get missingAuthMessage(): string | undefined {
      return runtime.snapshot().keys === null ? undefined : "Invalid API key";
    },
    async getBySecret(secret: string): Promise<ApiKeyRecord | null> {
      if (runtime.snapshot().keys !== null) {
        const match = runtime.findKey(secret);
        if (match !== null) {
          const key = match.key;
          if (key.expires !== undefined && Date.parse(key.expires) <= Date.now()) return { id: key.id, active: false, revokedAt: null, montanaFailure: "expired" };
          if (key.used >= key.quota) return { id: key.id, active: false, revokedAt: null, montanaFailure: "quota" };
          return { id: key.id, active: true, revokedAt: null };
        }
      }
      const record = await database.getBySecret(secret);
      return record ?? (runtime.snapshot().keys === null ? null : { id: "", active: false, revokedAt: null, montanaFailure: "invalid" });
    },
    async touch(id: string): Promise<void> {
      if (runtime.findKeyById(id) !== null) return;
      await database.touch(id);
    },
  };
}
