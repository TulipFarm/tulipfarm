import type { EffortRoutingLogger, ModelRequirements } from "@tulipfarm/agent-runtime";
import { route } from "@tulipfarm/agent-runtime";
import type { RunEventEffortInference, RunEventPayloads } from "@tulipfarm/schema";
import type { PersistedRunEvent, RunEventStore } from "@tulipfarm/storage";
import type { EffortClassifierModelSource } from "./effort-classifier";
import { classifierRequirements, createEffortClassifier } from "./effort-classifier";

/**
 * The effort funnel, composed for one Run.
 *
 * `@tulipfarm/agent-runtime` decides; this module supplies the two things the decision cannot
 * reach from there — a quick-tier model to ask when the heuristic is undecided, and the decision
 * an earlier attempt already recorded.
 *
 * The second one is what keeps `auto` honest. Routing in this codebase must replay to the same
 * answer: `deriveModelRequirements` is kept pure for exactly that reason, and a model call in the
 * middle of routing would break it. So the first attempt records its decision on `model.routed`,
 * and every later attempt reads it back instead of asking again. The heuristic alone would already
 * replay identically; this covers the ambiguous prompts that reached stage 2.
 */

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
  /**
   * Resolves the quick tier for stage 2. Absent means stage 2 is unavailable and an ambiguous
   * prompt takes the middle rung — a deployment without a weak model must not be billed a strong
   * one for guessing.
   */
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

/**
 * A missing pin is a normal state, not a failure: the first attempt on a Run has nothing to read.
 * A pin that cannot be read is treated the same way — routing a turn is better than failing it,
 * and the decision this attempt makes is recorded in turn.
 */
async function readPin(
  source: PinnedEffortSource | undefined
): Promise<RunEventEffortInference | undefined> {
  if (source === undefined) return undefined;
  try {
    return await source.read();
  } catch {
    return undefined;
  }
}

/**
 * The inferred rung this Run already committed to, read out of its own event stream.
 *
 * The **earliest** record wins. A chat Run carries one turn, so every `effort_inferred` event on it
 * describes the same decision; taking the earliest means a re-dispatch replays the answer the
 * participant was originally routed to rather than the most recent guess.
 */
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
