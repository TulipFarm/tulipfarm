import type {
  ToolDispatchPort,
  ToolDispatchRequest,
  ToolDispatchResult,
} from "@tulipfarm/agent-runtime";
import { canonicalHash } from "@tulipfarm/schema";
import type { TurnEventWriter } from "./run-events";

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

/**
 * Announces Tool activity on the durable stream (plan §1).
 *
 * The loop deliberately carries no Tool arguments or output, so the only place that can tell a
 * participant a Tool ran is the dispatch boundary — here. Arguments are announced as a digest and
 * never verbatim: they routinely hold the very data the call operates on, and this stream is read
 * by whoever is in the conversation. The result is announced as a status and the dispatcher's own
 * reason, which says whether the call worked without reproducing what it returned. A successful
 * call that rendered a Surface Artifact also announces `surface.emitted` — the id (and, when known,
 * the component) only, never the props — so a live participant's client can fetch and render it the
 * same way a restored conversation already does.
 *
 * `tool.dispatched` — the operator evidence a duplicate delivery is reconciled against — is not
 * written here: it is keyed by the broker's idempotency key, and this wrapper does not hold one.
 * Synthesizing a key would put a reconciliation record in the log that reconciles nothing.
 */
export function announceToolCalls(
  tools: ToolDispatchPort,
  events: TurnEventWriter
): ToolDispatchPort {
  return {
    dispatch: async (request: ToolDispatchRequest): Promise<ToolDispatchResult> => {
      await events.emit(
        "tool.call",
        {
          callId: request.callId,
          name: request.name,
          argsDigest: canonicalHash(request.arguments ?? null),
        },
        `tool:call:${request.callId}`
      );

      const result = await tools.dispatch(request);

      // An approval is not a result: the turn parks on a wait and the driver announces that. A
      // `tool.result` here would tell a reader the call finished while it is still pending.
      if (result.status === "awaiting_approval") return result;

      await events.emit(
        "tool.result",
        result.status === "succeeded"
          ? { callId: result.callId, status: "ok" }
          : {
              callId: result.callId,
              status: "error",
              summary: result.reason,
              errorCode: result.status,
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
