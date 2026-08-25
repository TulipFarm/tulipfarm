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
          startedAt: new Date(startedAt).toISOString(),
        },
        `tool:call:${request.callId}`
      );

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
