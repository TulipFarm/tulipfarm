import type { ChildLinkAncestry } from "./children";
import type { SignalWaitInput, WaitSignalResult } from "./waits";

/**
 * Signal schema for a child Run reporting its own terminal status to a parked parent.
 *
 * Registration and delivery must agree on this ref — `authorizeSignal` rejects a mismatch — so it
 * is a constant rather than a caller-supplied string.
 */
export const CHILD_COMPLETION_SCHEMA_REF = "tulipfarm.run.child_completion.v1";

export type ChildTerminalStatus = "succeeded" | "failed" | "cancelled" | "expired";

export interface ChildCompletionDeps {
  readonly ancestry: ChildLinkAncestry;
  readonly waits: { signal(input: SignalWaitInput): Promise<WaitSignalResult> };
}

export interface ChildCompletionInput {
  readonly businessId: string;
  readonly childRunId: string;
  readonly status: ChildTerminalStatus;
  readonly completedAt: string;
}

export type ChildCompletionOutcome =
  | { readonly kind: "not_awaited" }
  | { readonly kind: "signalled"; readonly parentRunId: string; readonly result: WaitSignalResult };

/**
 * Resume the parent parked on a child that just reached a terminal status.
 *
 * The child's completion is detected by the worker, which never holds a resume token, so the
 * token is read back off the link row the spawn wrote. Returns `not_awaited` for an unparented,
 * detached, or fire-and-forget child — all ordinary, none an error.
 *
 * Idempotent: replaying the same completion redeems the same one-use token and the wait store
 * reports `duplicate` rather than resuming the parent twice.
 */
export async function signalChildCompletion(
  deps: ChildCompletionDeps,
  input: ChildCompletionInput
): Promise<ChildCompletionOutcome> {
  const link = await deps.ancestry.parentLink(input.businessId, input.childRunId);
  if (link === null || link.resume === null || link.detachedAt !== null) {
    return { kind: "not_awaited" };
  }

  const result = await deps.waits.signal({
    id: link.resume.waitId,
    businessId: input.businessId,
    runId: link.parentRunId,
    token: link.resume.token,
    principal: `run:${input.childRunId}`,
    schemaRef: CHILD_COMPLETION_SCHEMA_REF,
    correlationKey: input.childRunId,
    signalDigest: input.status,
    receivedAt: input.completedAt,
  });

  return { kind: "signalled", parentRunId: link.parentRunId, result };
}
