import type {
  ToolDispatchPort,
  ToolDispatchRequest,
  ToolDispatchResult,
} from "@tulipfarm/agent-runtime";
import { canonicalHash } from "@tulipfarm/schema";
import type { TurnEventWriter } from "./run-events";
import { buildToolPreview } from "./tool-preview";

// Surface tool output is matched structurally; the worker has no tool identity here.
function surfaceArtifactFrom(
  output: unknown
): { artifactId: string; revision: number; componentId?: string } | undefined {
  const artifact = (
    output as {
      artifact?: { id?: unknown; revision?: unknown; component?: { name?: unknown } };
    }
  )?.artifact;
  if (typeof artifact?.id !== "string" || artifact.id.length === 0) return undefined;
  // A Surface minted without an explicit revision is its first.
  const revision = typeof artifact.revision === "number" ? artifact.revision : 1;
  const componentId = artifact.component?.name;
  return typeof componentId === "string" && componentId.length > 0
    ? { artifactId: artifact.id, revision, componentId }
    : { artifactId: artifact.id, revision };
}

/**
 * The Tool that declares a plan, and so the only Tool whose output may become one.
 *
 * Declared here rather than imported from `@tulipfarm/platform-tools`, which this package does not
 * depend on; `apps/api/src/tools/contract-coverage.test.ts` pins the registered spelling.
 */
const PLAN_TOOL = "plan_declare";

/**
 * Reads the plan out of a `plan_declare` call's arguments.
 *
 * Taken from the arguments at dispatch rather than from the echoed output at completion, so the
 * plan reaches the reader before the Round it describes has finished. `plan_declare` returns in
 * microseconds while the reads beside it in the same batch take seconds; publishing on the result
 * still beat those reads on the wire, but only by a margin too small to see, so every step in
 * Round 1 went from unstarted to done without ever rendering as in flight. Announcing the
 * declaration when it is made puts the whole first Round on screen while it is genuinely running.
 *
 * The consequence is deliberate: a `plan_declare` that then fails still shows its plan. That is
 * honest — the plan is what the Agent said it intended, and it did say it — and the failed Tool
 * row renders beside it rather than being hidden, so the refusal is not lost.
 *
 * Matched by Tool name, unlike a Surface. A Surface has several producers, so its structure is the
 * only thing they share; a plan has exactly one producer, and every other Tool reaching this path
 * may be an Integration whose arguments an attacker influenced. Matching a plan structurally would
 * let any third party whose payload carried a `rounds` key rewrite what the Agent told the reader
 * it was going to do.
 *
 * The bounds repeat the event schema's rather than trusting the Tool's own validation, because
 * `emit` validates and throws: a plan accepted here and rejected there would fail the Turn.
 */
function planFrom(
  name: string,
  args: unknown
): { rounds: { calls: { tool: string; label?: string }[] }[] } | undefined {
  if (name !== PLAN_TOOL) return undefined;
  const rounds = (args as { rounds?: unknown })?.rounds;
  if (!Array.isArray(rounds) || rounds.length < 2 || rounds.length > 8) return undefined;
  const parsed: { calls: { tool: string; label?: string }[] }[] = [];
  for (const round of rounds) {
    const calls = (round as { calls?: unknown })?.calls;
    if (!Array.isArray(calls) || calls.length === 0 || calls.length > 12) return undefined;
    const parsedCalls: { tool: string; label?: string }[] = [];
    for (const call of calls) {
      const tool = (call as { tool?: unknown })?.tool;
      if (typeof tool !== "string" || tool.length === 0 || tool.length > 80) return undefined;
      const label = (call as { label?: unknown })?.label;
      if (label !== undefined && (typeof label !== "string" || label.length > 120))
        return undefined;
      parsedCalls.push(typeof label === "string" && label.length > 0 ? { tool, label } : { tool });
    }
    parsed.push({ calls: parsedCalls });
  }
  return { rounds: parsed };
}

/** Injectable clock so a test can assert a duration instead of racing the real one. */
export interface AnnounceToolCallsOptions {
  readonly now?: () => number;
}

/** Announce Tool calls with digests/redacted previews; never synthesize `tool.dispatched`. */
export function announceToolCalls(
  tools: ToolDispatchPort,
  events: TurnEventWriter,
  options: AnnounceToolCallsOptions = {}
): ToolDispatchPort {
  const now = options.now ?? (() => Date.now());

  return {
    dispatch: async (request: ToolDispatchRequest): Promise<ToolDispatchResult> => {
      const startedAt = now();
      const argsPreview = buildToolPreview(request.arguments);

      await events.emit(
        "tool.call",
        {
          callId: request.callId,
          name: request.name,
          argsDigest: canonicalHash(request.arguments ?? null),
          ...(argsPreview === undefined ? {} : { argsPreview }),
          // Group by real State, not event adjacency.
          ...(request.stateId.length === 0 ? {} : { stepId: request.stateId }),
          // The loop's own dispatch decision. A call it ran alone carries none, so a reader can
          // never turn two adjacent calls into two concurrent ones.
          ...(request.batchId === undefined ? {} : { batchId: request.batchId }),
          startedAt: new Date(startedAt).toISOString(),
        },
        `tool:call:${request.callId}`
      );

      const plan = planFrom(request.name, request.arguments);
      if (plan !== undefined) {
        await events.emit(
          "plan.declared",
          { revision: events.nextPlanRevision(), rounds: plan.rounds },
          `plan:declared:${request.callId}`
        );
      }

      const result = await tools.dispatch(request);

      // A park suspends the Turn mid-call; `tool.result` waits for the replay that settles it.
      if (result.status === "awaiting_approval" || result.status === "awaiting_child") {
        return result;
      }

      // Duration includes broker time: the wait the participant saw.
      const durationMs = Math.max(0, now() - startedAt);

      await events.emit(
        "tool.result",
        result.status === "succeeded"
          ? (() => {
              const resultPreview = buildToolPreview(result.output);
              return {
                callId: result.callId,
                status: "ok" as const,
                ...(resultPreview === undefined ? {} : { resultPreview }),
                durationMs,
              };
            })()
          : {
              callId: result.callId,
              status: "error" as const,
              summary: result.reason,
              errorCode: result.status,
              durationMs,
              ...(result.status === "denied" && result.connectUrl !== undefined
                ? { connectUrl: result.connectUrl }
                : {}),
            },
        `tool:result:${request.callId}`
      );

      if (result.status === "succeeded") {
        const surface = surfaceArtifactFrom(result.output);
        if (surface !== undefined) {
          const { revision, ...emitted } = surface;
          events.recordSurface({ artifactId: surface.artifactId, revision });
          await events.emit("surface.emitted", emitted, `surface:emitted:${request.callId}`);
        }
      }

      return result;
    },
  };
}
