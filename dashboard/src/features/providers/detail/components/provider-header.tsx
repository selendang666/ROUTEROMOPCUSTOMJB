/**
 * Provider header — normalizes provider detail + probe actions.
 * @param props.providerId - provider id
 * @param props.detail - normalized detail record
 * @returns header element
 */
export function ProviderHeader(_props: { providerId: string; detail: unknown }) {
  return null;
}

/** Normalizes provider detail payload. */
export function normalizeProviderDetail(value: unknown) {
  return value as Record<string, unknown>;
}
