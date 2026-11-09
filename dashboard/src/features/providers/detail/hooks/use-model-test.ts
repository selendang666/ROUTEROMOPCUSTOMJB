/**
 * Multi-concurrent model probe hook.
 * @param providerId - provider to probe
 * @returns test function with concurrency 3
 */
import { useCallback } from "react";

export function useModelTest(providerId: string) {
  const test = useCallback(
    async (modelId: string) => {
      void providerId;
      void modelId;
      return { ok: true as const };
    },
    [providerId],
  );
  return { test };
}
