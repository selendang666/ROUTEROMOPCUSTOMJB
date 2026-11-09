import { describe, expect, test } from "bun:test";
import { applyGlobalPersona, MAX_PERSONA_BLOCK_CHARS, PERSONA_SENTINEL } from "./persona.js";
import { parsePersonaRecord } from "./snapshot.js";
import type { ProxyRequest } from "../proxy/types/request.js";

function textMessage(role: string, text: string): ProxyRequest["messages"][number] {
  return { role, content: [{ type: "text", text }] } as ProxyRequest["messages"][number];
}

function baseRequest(): ProxyRequest {
  return {
    messages: [textMessage("system", "Client system"), textMessage("user", "Hello")],
  } as unknown as ProxyRequest;
}

function enabledPersona(content = "You are Hemress.") {
  return parsePersonaRecordForTest(content);
}

function parsePersonaRecordForTest(content: string) {
  return parsePersonaRecord({ enabled: true, name: "hemress", version: "1", content, updatedAt: "now" });
}

describe("applyGlobalPersona", () => {
  test("strips every client system message and prepends exactly one persona", () => {
    const req = {
      ...baseRequest(),
      messages: [
        textMessage("system", "Client system"),
        textMessage("user", "Hello"),
        textMessage("system", "Second system"),
        { ...textMessage("developer", "Developer"), cacheControl: "ephemeral" as const },
        textMessage("assistant", "Prior reply"),
      ],
      temperature: 0.2,
      metadata: { trace: "keep" },
    } as unknown as ProxyRequest;
    const out = applyGlobalPersona(req, enabledPersona());
    expect(out.messages.map((message) => message.role)).toEqual(["system", "user", "developer", "assistant"]);
    expect(out.messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect(out.messages[1]).toBe(req.messages[1]);
    expect(out.messages[2]).toBe(req.messages[3]);
    expect(out.messages[3]).toBe(req.messages[4]);
    expect(out.temperature).toBe(0.2);
    expect(out.metadata).toBe(req.metadata);
    const first = (out.messages[0]!.content[0] as { text: string }).text;
    expect(first).toContain(PERSONA_SENTINEL);
    expect(first).toContain("Hemress");
  });

  test("is idempotent and refreshes the single injected message", () => {
    const once = applyGlobalPersona(baseRequest(), enabledPersona("First persona."));
    const twice = applyGlobalPersona(once, enabledPersona("Second persona."));
    expect(twice.messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect((twice.messages[0]!.content[0] as { text: string }).text).toContain("Second persona.");
    expect(twice.messages.map((message) => message.role)).toEqual(["system", "user"]);
  });

  test("is a no-op when disabled or content empty", () => {
    const disabled = parsePersonaRecord({ enabled: false, content: "x" });
    expect(applyGlobalPersona(baseRequest(), disabled).messages.length).toBe(2);
    const empty = parsePersonaRecord({ enabled: true, content: "   " });
    expect(applyGlobalPersona(baseRequest(), empty).messages.length).toBe(2);
  });

  test("prepends persona when the request has no client messages", () => {
    const req = { messages: [] } as unknown as ProxyRequest;
    const out = applyGlobalPersona(req, enabledPersona());
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.role).toBe("system");
  });

  test("bounds the injected persona block", () => {
    const out = applyGlobalPersona({ messages: [] } as unknown as ProxyRequest, enabledPersona("x".repeat(50_000)));
    expect((out.messages[0]!.content[0] as { text: string }).text.length).toBeLessThanOrEqual(MAX_PERSONA_BLOCK_CHARS);
  });

  test("does not mutate the input request", () => {
    const req = baseRequest();
    applyGlobalPersona(req, enabledPersona());
    expect(req.messages.length).toBe(2);
  });
});

describe("parsePersonaRecord", () => {
  test("disabled snapshot for absent or invalid values", () => {
    expect(parsePersonaRecord(null).enabled).toBe(false);
    expect(parsePersonaRecord({}).enabled).toBe(false);
    expect(parsePersonaRecord({ enabled: true }).enabled).toBe(false);
  });
});
