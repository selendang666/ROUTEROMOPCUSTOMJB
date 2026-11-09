import { ProtocolCodecError } from "../errors.js";
import type { StreamEvent } from "../types/stream.js";

/**
 * Creates a gate enforcing canonical provider event order.
 *
 * @returns A lifecycle checker for one provider stream.
 */
export function createLifecycleGate() {
  let started = false;
  let usageSeen = false;
  let stopped = false;
  const openTools = new Set<string>();
  return {
    check(event: StreamEvent): void {
      if (stopped) {
        throw new ProtocolCodecError({ kind: "provider_protocol_error", message: "event after stop", statusCode: 502, routeScope: "provider" });
      }
      if (event.type === "message_start") {
        if (started) throw new ProtocolCodecError({ kind: "provider_protocol_error", message: "duplicate start", statusCode: 502, routeScope: "provider" });
        started = true;
        return;
      }
      if (event.type === "tool_call_start") {
        if (!started) throw new ProtocolCodecError({ kind: "provider_protocol_error", message: "tool start before message_start", statusCode: 502, routeScope: "provider" });
        if (!event.name || event.name.trim() === "") throw new ProtocolCodecError({ kind: "provider_protocol_error", message: "invalid tool name", statusCode: 502, routeScope: "provider" });
        if (openTools.has(event.callId)) throw new ProtocolCodecError({ kind: "provider_protocol_error", message: "duplicate tool start", statusCode: 502, routeScope: "provider" });
        openTools.add(event.callId);
        return;
      }
      if (event.type === "tool_call_end") {
        if (!openTools.has(event.callId)) throw new ProtocolCodecError({ kind: "provider_protocol_error", message: "tool end without start", statusCode: 502, routeScope: "provider" });
        openTools.delete(event.callId);
        return;
      }
      if (event.type === "usage") {
        if (usageSeen) throw new ProtocolCodecError({ kind: "provider_protocol_error", message: "duplicate usage", statusCode: 502, routeScope: "provider" });
        usageSeen = true;
        return;
      }
      if (event.type === "message_stop") {
        if (openTools.size > 0) throw new ProtocolCodecError({ kind: "provider_protocol_error", message: "unclosed tools at stop", statusCode: 502, routeScope: "provider" });
        if (stopped) throw new ProtocolCodecError({ kind: "provider_protocol_error", message: "duplicate stop", statusCode: 502, routeScope: "provider" });
        stopped = true;
        return;
      }
      if (!started && (event.type === "text_delta" || event.type === "thinking_delta")) {
        throw new ProtocolCodecError({ kind: "provider_protocol_error", message: "output before start", statusCode: 502, routeScope: "provider" });
      }
    },
  };
}

