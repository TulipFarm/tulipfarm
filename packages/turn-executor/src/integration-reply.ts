import type { IngressReplyResult } from "@tulipfarm/schema";
import type { RunOutcome } from "./ports";

export type { IngressReplyResult } from "@tulipfarm/schema";

export function settleIntegrationReply(turn: RunOutcome, reply: IngressReplyResult): RunOutcome {
  if (reply.delivered) return turn;
  return {
    status:
      reply.outcome === "retryable" && reply.waitId !== undefined
        ? "waiting"
        : reply.outcome === "failed"
          ? "failed"
          : "needs_reconciliation",
    errorEvidenceRef: `delivery:${reply.outcome}`,
  };
}
