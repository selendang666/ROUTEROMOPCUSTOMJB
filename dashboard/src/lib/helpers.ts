import { ApiError } from "./api";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Converts unknown request failures into safe user-facing copy. */
export function getErrorMessage(error: unknown, fallback = "Request failed"): string {
  if (error instanceof ApiError && error.message.trim().length > 0) return error.message;
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return fallback;
}

/** Writes text to the browser clipboard and reports origin or permission failures. */
export async function copyToClipboard(value: string): Promise<boolean> {
  if (!navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
