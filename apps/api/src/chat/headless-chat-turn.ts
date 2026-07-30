import {
  type ChatTurnContext,
  type ChatTurnSubmitter,
  isPrepareError,
  prepareChatTurn,
  startChatTurn,
  type TurnInput,
} from "../runtime/chat-run";

export type HeadlessTurnStatus = "ok" | "guardrail_block" | "error" | "prepare_error" | "duplicate";

export interface HeadlessTurnResult {
  /** Set for every launched turn (absent only on prepare_error before a conversation resolved). */
  conversationId?: string;
  /** Final assistant text, concatenated across the turn's text deltas (and any handoffs). */
  text: string;
  status: HeadlessTurnStatus;
  /** Human-readable failure detail for status error/prepare_error. */
  errorMessage?: string;
  /** The guard's user-facing message (or reason) for status guardrail_block. */
  guardReason?: string;
}

/**
 * Run one chat turn without an HTTP connection and collect the final assistant text — the
 * programmatic twin of runChatTurn used by integration ingress (Slack) and other headless
 * callers. Exactly the same turn pipeline (guardrails, compaction, persistence, stream_resume
 * buffering — the turn even remains resumable/visible in the web UI); the only difference is
 * that the result is folded from the persisted stream events after the detached producer
 * finishes, instead of being piped to a socket.
 *
 * The request is submitted through the same `ChatTurnSubmitter` the HTTP route uses, so there is one
 * submission path in the process rather than one per entrypoint.
 */
export async function runHeadlessChatTurn(
  ctx: ChatTurnContext,
  input: TurnInput,
  submitter: ChatTurnSubmitter
): Promise<HeadlessTurnResult> {
  const replayed = await submitter.findSubmitted?.();
  if (replayed) {
    // Answered already, and preparing would open a conversation for a turn that will not run.
    return { text: "", status: "duplicate" };
  }
  const prepared = await prepareChatTurn(ctx, input);
  if (isPrepareError(prepared)) {
    await input.abandonRun?.();
    return { text: "", status: "prepare_error", errorMessage: prepared.error };
  }
  const submission = await submitter.submit({
    conversationId: prepared.convo._id,
    content: input.body.message.content,
  });
  if (submission.outcome === "duplicate") {
    // Already submitted and already answered by a Run; running the turn again would reply twice to
    // one message.
    return { conversationId: prepared.convo._id, text: "", status: "duplicate" };
  }
  const handle = await startChatTurn(ctx, prepared, { ...input, ...submission.run });
  await handle.done;

  const events = await ctx.streamRepo.listAfter(handle.streamId, 0);
  let text = "";
  let status: HeadlessTurnStatus = "ok";
  let errorMessage: string | undefined;
  let guardReason: string | undefined;
  for (const ev of events) {
    if (ev.eventType === "text") {
      const delta = (ev.data as { delta?: unknown }).delta;
      if (typeof delta === "string") text += delta;
    } else if (ev.eventType === "guardrail_block") {
      status = "guardrail_block";
      const data = ev.data as { reason?: unknown; message?: unknown };
      guardReason =
        typeof data.message === "string"
          ? data.message
          : typeof data.reason === "string"
            ? data.reason
            : undefined;
    } else if (ev.eventType === "error") {
      status = "error";
      const message = (ev.data as { message?: unknown }).message;
      errorMessage = typeof message === "string" ? message : undefined;
    }
  }
  return { conversationId: handle.conversationId, text, status, errorMessage, guardReason };
}
