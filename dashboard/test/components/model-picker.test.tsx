import { describe, expect, test } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfiguredModelPicker, ModelPickerField, ModelTargetPicker } from "../../src/components/model-picker";
import { vi } from "vitest";
import { withQueryClient, mockJsonFetch } from "../query-client";

describe("ModelPickerField", () => {
  test("renders the label", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Providers" values={[]} onChange={onChange} mode="providers" />));
    expect(screen.getByText("Providers")).toBeInTheDocument();
  });

  test("renders hint text when provided", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Providers" hint="pick one or more" values={[]} onChange={onChange} mode="providers" />));
    expect(screen.getByText("pick one or more")).toBeInTheDocument();
  });

  test("renders a chip for each value in the values array", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Providers" values={["openai", "anthropic"]} onChange={onChange} mode="providers" />));
    expect(screen.getByText("openai")).toBeInTheDocument();
    expect(screen.getByText("anthropic")).toBeInTheDocument();
  });

  test("clicking X removes the value from the list", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Providers" values={["openai"]} onChange={onChange} mode="providers" />));
    fireEvent.click(screen.getByRole("button", { name: "Remove openai" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  test("does not render any chips when values is empty", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Providers" values={[]} onChange={onChange} mode="providers" />));
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
  });

  test("opens the configured model browser", async () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Models" values={[]} onChange={onChange} mode="models" />));
    fireEvent.click(screen.getByRole("button", { name: "Add configured models…" }));
    expect(await screen.findByPlaceholderText("Search — type qualified id to add custom…")).toBeInTheDocument();
  });
});

describe("ModelTargetPicker", () => {
  test("renders dropdown button with current value", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelTargetPicker value="gpt-4o" onChange={onChange} />));
    expect(screen.getByRole("button", { name: /gpt-4o/ })).toBeInTheDocument();
  });

  test("renders placeholder when value is empty", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelTargetPicker value="" onChange={onChange} placeholder="Pick a model" />));
    expect(screen.getByText("Pick a model")).toBeInTheDocument();
  });

  test("opens dropdown and shows search", async () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelTargetPicker value="" onChange={onChange} />));
    fireEvent.click(screen.getByRole("button", { name: /Select model/ }));
    expect(await screen.findByPlaceholderText("Search — type qualified id to add custom…")).toBeInTheDocument();
  });
});

