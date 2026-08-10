import type {
  ToolDispatchPort,
  ToolDispatchRequest,
  ToolDispatchResult,
} from "@tulipfarm/agent-runtime";
import { canonicalHash } from "@tulipfarm/schema";
import type { TurnEventWriter } from "./run-events";
import { buildToolPreview } from "./tool-preview";

// A successful `present`/`update_presentation`/`request_input` call's output shape (see
// `apps/api/src/surfaces/tools.ts`) — matched structurally rather than by tool name, since the
// loop's `output: unknown` carries no tool identity here and the worker does not own that contract.
function surfaceArtifactFrom(
  output: unknown
): { artifactId: string; componentId?: string } | undefined {
  const artifact = (output as { artifact?: { id?: unknown; component?: { name?: unknown } } })
    ?.artifact;
  if (typeof artifact?.id !== "string" || artifact.id.length === 0) return undefined;
  const componentId = artifact.component?.name;
  return typeof componentId === "string" && componentId.length > 0
    ? { artifactId: artifact.id, componentId }
    : { artifactId: artifact.id };
}

/** Injectable clock so a test can assert a duration instead of racing the real one. */
export interface AnnounceToolCallsOptions {
  readonly now?: () => number;
}

/**
 * Announces Tool activity on the durable stream (plan §1).
 *
 * The loop deliberately carries no Tool arguments or output, so the only place that can tell a
 * participant a Tool ran is the dispatch boundary — here. Arguments are announced as a digest and
 * never verbatim: they routinely hold the very data the call operates on, and this stream is read
 * by whoever is in the conversation. Alongside the digest goes a *preview* — the same values
 * walked through `buildToolPreview`, which replaces credential material and caps size — because a
 * digest alone told the person the Tool acted for nothing about what it did. The digest stays the
 * authority on what was called; the preview is only what may be shown. A successful call that
 * rendered a Surface Artifact also announces `surface.emitted` — the id (and, when known, the
 * component) only, never the props — so a live participant's client can fetch and render it the
 * same way a restored conversation already does.
 *
 * `tool.dispatched` — the operator evidence a duplicate delivery is reconciled against — is not
 * written here: it is keyed by the broker's idempotency key, and this wrapper does not hold one.
 * Synthesizing a key would put a reconciliation record in the log that reconciles nothing.
 */
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
          // The State this call belongs to. Real grouping data, so a reader can show the steps a
          // turn actually took instead of inferring them from adjacency.
          ...(request.stateId.length === 0 ? {} : { stepId: request.stateId }),
          startedAt: new Date(startedAt).toISOString(),
        },
        `tool:call:${request.callId}`
      );

      const result = await tools.dispatch(request);

      // An approval is not a result: the turn parks on a wait and the driver announces that. A
      // `tool.result` here would tell a reader the call finished while it is still pending.
      if (result.status === "awaiting_approval") return result;

      // Measured across the dispatch boundary, so it is the wait the participant actually saw,
      // including broker time — not just the Tool's own execution.
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
            },
        `tool:result:${request.callId}`
      );

      if (result.status === "succeeded") {
        const surface = surfaceArtifactFrom(result.output);
        if (surface !== undefined) {
          await events.emit("surface.emitted", surface, `surface:emitted:${request.callId}`);
        }
      }

      return result;
    },
  };
}
