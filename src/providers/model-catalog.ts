import type { ProviderMeta, ProviderModel } from "../proxy/types/provider.js";

export type ProviderAccess = "oauth" | "api_key";
export type ProviderCredentialKind = "oauth" | "api_key";

export interface ProviderDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly access: ProviderAccess;
  readonly protocol: ProviderMeta["protocol"];
  readonly credentialKinds?: readonly ProviderCredentialKind[];
  readonly optional?: boolean;
  readonly heavy?: boolean;
}

/** Merges static and discovered models without allowing failed/stale discovery to prune fallback models. */
export function mergeProviderModels(
  staticModels: readonly ProviderModel[],
  discoveredCatalogs: Iterable<readonly ProviderModel[]>,
): readonly ProviderModel[] {
  const merged = new Map<string, ProviderModel>();
  for (const model of staticModels) merged.set(model.id, model);
  for (const catalog of discoveredCatalogs) {
    for (const model of catalog) {
      const current = merged.get(model.id);
      if (current === undefined) {
        merged.set(model.id, model);
        continue;
      }
      merged.set(model.id, {
        ...current,
        displayName: model.displayName?.trim() ? model.displayName : current.displayName,
        upstreamId: model.upstreamId ?? current.upstreamId,
        context: {
          inputTokens: maxOrNull(model.context?.inputTokens ?? null, current.context?.inputTokens ?? null),
          outputTokens: maxOrNull(model.context?.outputTokens ?? null, current.context?.outputTokens ?? null),
        },
        pricing: model.pricing ?? current.pricing ?? undefined,
        categories: dedup([...(current.categories ?? []), ...(model.categories ?? [])]) as readonly import("../proxy/types/provider.js").ModelCapabilityCategory[],
        capabilities: { ...current.capabilities, ...model.capabilities },
      });
    }
  }
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function maxOrNull(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function dedup(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
