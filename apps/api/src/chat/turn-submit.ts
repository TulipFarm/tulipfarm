import type { FastifyBaseLogger } from "fastify";
import { type ChatTurnPrincipal, chatConversationService } from "../conversations/chat-turns";
import type { ConversationStore } from "../conversations/service";
import type { DurableInvocationGateway } from "../runtime/invocation-gateway";

/** What the request a turn answers is addressed to, and what the user actually said. */
export interface ChatTurnRequest {
  readonly conversationId: string;
  readonly content: string;
}

/** The Run minted for a submitted turn. */
export interface ChatRunClaim {
  readonly runId: string;
  readonly businessId: string;
}

export type ChatSubmission =
  | { readonly outcome: "submitted"; readonly run?: ChatRunClaim }
  | { readonly outcome: "duplicate"; readonly runId: string };

/**
 * Persists the request a turn will answer, and names the durable Run that answers it.
 *
 * Exactly one submitter runs per turn and no other path writes the user Message, which is what keeps
 * that Message written once. A replayed request resolves to `duplicate` instead of answering the
 * same message twice.
 */
export interface ChatTurnSubmitter {
  /**
   * Resolves a request this submitter already answered, before the turn creates anything for it.
   * Checked ahead of opening the conversation, because a request with no `conversationId` would open
   * one (and generate its title) only to be refused — leaving a trail of empty conversations behind.
   */
  findSubmitted?(): Promise<{ readonly runId: string } | null>;
  submit(request: ChatTurnRequest): Promise<ChatSubmission>;
}

export interface DurableTurnSubmitterDeps {
  readonly store: ConversationStore;
  readonly invocations: DurableInvocationGateway;
  readonly principal: ChatTurnPrincipal;
  /** The request body verbatim; published as the Run's immutable request Artifact. */
  readonly payload: unknown;
  readonly agentId: string;
  readonly idempotencyKey: string;
  readonly log: FastifyBaseLogger;
}

/**
 * The submission path every channel converges on: one durable Turn, one Run, one request Artifact,
 * committed before anything streams.
 *
 * The Run is left `queued`. Whoever claims it executes it — a Worker, today, for every channel
 * alike — so this process minting the Run never means this process answering it.
 */
export function durableTurnSubmitter(deps: DurableTurnSubmitterDeps): ChatTurnSubmitter {
  const businessId = deps.principal.businessId;
  // `startTurn` resolves a replay to the same Turn and Run, but silently — and this turn must not
  // stream a second reply for a request already answered. The Turn row is that record. A Turn with
  // no Run yet resolves to null: its Message is durable and only the dispatch is missing, so the
  // turn proceeds and `startTurn` re-dispatches it without appending a second Message.
  const findSubmitted = async () => {
    const existing = await deps.store.findTurnByIdempotencyKey(businessId, deps.idempotencyKey);
    return existing?.runId ? { runId: existing.runId } : null;
  };
  return {
    findSubmitted,
    submit: async ({ conversationId, content }) => {
      // Re-checked after the conversation is opened: a replay that raced this turn must not stream.
      const replayed = await findSubmitted();
      if (replayed) return { outcome: "duplicate", runId: replayed.runId };

      const conversations = chatConversationService(
        { store: deps.store, invocations: deps.invocations },
        { principal: deps.principal, payload: deps.payload, agentId: deps.agentId }
      );
      const started = await conversations.startTurn({
        businessId,
        conversationId,
        content,
        idempotencyKey: deps.idempotencyKey,
      });

      return { outcome: "submitted", run: { runId: started.runId, businessId } };
    },
  };
}
