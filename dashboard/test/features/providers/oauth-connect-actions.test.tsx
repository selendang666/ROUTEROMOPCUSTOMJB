import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { OAuthConnectActions } from "../../../src/features/providers/oauth-connect-actions";

describe("OAuthConnectActions", () => {
  test("shows separate browser and device actions when both flows exist", () => {
    const onStart = vi.fn();
    render(<OAuthConnectActions flows={{ browser: true, device: true }} onStart={onStart} />);

    fireEvent.click(screen.getByRole("button", { name: "Login with OAuth" }));
    fireEvent.click(screen.getByRole("button", { name: "Login with OAuth device code" }));

    expect(onStart).toHaveBeenNthCalledWith(1, "browser");
    expect(onStart).toHaveBeenNthCalledWith(2, "device");
  });

  test("only renders the supported flow", () => {
    render(<OAuthConnectActions flows={{ browser: false, device: true }} onStart={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Login with OAuth" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Login with OAuth device code" })).toBeInTheDocument();
  });

  test("renders no OAuth action when the provider has no interactive flow", () => {
    render(<OAuthConnectActions flows={{ browser: false, device: false }} onStart={vi.fn()} />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
