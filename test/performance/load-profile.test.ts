import { cpus, freemem, platform, totalmem } from "node:os";
import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../../packages/observability/src/backpressure";
import {
  assessPerformanceTarget,
  LOAD_SCENARIOS,
  type PerformanceEvidence,
  validatePerformanceEvidence,
} from "./load-profile";

describe("Phase 14 load and recovery profile", () => {
  it("covers ingress, 1k Runs, waits, fan-out, SSE, Integration, and model limits", () => {
    expect(LOAD_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "ingress_burst",
      "concurrent_runs_1000",
      "long_waits",
      "fan_out",
      "sse_reconnect",
      "integration_rate_limit",
      "model_rate_limit",
    ]);
  });

  it("opens a failing dependency circuit and permits one recovery probe", () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      recoveryAfterMs: 1000,
      now: () => now,
    });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.tryAcquire()).toBe(true);
    breaker.recordFailure();
    expect(breaker.tryAcquire()).toBe(false);

    now = 1000;
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false);
    breaker.recordSuccess();
    expect(breaker.tryAcquire()).toBe(true);
  });

  it("requires named hardware and explicit target or blocking-variance disposition", () => {
    const evidence: PerformanceEvidence = {
      generatedAt: new Date().toISOString(),
      hardware: {
        platform: platform(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        logicalCpus: cpus().length,
        totalMemoryBytes: totalmem(),
        freeMemoryBytes: freemem(),
      },
      results: LOAD_SCENARIOS.map((scenario) => ({
        scenarioId: scenario.id,
        accepted: scenario.workItems,
        lost: 0,
        target: assessPerformanceTarget(scenario.targetMs, scenario.targetMs),
      })),
    };

    expect(() => validatePerformanceEvidence(evidence)).not.toThrow();
    expect(assessPerformanceTarget(501, 500)).toEqual({
      disposition: "blocking_variance",
      actualMs: 501,
      targetMs: 500,
      varianceMs: 1,
    });
  });
});
