import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModelTargetPicker, ModelPickerField } from "../../../src/components/model-picker";
import { withQueryClient } from "../../query-client";

describe("ModelTargetPicker — single-value form field", () => {
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

  test("is not disabled by default", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelTargetPicker value="" onChange={onChange} placeholder="Pick a model" />));
    expect(screen.getByRole("button", { name: /Pick a model/ })).toBeEnabled();
  });

  test("is disabled when the disabled prop is true", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelTargetPicker value="x" onChange={onChange} disabled />));
    expect(screen.getByRole("button", { name: /x/ })).toBeDisabled();
  });
});

describe("ModelPickerField — multi-value form field", () => {
  test("renders a chip for each value with a remove button", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Allowed models" values={["openai/gpt-4o", "anthropic/claude-3"]} onChange={onChange} mode="models" />));
    expect(screen.getAllByText("openai/gpt-4o").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("anthropic/claude-3").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("button", { name: /Remove / })).toHaveLength(2);
  });

  test("clicking the remove button on a chip calls onChange without that value", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Providers" values={["openai", "anthropic"]} onChange={onChange} mode="providers" />));
    fireEvent.click(screen.getByRole("button", { name: "Remove openai" }));
    expect(onChange).toHaveBeenCalledWith(["anthropic"]);
  });

  test("renders an empty state (no chips) when values is empty", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Models" values={[]} onChange={onChange} mode="models" />));
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
  });

  test("renders the label and optional hint", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Allowed" hint="leave empty for all" values={[]} onChange={onChange} mode="providers" />));
    expect(screen.getByText("Allowed")).toBeInTheDocument();
    expect(screen.getByText("leave empty for all")).toBeInTheDocument();
  });

  test("renders dropdown button for model selection", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Models" values={[]} onChange={onChange} mode="models" />));
    expect(screen.getByRole("button", { name: /Add configured models/ })).toBeInTheDocument();
  });
});