describe("ModelPickerField — configured provider visibility", () => {
  test("does not render models without credentials, except none-credential providers", async () => {
    const responses: Record<string, unknown> = {
      "/console/api/providers": {
        items: [
          { id: "openai", name: "OpenAI", icon: "openai", prefix: "openai", credentialKind: "api_key", configured: false, models: [{ id: "gpt-5", enabled: true }] },
          { id: "opencodeft", name: "OpenCode Free", icon: "opencode", prefix: "opencodeft", credentialKind: "none", configured: false, models: [{ id: "free-model", enabled: true }] },
        ],
      },
      "/console/api/providers:custom": { items: [] },
    };
    const fetchSpy = mockJsonFetch(responses);
    render(withQueryClient(<ModelPickerField label="Models" values={[]} onChange={vi.fn()} mode="models" />));
    fireEvent.click(screen.getByRole("button", { name: "Add configured models…" }));
    expect(await screen.findByText("free-model")).toBeInTheDocument();
    expect(screen.queryByText("gpt-5")).not.toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  test("normalizes the live provider catalog modelId payload", async () => {
    const responses: Record<string, unknown> = {
      "/console/api/providers": {
        items: [{
          id: "kimchi",
          name: "Kimchi",
          credentialKind: "oauth",
          configured: true,
          accountCount: 1,
          modelCount: 1,
          models: [{ providerId: "kimchi", modelId: "kimi-k2.7", enabled: true }],
        }],
      },
      "/console/api/providers:custom": { items: [] },
    };
    const fetchSpy = mockJsonFetch(responses);
    try {
      render(withQueryClient(<ModelPickerField label="Models" values={[]} onChange={vi.fn()} mode="models" />));
      fireEvent.click(screen.getByRole("button", { name: "Add configured models…" }));
      expect(await screen.findByText("kimi-k2.7")).toBeInTheDocument();
    } finally {
      fetchSpy.mockRestore();
    }
  });
  test("keeps custom BYOK providers out of API-key allowlist picker", async () => {
    const responses: Record<string, unknown> = {
      "/console/api/providers": {
        items: [{ slug: "bobox", name: "Custom Blackbox", credentialHint: "sk-test", models: [{ id: "blackboxai/z-ai/glm-5.2" }] }],
      },
    };
    const fetchSpy = mockJsonFetch(responses);
    try {
      render(withQueryClient(<ModelPickerField label="Allowed models" values={[]} onChange={vi.fn()} mode="models" includeCustomProviders={false} />));
      fireEvent.click(screen.getByRole("button", { name: "Add configured models…" }));
      await screen.findByPlaceholderText("Search — type qualified id to add custom…");
      expect(screen.queryByText("blackboxai/z-ai/glm-5.2")).not.toBeInTheDocument();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("ConfiguredModelPicker selected values", () => {
  function stubCatalogFetch() {
    const responses: Record<string, unknown> = {
      "/console/api/providers": { items: [] },
      "/console/api/models/aliases": { items: [{ alias: "gpt-5.6-sol", model: "openai/gpt-5.6-sol" }] },
      "/console/api/models/combos": { items: [{ name: "fast-combo" }] },
    };
    return mockJsonFetch(responses);
  }

  test("renders a selected alias in the Aliases section", async () => {
    const fetchSpy = stubCatalogFetch();
    render(withQueryClient(<ModelPickerField label="Allowed" values={["gpt-5.6-sol"]} onChange={vi.fn()} mode="models" includeCombos includeAliases />));
    fireEvent.click(screen.getByRole("button", { name: "1 models selected" }));
    expect(await screen.findByText("Aliases")).toBeInTheDocument();
    expect(screen.queryByText(/^Custom/)).not.toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  test("renders a selected combo in the Combos section", async () => {
    const fetchSpy = stubCatalogFetch();
    render(withQueryClient(<ModelPickerField label="Allowed" values={["fast-combo"]} onChange={vi.fn()} mode="models" includeCombos includeAliases />));
    fireEvent.click(screen.getByRole("button", { name: "1 models selected" }));
    expect(await screen.findByText("Combos")).toBeInTheDocument();
    expect(screen.queryByText(/^Custom/)).not.toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  test("keeps an unrecognized selected value without inventing a catalog section", async () => {
    const fetchSpy = stubCatalogFetch();
    render(withQueryClient(<ModelPickerField label="Allowed" values={["totally-manual-value"]} onChange={vi.fn()} mode="models" includeCombos includeAliases />));
    fireEvent.click(screen.getByRole("button", { name: "1 models selected" }));
    expect(await screen.findByPlaceholderText("Search — type qualified id to add custom…")).toBeInTheDocument();
    expect(screen.queryByText(/^Custom/)).not.toBeInTheDocument();
    fetchSpy.mockRestore();
  });
});

describe("ConfiguredModelPicker lifecycle", () => {
  test("does not emit changing dependency-array warnings as the catalog loads", async () => {
    const responses: Record<string, unknown> = {
      "/console/api/providers": {
        items: [{
          id: "opencodeft",
          name: "OpenCode Free",
          icon: "opencode",
          prefix: "opencodeft",
          credentialKind: "none",
          configured: false,
          models: [{ id: "free-model", enabled: true }],
        }],
      },
      "/console/api/providers:custom": { items: [] },
    };
    const fetchSpy = mockJsonFetch(responses);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(withQueryClient(<ConfiguredModelPicker value="" onChange={vi.fn()} />));
      fireEvent.click(screen.getByRole("button", { name: "Select configured model…" }));
      expect(await screen.findByText("free-model")).toBeInTheDocument();
      const errors = errorSpy.mock.calls.flat().join(" ");
      expect(errors).not.toContain("The final argument passed to useMemo changed size");
    } finally {
      errorSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
  test("filters media capability models from the aggregated provider catalog (multimodal media live)", async () => {
    const responses: Record<string, unknown> = {
      "/console/api/providers": {
        items: [{
          id: "media-provider",
          name: "Media Provider",
          icon: "media-provider",
          prefix: "media",
          credentialKind: "api_key",
          configured: true,
          models: [
            { id: "image-model", enabled: true, capabilities: { chat: false, media: true } },
            { id: "video-model", enabled: true, capabilities: { chat: false, media: true } },
            { id: "chat-model", enabled: true, capabilities: { chat: true, media: false } },
          ],
        }],
      },
      "/console/api/providers:custom": { items: [] },
    };
    const fetchSpy = mockJsonFetch(responses);
    try {
      render(withQueryClient(<ConfiguredModelPicker value="" onChange={vi.fn()} capability="media" />));
      fireEvent.click(screen.getByRole("button", { name: "Select configured model…" }));
      expect(await screen.findByText("image-model")).toBeInTheDocument();
      expect(screen.getByText("video-model")).toBeInTheDocument();
      expect(screen.queryByText("chat-model")).not.toBeInTheDocument();
      const providerDetailCalls = fetchSpy.mock.calls.filter(([input]) => String(input).includes("/console/api/providers/"));
      expect(providerDetailCalls).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
  test("virtualizes large model lists to limit DOM nodes", async () => {
    const models = Array.from({ length: 120 }, (_, i) => ({ id: `model-${i}`, enabled: true }));
    const responses: Record<string, unknown> = {
      "/console/api/providers": {
        items: [{
          id: "big-provider",
          name: "Big Provider",
          icon: "big-provider",
          prefix: "big",
          credentialKind: "none",
          configured: true,
          models,
        }],
      },
      "/console/api/providers:custom": { items: [] },
    };
    const fetchSpy = mockJsonFetch(responses);
    try {
      render(withQueryClient(<ConfiguredModelPicker value="" onChange={vi.fn()} />));
      fireEvent.click(screen.getByRole("button", { name: "Select configured model…" }));
      expect(await screen.findByText("model-0")).toBeInTheDocument();
      // With windowing (rowHeight 36, overscan 4, viewport ~60vh), only a slice ~ visible + overscan is rendered.
      // Assert not all 120 rows are in the DOM at once.
      const renderedModels = models.filter((m) => screen.queryByText(m.id) !== null);
      expect(renderedModels.length).toBeLessThan(models.length);
      expect(renderedModels.length).toBeGreaterThan(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
