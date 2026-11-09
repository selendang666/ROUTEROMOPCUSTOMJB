export function evaluateContextBudget(
  estimatedTokens: number,
  contextWindowTokens: number | null,
  warningRatio: number,
): { shouldWarn: boolean; shouldEmergency: boolean; ratio: number | null } {
  if (contextWindowTokens === null || contextWindowTokens <= 0) return { shouldWarn: false, shouldEmergency: false, ratio: null };
  const ratio = estimatedTokens / contextWindowTokens;
  const warn = ratio >= warningRatio;
  const emergency = ratio >= 0.95;
  return { shouldWarn: warn, shouldEmergency: emergency, ratio };
}
