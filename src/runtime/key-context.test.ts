import { expect, test } from "bun:test";
import { exceedsContextWindow } from "./key.js";

test("context admission preserves extended 1M model capacity", () => {
  expect(exceedsContextWindow(900_000, 64_000, 1_000_000)).toBe(false);
  expect(exceedsContextWindow(950_000, 64_000, 1_000_000)).toBe(true);
  expect(exceedsContextWindow(400_000, 64_000, 372_000)).toBe(true);
  expect(exceedsContextWindow(2_000_000, 1, null)).toBe(false);
});
