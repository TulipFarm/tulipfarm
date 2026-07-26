export const LOAD_SCENARIOS = [
  { id: "ingress_burst", workItems: 1000, targetMs: 1000 },
  { id: "concurrent_runs_1000", workItems: 1000, targetMs: 500 },
  { id: "long_waits", workItems: 1000, targetMs: 5000 },
  { id: "fan_out", workItems: 100, targetMs: 5000 },
  { id: "sse_reconnect", workItems: 1000, targetMs: 500 },
  { id: "integration_rate_limit", workItems: 1000, targetMs: 5000 },
  { id: "model_rate_limit", workItems: 1000, targetMs: 5000 },
] as const;

export type LoadScenarioId = (typeof LOAD_SCENARIOS)[number]["id"];

export type PerformanceTarget =
  | {
      readonly disposition: "met";
      readonly actualMs: number;
      readonly targetMs: number;
      readonly varianceMs: 0;
    }
  | {
      readonly disposition: "blocking_variance";
      readonly actualMs: number;
      readonly targetMs: number;
      readonly varianceMs: number;
    };

export interface PerformanceEvidence {
  readonly generatedAt: string;
  readonly hardware: {
    readonly platform: string;
    readonly cpuModel: string;
    readonly logicalCpus: number;
    readonly totalMemoryBytes: number;
    readonly freeMemoryBytes: number;
  };
  readonly results: readonly {
    readonly scenarioId: LoadScenarioId;
    readonly accepted: number;
    readonly lost: number;
    readonly target: PerformanceTarget;
  }[];
}

export function assessPerformanceTarget(actualMs: number, targetMs: number): PerformanceTarget {
  if (actualMs <= targetMs) {
    return { disposition: "met", actualMs, targetMs, varianceMs: 0 };
  }
  return {
    disposition: "blocking_variance",
    actualMs,
    targetMs,
    varianceMs: actualMs - targetMs,
  };
}

export function validatePerformanceEvidence(evidence: PerformanceEvidence): void {
  if (!Number.isFinite(Date.parse(evidence.generatedAt))) {
    throw new Error("performance evidence has an invalid timestamp");
  }
  if (
    evidence.hardware.platform.trim() === "" ||
    evidence.hardware.cpuModel.trim() === "" ||
    evidence.hardware.logicalCpus < 1 ||
    evidence.hardware.totalMemoryBytes < 1
  ) {
    throw new Error("performance evidence must name its hardware");
  }
  for (const scenario of LOAD_SCENARIOS) {
    const result = evidence.results.find((candidate) => candidate.scenarioId === scenario.id);
    if (!result) throw new Error(`missing performance result: ${scenario.id}`);
    if (result.accepted !== scenario.workItems || result.lost !== 0) {
      throw new Error(`accepted work was lost: ${scenario.id}`);
    }
    if (!["met", "blocking_variance"].includes(result.target.disposition)) {
      throw new Error(`performance target has no disposition: ${scenario.id}`);
    }
  }
}
