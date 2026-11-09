import type { ProxyRequest } from "../../types/request.js";
import { narrowObject, narrowString } from "../../validation.js";
import { isProtocolError, protocolError } from "../../errors.js";
import type { ProtocolError } from "../../errors.js";
import { MAX_TOOL_NAME_LENGTH } from "../../validation.js";

export function normalizeToolChoice(raw: unknown): ProxyRequest["toolChoice"] | undefined | ProtocolError {
  if (raw === undefined || raw === null) return undefined;
  if (raw === "none" || raw === "auto" || raw === "required") return { kind: raw };
  const value = narrowObject(raw, "tool_choice");
  if (isProtocolError(value)) return value;
  if (value["type"] !== "function") return protocolError("tool_choice.type", 'tool_choice.type: expected "function"');
  const functionValue = narrowObject(value["function"], "tool_choice.function");
  if (isProtocolError(functionValue)) return functionValue;
  const name = narrowString(functionValue["name"], "tool_choice.function.name", MAX_TOOL_NAME_LENGTH);
  if (isProtocolError(name)) return name;
  if (name.trim() === "") return protocolError("tool_choice.function.name", "tool_choice.function.name: must not be empty");
  return { kind: "function", name };
}
