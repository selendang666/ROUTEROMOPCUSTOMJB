import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getTimeTick, subscribeTimeTick } from "../../src/lib/time-tick";

describe("subscribeTimeTick — visibility-aware scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  test("advances tick roughly every second via setTimeout", () => {
    const cb = vi.fn();
    const unsub = subscribeTimeTick(cb);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(getTimeTick()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(getTimeTick()).toBe(2);
    unsub();
  });

  test("sleeps when document is hidden and resumes when visible", () => {
    const cb = vi.fn();
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    const unsub = subscribeTimeTick(cb);
    vi.advanceTimersByTime(2000);
    expect(cb).not.toHaveBeenCalled();
    const before = getTimeTick();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(1000);
    expect(getTimeTick()).toBeGreaterThan(before);
    expect(cb).toHaveBeenCalled();
    unsub();
  });

  test("stops scheduling after last unsubscribe", () => {
    const cb = vi.fn();
    const unsub = subscribeTimeTick(cb);
    unsub();
    vi.advanceTimersByTime(3000);
    expect(cb).not.toHaveBeenCalled();
  });

  test("does not use requestAnimationFrame loop", () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame");
    const cb = vi.fn();
    const unsub = subscribeTimeTick(cb);
    vi.advanceTimersByTime(1000);
    expect(rafSpy).not.toHaveBeenCalled();
    unsub();
    rafSpy.mockRestore();
  });
});
