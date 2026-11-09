import type { ProxyRequest } from "../proxy/types/request.js";
import { COMPRESSION_EMERGENCY_MESSAGE_THRESHOLD } from "./ponytail.js";
import { applyPonytail } from "./ponytail.js";
import type { TokenSaverConfig } from "./token-saver.js";
import { applyTokenSaver } from "./token-saver.js";

export interface CompressionOptions {
  readonly ponytailEnabled: boolean;
  readonly tokenSaver?: TokenSaverConfig;
}

/**
 * Single application-owned compression entry point. Applies Ponytail
 * then RTK exactly once before provider encoding. Deterministic and
 * idempotent; bounded and surface-aware (multimodal blocks untouched).
 */
export function applyCompression(request: ProxyRequest, options: CompressionOptions): ProxyRequest {
  let next = applyPonytail(request, options.ponytailEnabled);
  if (options.tokenSaver !== undefined) {
    const emergency = next.messages.length > COMPRESSION_EMERGENCY_MESSAGE_THRESHOLD;
    next = applyTokenSaver(next, { ...options.tokenSaver, emergency: options.tokenSaver.emergency === true || emergency });
  }
  return next;
}
