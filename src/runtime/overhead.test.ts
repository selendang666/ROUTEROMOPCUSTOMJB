import { describe, expect, test } from "bun:test";
import {
  OverheadTracker,
  currentOverheadReport,
  getOverheadSnapshot,
  markOverhead,
  markSampledOverhead,
  overheadPrometheus,
  runWithOverheadRequest,
} from "./overhead.js";

describe("overhead tracking", () => {
  test("records idempotent bounded phase marks", () => {
    const tracker = new OverheadTracker("req-1");
    const stop = tracker.mark("router.plan", { cached: false });
    stop();
    stop();
    const report = tracker.report();
    expect(report.requestId).toBe("req-1");
    expect(report.marks).toHaveLength(1);
    expect(report.marks[0]?.phase).toBe("router.plan");
    expect(report.marks[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.marks[0]?.metadata).toEqual({ cached: false });
  });

  test("propagates request context across awaited work", async () => {
    const report = await runWithOverheadRequest("req-async", async () => {
      const stop = markOverhead("ingress.auth");
      await Promise.resolve();
      stop();
      const sampledStop = markSampledOverhead("stream.frame", 1);
      sampledStop();
      return currentOverheadReport();
    }, { force: true });
    expect(report?.requestId).toBe("req-async");
    expect(report?.marks.map((mark) => mark.phase)).toEqual(["ingress.auth", "stream.frame"]);
    expect(currentOverheadReport()).toBeUndefined();
  });

  test("exports phase percentiles and Prometheus metrics", () => {
    const tracker = new OverheadTracker("req-metrics");
    tracker.mark("upstream.dns")();
    const snapshot = getOverheadSnapshot();
    expect(snapshot.phases["upstream.dns"]?.count).toBeGreaterThanOrEqual(1);
    const metrics = overheadPrometheus();
    expect(metrics).toContain("ohmyomop_router_overhead_milliseconds");
    expect(metrics).toContain('phase="upstream.dns"');
    expect(metrics).toContain('quantile="0.999"');
  });

  test("rejects unbounded phase names without recording", () => {
    const tracker = new OverheadTracker("req-invalid");
    tracker.mark("Invalid Phase Name")();
    expect(tracker.report().marks).toHaveLength(0);
  });
});
