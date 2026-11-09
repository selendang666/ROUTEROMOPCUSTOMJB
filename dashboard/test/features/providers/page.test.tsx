import { BrowserRouter } from "react-router-dom";
import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProvidersPage } from "../../../src/features/providers/page";
import { mockJsonFetch, withQueryClient } from "../../query-client";

describe("ProvidersPage catalog separation", () => {
  test("keeps a manual BYOK provider in Custom Providers only", async () => {
    const fetchSpy = mockJsonFetch({
      "/console/api/providers": {
        items: [
          {
            id: "ollama",
            name: "Ollama",
            icon: "ollama",
            prefix: "ollama",
            credentialKind: "none",
            credentialKinds: ["none"],
            modelCount: 1,
            capabilityCounts: { chat: 1, media: 0, websearch: 0 },
            enabled: true,
            configured: false,
            connections: 0,
            models: [],
            source: "builtin",
          },
          {
            id: "manual-b3f2c1",
            slug: "manual-b3f2c1",
            name: "Manual BYOK",
            kind: "openai-compatible",
            baseUrl: "https://provider.test",
            credentialHint: "sk-test",
            models: [{ id: "manual-model" }],
            source: "custom",
          },
        ],
      },
    });

    try {
      render(withQueryClient(
        <BrowserRouter>
          <ProvidersPage />
        </BrowserRouter>,
      ));

      expect(await screen.findByText("Custom Providers")).toBeInTheDocument();
      expect(await screen.findByText("Manual BYOK")).toBeInTheDocument();
      expect(screen.getAllByText("Manual BYOK")).toHaveLength(1);
      expect(screen.getByText("Free Limited Providers (1)")).toBeInTheDocument();
      expect(screen.getByText("Ollama")).toBeInTheDocument();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
