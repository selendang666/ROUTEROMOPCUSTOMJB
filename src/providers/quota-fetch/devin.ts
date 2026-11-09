import type { FetchLike, ProviderQuotaResult } from "./shared.js";
import { authCredential, getJson, isoDate, number, percentWindow, quotaRecord, record, text } from "./shared.js";



const DEVIN_USER_STATUS_URL = "https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/GetUserStatus";

function unixSecondsDate(value: unknown): string | null {
  const seconds = number(value);
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

function creditWindow(planStatus: Record<string, unknown>, availableKeys: readonly string[], usedKeys: readonly string[], kind: string, label: string, reset: string | null) {
  const available = availableKeys.map((key) => number(planStatus[key])).find((value) => value !== null) ?? null;
  const used = usedKeys.map((key) => number(planStatus[key])).find((value) => value !== null) ?? null;
  if (available === null && used === null) return null;
  const total = (available ?? 0) + (used ?? 0);
  if (total <= 0) return percentWindow(kind, label, 0, reset, 0, 0);
  return percentWindow(kind, label, ((used ?? 0) / total) * 100, reset, used, total);
}

function remainingWindow(planStatus: Record<string, unknown>, keys: readonly string[], kind: string, label: string, reset: string | null) {
  const remaining = keys.map((key) => number(planStatus[key])).find((value) => value !== null) ?? null;
  return remaining === null ? null : percentWindow(kind, label, 100 - remaining, reset);
}

export async function fetchDevinQuota(credential: string, _token: unknown, fetcher: FetchLike): Promise<ProviderQuotaResult> {
  const token = text(authCredential(credential).accessToken) ?? credential.trim();
  if (token.length === 0) throw new Error("Devin credential is empty.");
  const body = await getJson(
    DEVIN_USER_STATUS_URL,
    {
      authorization: `Bearer ${token}`,
      "connect-protocol-version": "1",
    },
    fetcher,
    {
      metadata: {
        ide_name: "WINDSURF",
        ide_version: "1.0.0",
        extension_version: "1.0.0",
        api_key: token,
      },
    },
  );
  const root = quotaRecord(body);
  const userStatus = record(root.userStatus) ?? {};
  const planStatus = record(userStatus.planStatus) ?? {};
  const planInfo = record(root.planInfo) ?? record(planStatus.planInfo) ?? {};
  const reset = isoDate(planStatus.planEnd) ?? isoDate(planInfo.planEnd);
  const windows = [
    creditWindow(planStatus, ["availablePromptCredits", "available_prompt_credits"], ["usedPromptCredits", "used_prompt_credits"], "prompt-credits", "Prompt Credits", reset),
    creditWindow(planStatus, ["availableFlowCredits", "available_flow_credits"], ["usedFlowCredits", "used_flow_credits"], "flow-credits", "Flow Action Credits", reset),
    remainingWindow(planStatus, ["dailyRemainingPercent", "dailyQuotaRemainingPercent"], "daily", "Daily Usage", unixSecondsDate(planStatus.dailyResetAtUnix ?? planStatus.dailyQuotaResetAtUnix)),
    remainingWindow(planStatus, ["weeklyRemainingPercent", "weeklyQuotaRemainingPercent"], "weekly", "Weekly Usage", unixSecondsDate(planStatus.weeklyResetAtUnix ?? planStatus.weeklyQuotaResetAtUnix)),
  ].filter((window): window is NonNullable<typeof window> => window !== null);
  return { source: "devin", plan: text(planInfo.planName) ?? text(userStatus.teamsTier) ?? null, windows, error: null };
}
