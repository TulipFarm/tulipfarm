import type { EffortRoutingLogger, ModelRequirements } from "@tulipfarm/agent-runtime";
import { route } from "@tulipfarm/agent-runtime";
import type { RunEventEffortInference, RunEventPayloads } from "@tulipfarm/schema";
import type { PersistedRunEvent, RunEventStore } from "@tulipfarm/storage";
import type { EffortClassifierModelSource } from "./effort-classifier";
import { classifierRequirements, createEffortClassifier } from "./effort-classifier";

/** Composes per-Run effort routing; ambiguous `auto` decisions replay from `model.routed`. */

/** Infers the rung for a turn that asked for `auto`. */
export interface EffortInferencePort {
  infer(
    prompt: string,
    requirements: ModelRequirements
  ): Promise<RunEventEffortInference | undefined>;
}

/** A decision recorded by an earlier attempt on this Run. */
export interface PinnedEffortSource {
  read(): Promise<RunEventEffortInference | undefined>;
}

export interface EffortInferenceOptions {
  /** Absent means ambiguous prompts take the middle rung, not a strong model. */
  readonly models?: EffortClassifierModelSource;
  readonly pinned?: PinnedEffortSource;
  /** Calibration hook. Wired now, consumed later. */
  readonly log?: EffortRoutingLogger;
  readonly timeoutMs?: number;
}

export function createEffortInference(options: EffortInferenceOptions): EffortInferencePort {
  return {
    async infer(prompt, requirements) {
      const pinned = await readPin(options.pinned);
      const classifier =
        options.models === undefined
          ? undefined
          : createEffortClassifier({
              models: options.models,
              requirements: classifierRequirements(requirements),
              ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            });

      const decision = await route(prompt, {
        ...(classifier === undefined ? {} : { classifier }),
        ...(pinned === undefined ? {} : { pinned }),
        ...(options.log === undefined ? {} : { log: options.log }),
      });

      return {
        ...decision,
        ...(decision.classifierLatencyMs === undefined
          ? {}
          : { classifierLatencyMs: Math.round(decision.classifierLatencyMs) }),
      };
    },
  };
}

/** Missing or unreadable pins are routed anew; this attempt records the decision. */
async function readPin(
  source: PinnedEffortSource | undefined
): Promise<RunEventEffortInference | undefined> {
  if (source === undefined) return undefined;
  try {
    return await source.read();
  } catch {
    // An unreadable pin yields no inferred effort; the default applies.
    return undefined;
  }
}

/** Reads the earliest inferred rung so re-dispatch replays the original route. */
export function recordedEffortInference(
  events: readonly PersistedRunEvent[]
): RunEventEffortInference | undefined {
  for (const event of events) {
    if (event.eventType !== "model.routed") continue;
    const payload = event.payload as RunEventPayloads["model.routed"];
    if (payload.outcome === "raw_model") continue;
    if (payload.resolution !== "effort_inferred") continue;
    if (payload.effortInference !== undefined) return payload.effortInference;
  }
  return undefined;
}

/** Reads the pin off the durable Run event stream. */
export function runEventEffortPin(
  events: Pick<RunEventStore, "list">,
  businessId: string,
  runId: string
): PinnedEffortSource {
  return {
    async read() {
      // Routing evidence is operator audience, and a turn writes few events before its first model
      // call, so the first page is enough to find a decision if one was ever recorded.
      const page = await events.list(businessId, runId, { after: 0, audiences: ["operator"] });
      return recordedEffortInference(page);
    },
  };
}
