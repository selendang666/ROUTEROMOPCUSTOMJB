import { readFile, rename, chmod, writeFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

const CONFIG_FILES = new Set(["keys.json", "persona.md", "relays.json", "upstream.json"]);
const MAX_PERSONA_CHARS = 48_000;
const MAX_EXTRA_HEADERS = 64;
const MAX_EXTRA_HEADERS_CHARS = 16_384;
const RESERVED_EXTRA_HEADERS = new Set([
  "accept", "accept-language", "authorization", "connection", "content-length", "content-type", "host", "origin", "referer",
  "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
  "transfer-encoding", "upgrade-insecure-requests", "user-agent", "x-relay-id", "x-relay-secret", "x-upstream-path",
]);

export interface MontanaKeyConfig {
  readonly id: string;
  readonly key: string;
  readonly label?: string;
  readonly quota: number;
  readonly used: number;
  readonly expires?: string;
}

export interface MontanaRelayConfig {
  readonly url: string;
  readonly secret?: string;
}

export interface MontanaUpstreamConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly origin: string;
  readonly modelsDefault: string;
  readonly extraHeaders: Readonly<Record<string, string>>;
  readonly signatureSeed: string;
}

export interface MontanaConfigSnapshot {
  readonly keys: readonly MontanaKeyConfig[] | null;
  readonly persona: string | null;
  readonly relays: readonly MontanaRelayConfig[] | null;
  readonly upstream: MontanaUpstreamConfig | null;
}

export interface MontanaConfigRuntime {
  readonly configDir: string;
  snapshot(): MontanaConfigSnapshot;
  reload(): Promise<void>;
  recordUsage(keyId: string, tokens: number): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  findKey(secret: string): { readonly key: MontanaKeyConfig; readonly secret: string } | null;
  findKeyById(id: string): MontanaKeyConfig | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finiteNonNegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

function normalizeHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("upstream.extra_headers must be an object");
  const raw = JSON.stringify(value);
  if (raw.length > MAX_EXTRA_HEADERS_CHARS) throw new Error("upstream.extra_headers is too large");
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value).slice(0, MAX_EXTRA_HEADERS)) {
    const name = rawName.trim();
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || RESERVED_EXTRA_HEADERS.has(lower)) throw new Error("upstream.extra_headers contains a reserved or invalid header");
    if (typeof rawValue !== "string" || rawValue.length > 8_192 || /[\r\n]/.test(rawValue)) throw new Error("upstream.extra_headers contains an invalid value");
    result[name] = rawValue;
  }
  return Object.freeze(result);
}

export function parseMontanaKeys(value: unknown): readonly MontanaKeyConfig[] {
  const root = record(value);
  if (root === null || !Array.isArray(root.keys)) throw new Error("keys.json must contain a keys array");
  const keys = root.keys.map((entry, index): MontanaKeyConfig => {
    const item = record(entry);
    if (item === null || typeof item.key !== "string" || item.key.length === 0) throw new Error(`keys.json entry ${index} has no key`);
    if (item.label !== undefined && typeof item.label !== "string") throw new Error(`keys.json entry ${index} has an invalid label`);
    if (item.expires !== undefined && (typeof item.expires !== "string" || !Number.isFinite(Date.parse(item.expires)))) throw new Error(`keys.json entry ${index} has an invalid expiry`);
    const quota = finiteNonNegative(item.quota ?? 0, `keys.json entry ${index} quota`);
    const used = finiteNonNegative(item.used ?? 0, `keys.json entry ${index} used`);
    const id = typeof item.id === "string" && item.id.trim().length > 0 ? `montana:${item.id.trim()}` : `montana:${index}`;
    return Object.freeze({
      id,
      key: item.key,
      ...(typeof item.label === "string" ? { label: item.label } : {}),
      quota,
      used: Math.min(used, quota),
      ...(typeof item.expires === "string" ? { expires: item.expires } : {}),
    });
  });
  return Object.freeze(keys);
}

