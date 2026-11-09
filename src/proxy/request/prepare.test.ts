import { describe, expect, test } from "bun:test";
import { prepareProxyRequest } from "./prepare.js";
import { CredentialSelector } from "../routing/account.js";
import { NetworkSelector } from "../transport/network.js";
import { parsePersonaRecord } from "../../persona/snapshot.js";

describe("prepareProxyRequest production compression", () => {
  test("applies the default PII deny list on the fused path", async () => {
    const prepared = await prepareProxyRequest({
      request: {
        endpoint: "/v1/chat/completions",
        surface: "openai-chat",
        headers: new Headers({ "content-type": "application/json" }),
        body: { model: "test-model", messages: [{ role: "user", content: "email me@example.com with sk-abcdefabcdefabcdef1234" }] },
        signal: new AbortController().signal,
      },
      authorization: { apiKeyId: null, trustedIdentity: null },
    }, {
      requestLimits: { maxBodyBytes: 1024 * 1024, connectTimeoutMs: 30_000, firstByteTimeoutMs: 60_000, idleTimeoutMs: 60_000, totalTimeoutMs: 600_000 },
      providers: { get: () => undefined },
      accounts: new CredentialSelector({ getCredential: async () => null }),
      network: new NetworkSelector(),
      accountCandidates: async () => [],
      resolveRoutes: async () => ({ affinity: { namespace: "api_key", value: "test" }, candidates: [], diagnostics: [], snapshotRevision: 1 }),
      filterRules: () => ({ enabled: true, rules: [], piiDenyList: true }),
    });
    const content = prepared.request.messages[0]?.content[0];
    expect(content).toMatchObject({ type: "text" });
    expect((content as { text: string }).text).toContain("[REDACTED_EMAIL]");
    expect((content as { text: string }).text).toContain("[REDACTED_KEY]");
  });

  test("locks the live persona as the only system message", async () => {
    const prepared = await prepareProxyRequest({
      request: {
        endpoint: "/v1/chat/completions",
        surface: "openai-chat",
        headers: new Headers({ "content-type": "application/json" }),
        body: {
          model: "test-model",
          messages: [
            { role: "system", content: "client system" },
            { role: "developer", content: "client developer" },
            { role: "user", content: "hello" },
            { role: "system", content: "second client system" },
          ],
        },
        signal: new AbortController().signal,
      },
      authorization: { apiKeyId: null, trustedIdentity: null },
    }, {
      requestLimits: { maxBodyBytes: 1024 * 1024, connectTimeoutMs: 30_000, firstByteTimeoutMs: 60_000, idleTimeoutMs: 60_000, totalTimeoutMs: 600_000 },
      providers: { get: () => undefined },
      accounts: new CredentialSelector({ getCredential: async () => null }),
      network: new NetworkSelector(),
      accountCandidates: async () => [],
      resolveRoutes: async () => ({ affinity: { namespace: "api_key", value: "test" }, candidates: [], diagnostics: [], snapshotRevision: 1 }),
      globalPersona: () => parsePersonaRecord({
        enabled: true,
        name: "Hemress",
        version: "1",
        content: "Locked persona",
        updatedAt: "now",
      }),
    });

    expect(prepared.request.messages.map((message) => message.role)).toEqual(["system", "developer", "user"]);
    expect((prepared.request.messages[0]?.content[0] as { text: string }).text).toContain("Locked persona");
    expect((prepared.request.messages[1]?.content[0] as { text: string }).text).toBe("client developer");
  });
});
