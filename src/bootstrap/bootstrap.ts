import type { Elysia } from "elysia";

import { createProxyPort as createProxyPortFromModule } from "./proxy-port.js";
import { createApplication, type ApplicationPorts, type PersistencePorts } from "./application.js";
import { createPostgresPersistence } from "./persistence.js";
import { cancelScheduledGc, getInFlightCount, scheduleGlobalGc } from "../runtime/in-flight.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../runtime/runtime.js";
import { createMontanaConfigRuntime } from "../runtime/montana-config.js";

export interface StartOptions {
  readonly env?: Record<string, string | undefined>;
  readonly createPersistence?: (config: RuntimeConfig) => Promise<PersistencePorts> | PersistencePorts;
  readonly createApplicationPorts?: (persistence: PersistencePorts, config: RuntimeConfig) => Promise<ApplicationPorts> | ApplicationPorts;
}

export async function startServer(options: StartOptions = {}): Promise<{ readonly app: Elysia; readonly stop: () => Promise<void> }> {
  const config = loadRuntimeConfig(options.env);
  const montana = await createMontanaConfigRuntime({ configDir: options.env?.MONTANA_CONFIG_DIR });

  let persistence: PersistencePorts;
  try {
    persistence = options.createPersistence ? await options.createPersistence(config) : await createPostgresPersistence(config);
  } catch (error) {
    await montana.close();
    throw error;
  }

  const appPorts: ApplicationPorts = options.createApplicationPorts
    ? await options.createApplicationPorts(persistence, config)
    : {
        proxy: await createProxyPortFromModule(
          persistence.pool,
          config,
          persistence.registry,
          persistence.telemetry,
          persistence.routeRepositories,
        ),
      };

  const application = createApplication({ config, persistence, application: appPorts });

  // Elysia fetch handler is compatible with Bun.serve — await readiness already ensured via persistence lifecycle.
  const readiness = await persistence.readiness();
  if (!readiness.ok) throw new Error(`persistence not ready: ${readiness.reason ?? "unknown"}`);

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 30,
    fetch: application.app.fetch,
  });
  const gcTimer = config.limits.gcIntervalMs > 0
    ? setInterval(() => scheduleGlobalGc(), config.limits.gcIntervalMs)
    : null;
  gcTimer?.unref();

  console.log(
    `[ohmyomop-router] listening on ${server.url} coordination=${persistence.coordination.kind}${
      persistence.coordination.degraded()
        ? " (degraded: redis configured but unreachable, using local fallback)"
        : ""
    }`,
  );

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (gcTimer !== null) clearInterval(gcTimer);
    cancelScheduledGc();
    server.stop();
    const drainDeadline = Date.now() + 10_000;
    while (getInFlightCount() > 0 && Date.now() < drainDeadline) await Bun.sleep(50);
    try { await persistence.close(); } catch {}
    try { await montana.close(); } catch {}
  };

  const onSignal = (): void => {
    void stop().finally(() => process.exit(0));
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  return { app: application.app, stop };
}
