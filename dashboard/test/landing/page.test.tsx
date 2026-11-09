import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { LandingPage } from "../../src/landing/page";

class MockIntersectionObserver {
  callback: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb;
  }
  observe(target: Element) {
    // Immediately trigger visible for first element
    if (target.getAttribute("data-chapter-index") === "0") {
      this.callback([{ isIntersecting: true, intersectionRatio: 0.9, target } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
  }
  unobserve() {}
  disconnect() {}
}

describe("LandingPage", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    (global as unknown as Record<string, unknown>).IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (global as unknown as Record<string, unknown>).IntersectionObserver;
  });

  test("renders the first chapter and preloads the next image", () => {
    render(<LandingPage />);

    expect(screen.getByRole("heading", { name: "A single signal enters the unknown." })).toBeInTheDocument();
    expect(document.querySelectorAll(".story-page-section")).toHaveLength(7);
    expect(document.querySelector(".story-page-visual img")?.getAttribute("src")).toBe("/when_yah/fleurdelys_plus.webp");
    expect(document.querySelectorAll(".story-signal")).toHaveLength(21);
  });

  test("returns to the previous image when scrolling back from the final chapter", () => {
    render(<LandingPage />);
    // New story-simple layout keeps all sections in DOM, last image should be Shorekeeper
    expect(document.querySelectorAll(".story-page-section")[6]?.querySelector("img")?.getAttribute("src")).toContain("Shorekeeper.webp");
    expect(document.querySelectorAll(".story-page-section")[5]?.querySelector("img")?.getAttribute("src")).toContain("requestdeniawokkjpg.webp");
  });
});
