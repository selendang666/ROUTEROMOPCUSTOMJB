import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiGet } from "../../../lib/api";

interface UsageResourceOptions {
  enabled?: boolean;
  refetchInterval?: number;
  gcTime?: number;
  staleTime?: number;
}

/** Centralizes authenticated usage reads while keeping each feature query typed. */
export function useUsageResource<T>(queryKey: readonly unknown[], path: string, options: UsageResourceOptions = {}): UseQueryResult<T> {
  return useQuery({
    queryKey,
    queryFn: ({ signal }) => apiGet<T>(path, { signal }),
    enabled: options.enabled,
    refetchInterval: options.refetchInterval,
    placeholderData: keepPreviousData,
    staleTime: options.staleTime ?? 30_000,
    ...(options.gcTime !== undefined ? { gcTime: options.gcTime } : {}),
    refetchOnWindowFocus: false,
  });
}
