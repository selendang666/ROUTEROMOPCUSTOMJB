import { describe, expect, test } from "bun:test";
import { renderHealthPage } from "./health-page.js";

describe("health page", () => {
  test("renders embedded artwork and only supported API endpoints", () => {
    const page = renderHealthPage(new Request("http://127.0.0.1:12800/health"));

    expect(page).toContain("Oh My Omop - Router is serving");
    expect(page).toContain("POST /v1/chat/completions");
    expect(page).toContain("POST /v1/responses");
    expect(page).toContain("POST /v1/messages");
    expect(page).toContain("GET /v1/models");
    expect(page).toContain('id="tiresult"');
    expect(page).not.toContain("/v1/images/generations");
    expect(page).not.toContain("/v1/images/edits");
  });
});
