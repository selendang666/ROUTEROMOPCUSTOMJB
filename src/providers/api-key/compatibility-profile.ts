import type { AnthropicCompatibilityProfile, CompatibilityProfile, CompatibilityRequestRule } from "../../proxy/types/provider.js";

export function compatibilityProfileFrom(value: unknown): CompatibilityProfile | undefined {
  if (!isPlainRecord(value)) return undefined;
  const profile: {
    query?: Readonly<Record<string, string>>;
    headers?: Readonly<Record<string, string>>;
    streamUsage?: "always" | "never" | "auto";
    structuredOutputs?: { supported: boolean; strictByDefault?: boolean };
    requestRules?: readonly CompatibilityRequestRule[];
    responseMetadata?: readonly ("request-id" | "system-fingerprint" | "service-tier" | "model")[];
  } = {};
  const query = stringRecord(value.query, 128, 2_048);
  if (value.query !== undefined && query === undefined) return undefined;
  if (query !== undefined) profile.query = query;
  const headers = stringRecord(value.headers, 128, 8_192);
  if (value.headers !== undefined && headers === undefined) return undefined;
  if (headers !== undefined) profile.headers = headers;
  if (value.streamUsage === "always" || value.streamUsage === "never" || value.streamUsage === "auto") profile.streamUsage = value.streamUsage;
  if (isPlainRecord(value.structuredOutputs) && typeof value.structuredOutputs.supported === "boolean") {
    profile.structuredOutputs = {
      supported: value.structuredOutputs.supported,
      ...(typeof value.structuredOutputs.strictByDefault === "boolean" ? { strictByDefault: value.structuredOutputs.strictByDefault } : {}),
    };
  }
  if (Array.isArray(value.responseMetadata)) {
    const allowed = new Set(["request-id", "system-fingerprint", "service-tier", "model"]);
    const responseMetadata = value.responseMetadata.filter((entry): entry is "request-id" | "system-fingerprint" | "service-tier" | "model" => typeof entry === "string" && allowed.has(entry));
    if (responseMetadata.length > 0) profile.responseMetadata = responseMetadata;
  }
  const requestRules = compatibilityRules(value.requestRules);
  if (value.requestRules !== undefined && requestRules === undefined) return undefined;
  if (requestRules !== undefined) profile.requestRules = requestRules;
  return Object.keys(profile).length === 0 ? undefined : profile;
}

export function anthropicProfileFrom(value: unknown): AnthropicCompatibilityProfile | undefined {
  if (!isPlainRecord(value)) return undefined;
  const allowedBetas = new Set([
    "prompt-caching-2024-07-31",
    "extended-cache-ttl-2025-04-11",
    "interleaved-thinking-2025-05-14",
    "effort-2025-11-24",
    "user-profiles-2024-10-30",
    "structured-outputs-2025-11-13",
  ]);
  const betas = Array.isArray(value.betas)
    ? value.betas.filter((entry): entry is NonNullable<AnthropicCompatibilityProfile["betas"]>[number] => typeof entry === "string" && allowedBetas.has(entry))
    : [];
  if (value.betas !== undefined && (!Array.isArray(value.betas) || betas.length !== value.betas.length)) return undefined;
  const options: { speed?: "fast" | "standard"; inferenceGeo?: "us" | "global" } = {};
  if (isPlainRecord(value.options)) {
    if (value.options.speed === "fast" || value.options.speed === "standard") options.speed = value.options.speed;
    if (value.options.inferenceGeo === "us" || value.options.inferenceGeo === "global") options.inferenceGeo = value.options.inferenceGeo;
  }
  const profile: AnthropicCompatibilityProfile = {
    ...(betas.length > 0 ? { betas } : {}),
    ...(value.allowUserProfile === true ? { allowUserProfile: true } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
  return Object.keys(profile).length === 0 ? undefined : profile;
}

export function compatibilityRules(value: unknown): readonly CompatibilityRequestRule[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const rules: CompatibilityRequestRule[] = [];
  for (const item of value) {
    if (!isPlainRecord(item)) return undefined;
    if (item.kind === "rename-field" && isCompatibilityFieldName(item.from) && isCompatibilityFieldName(item.to)) {
      rules.push({ kind: "rename-field", from: item.from, to: item.to });
      continue;
    }
    if (item.kind === "move-field" && isCompatibilityFieldName(item.from) && Array.isArray(item.to) && item.to.length > 0 && item.to.length <= 3 && item.to.every(isCompatibilityFieldName)) {
      rules.push({ kind: "move-field", from: item.from, to: item.to });
      continue;
    }
    if (item.kind === "set-default" && isCompatibilityFieldName(item.field) && (typeof item.value === "string" || typeof item.value === "number" || typeof item.value === "boolean")) {
      rules.push({ kind: "set-default", field: item.field, value: item.value });
      continue;
    }
    if (item.kind === "omit-field" && isCompatibilityFieldName(item.field)) {
      rules.push({ kind: "omit-field", field: item.field });
      continue;
    }
    return undefined;
  }
  return rules;
}

export function isCompatibilityFieldName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringRecord(value: unknown, maxEntries: number, maxValueLength: number): Readonly<Record<string, string>> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > maxEntries || entries.some(([key, entry]) => !/^[A-Za-z0-9_.-]{1,128}$/.test(key) || typeof entry !== "string" || entry.length > maxValueLength || /[\r\n]/.test(entry))) {
    return undefined;
  }
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
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

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
