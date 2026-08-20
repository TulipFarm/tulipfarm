import { checkModelReachability } from "@tulipfarm/llm";
import type { HealthResult, ModelReachability } from "./health";

interface ReachabilityTarget {
  effortModel(preset: "balanced"): unknown;
}

/**
 * Turns a live provider call into the deployment's `llm` health verdict.
 *
 * The model is resolved per call rather than captured, so a probe started before the operator
 * connected a provider reports on what is configured now.
 */
export function modelReachability(llm: ReachabilityTarget): ModelReachability {
  return {
    async verify(): Promise<HealthResult> {
      // biome-ignore lint/suspicious/noExplicitAny: the probe target is structural by design.
      const report = await checkModelReachability(llm.effortModel("balanced") as any);
      if (report.verdict === "reachable") return { status: "ok" };
      return {
        status: report.verdict === "degraded" ? "degraded" : "down",
        ...(report.detail === undefined ? {} : { detail: report.detail }),
      };
    },
  };
}