export function parseMontanaRelays(value: unknown): readonly MontanaRelayConfig[] {
  const root = record(value);
  if (root === null || !Array.isArray(root.relays) || root.relays.length === 0) throw new Error("relays.json must contain a non-empty relays array");
  const relays = root.relays.map((entry, index): MontanaRelayConfig => {
    const relay = typeof entry === "string" ? { url: entry } : record(entry);
    if (relay === null || typeof relay.url !== "string") throw new Error(`relay ${index} has no URL`);
    let url: URL;
    try { url = new URL(relay.url); } catch { throw new Error(`relay ${index} has an invalid URL`); }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`relay ${index} must use HTTP or HTTPS`);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error(`relay ${index} must use HTTPS outside local mocks`);
    const secret = relay.secret ?? root.relay_secret;
    if (secret !== undefined && typeof secret !== "string") throw new Error(`relay ${index} has an invalid secret`);
    return Object.freeze({ url: url.toString(), ...(secret === undefined ? {} : { secret }) });
  });
  return Object.freeze(relays);
}

export function parseMontanaUpstream(value: unknown): MontanaUpstreamConfig {
  const root = record(value);
  if (root === null) throw new Error("upstream.json must be an object");
  if (typeof root.base_url !== "string" || root.base_url.length === 0) throw new Error("upstream.json has no base_url");
  if (typeof root.api_key !== "string") throw new Error("upstream.json has no api_key");
  if (typeof root.origin !== "string" || root.origin.length === 0) throw new Error("upstream.json has no origin");
  if (typeof root.models_default !== "string" || root.models_default.length === 0) throw new Error("upstream.json has no models_default");
  let baseUrl: URL;
  let origin: URL;
  try { baseUrl = new URL(root.base_url); origin = new URL(root.origin); } catch { throw new Error("upstream.json has an invalid URL"); }
  if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") throw new Error("upstream.json base_url must use HTTP or HTTPS");
  if (origin.protocol !== "https:" && origin.protocol !== "http:") throw new Error("upstream.json origin must use HTTP or HTTPS");
  if (root.signature_seed !== undefined && typeof root.signature_seed !== "string") throw new Error("upstream.json has an invalid signature_seed");
  return Object.freeze({
    baseUrl: baseUrl.toString().replace(/\/$/, ""),
    apiKey: root.api_key,
    origin: origin.toString().replace(/\/$/, ""),
    modelsDefault: root.models_default,
    extraHeaders: normalizeHeaders(root.extra_headers),
    signatureSeed: root.signature_seed ?? "",
  });
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function loadSnapshot(configDir: string, previous?: MontanaConfigSnapshot): Promise<MontanaConfigSnapshot> {
  const [keysText, personaText, relaysText, upstreamText] = await Promise.all([
    readOptional(join(configDir, "keys.json")),
    readOptional(join(configDir, "persona.md")),
    readOptional(join(configDir, "relays.json")),
    readOptional(join(configDir, "upstream.json")),
  ]);
  const readJson = <T>(text: string | undefined, parse: (value: unknown) => T, fallback: T | null): T | null => {
    if (text === undefined) return fallback;
    try {
      return parse(JSON.parse(text) as unknown);
    } catch {
      return fallback;
    }
  };
  return Object.freeze({
    keys: readJson(keysText, parseMontanaKeys, previous?.keys ?? null),
    persona: personaText === undefined ? previous?.persona ?? null : personaText.slice(0, MAX_PERSONA_CHARS),
    relays: readJson(relaysText, parseMontanaRelays, previous?.relays ?? null),
    upstream: readJson(upstreamText, parseMontanaUpstream, previous?.upstream ?? null),
  });
}

function defaultConfigDir(): string {
  return resolve(Bun.env.MONTANA_CONFIG_DIR?.trim() || process.cwd());
}

export function createMontanaConfigRuntime(options: { readonly configDir?: string; readonly debounceMs?: number } = {}): Promise<MontanaConfigRuntime> {
  const configDir = resolve(options.configDir ?? defaultConfigDir());
  const debounceMs = Math.min(Math.max(Math.floor(options.debounceMs ?? 30), 1), 5_000);
  let snapshot: MontanaConfigSnapshot;
  let watcher: FSWatcher | null = null;
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  let quotaTimer: ReturnType<typeof setTimeout> | null = null;
  let quotaDirty = false;
  let quotaWriting: Promise<void> | null = null;
  let reloadChain: Promise<void> = Promise.resolve();
  let closed = false;
  const runtime: MontanaConfigRuntime = {
    configDir,
    snapshot: () => snapshot,
    reload: () => {
      if (closed) return reloadChain;
      reloadChain = reloadChain.then(async () => {
        try { snapshot = await loadSnapshot(configDir, snapshot); } catch {}
      }).catch(() => {});
      return reloadChain;
    },
    recordUsage(keyId, tokens) {
      if (closed || !Number.isFinite(tokens) || tokens <= 0 || snapshot.keys === null) return;
      const keys = snapshot.keys;
      const index = keys.findIndex((entry) => entry.id === keyId);
      if (index < 0) return;
      const entry = keys[index];
      if (entry === undefined) return;
      const used = Math.min(entry.quota, entry.used + Math.max(1, Math.ceil(tokens)));
      const next = [...keys];
      next[index] = Object.freeze({ ...entry, used });
      snapshot = Object.freeze({ ...snapshot, keys: Object.freeze(next) });
      quotaDirty = true;
      if (quotaTimer !== null) return;
      quotaTimer = setTimeout(() => {
        quotaTimer = null;
        void runtime.flush().catch(() => {});
      }, 5_000);
      quotaTimer.unref?.();
    },
    async flush() {
      if (quotaTimer !== null) { clearTimeout(quotaTimer); quotaTimer = null; }
      if (quotaWriting !== null) await quotaWriting;
      if (!quotaDirty || closed) return;
      quotaDirty = false;
      const current = snapshot.keys;
      if (current === null) return;
      const temporary = join(configDir, `.keys.json.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
      quotaWriting = (async () => {
        try {
          await writeFile(temporary, `${JSON.stringify({ keys: current }, null, 2)}\n`, { mode: 0o600 });
          await rename(temporary, join(configDir, "keys.json"));
          await chmod(join(configDir, "keys.json"), 0o600).catch(() => {});
        } catch (error) {
          quotaDirty = true;
          throw error;
        } finally {
          quotaWriting = null;
        }
      })();
      await quotaWriting;
    },
    async close() {
      if (closed) return;
      closed = true;
      watcher?.close();
      watcher = null;
      if (watchTimer !== null) clearTimeout(watchTimer);
      if (quotaTimer !== null) clearTimeout(quotaTimer);
      quotaTimer = null;
      await reloadChain;
      closed = false;
      await runtime.flush();
      closed = true;
      if (activeRuntime === runtime) activeRuntime = null;
    },
    findKey(secret) {
      if (snapshot.keys === null) return null;
      const supplied = Buffer.from(secret);
      let match: MontanaKeyConfig | null = null;
      for (const entry of snapshot.keys) {
        const candidate = Buffer.from(entry.key);
        if (candidate.length === supplied.length && timingSafeEqual(candidate, supplied)) match = entry;
      }
      return match === null ? null : { key: match, secret };
    },
    findKeyById(id) {
      return snapshot.keys?.find((entry) => entry.id === id) ?? null;
    },
  };
  return loadSnapshot(configDir).then((initial) => {
    snapshot = initial;
    void (async () => {
      for (const name of CONFIG_FILES) await chmod(join(configDir, name), 0o600).catch(() => {});
    })();
    try {
      watcher = watch(configDir, { persistent: true }, (_eventType, filename) => {
        const name = filename?.toString();
        if (name !== undefined && !CONFIG_FILES.has(name) || closed) return;
        if (watchTimer !== null) clearTimeout(watchTimer);
        watchTimer = setTimeout(() => { watchTimer = null; void runtime.reload(); }, debounceMs);
        watchTimer.unref?.();
      });
    } catch {}
    activeRuntime = runtime;
    return runtime;
  });
}

let activeRuntime: MontanaConfigRuntime | null = null;

export function getMontanaConfigRuntime(): MontanaConfigRuntime | null {
  return activeRuntime;
}

export function montanaPersonaSnapshot(): { readonly enabled: boolean; readonly name: string; readonly version: string; readonly content: string; readonly updatedAt: string; readonly loadedAt: number } | null {
  const content = activeRuntime?.snapshot().persona;
  return content === null || content === undefined ? null : { enabled: true, name: "Montana", version: "file", content, updatedAt: new Date().toISOString(), loadedAt: Date.now() };
}

export function montanaKeyId(keyId: string): boolean {
  return keyId.startsWith("montana:");
}
