import type { DurableInvocationGateway } from "@tulipfarm/run-kernel";
import type { MessageFilePart } from "@tulipfarm/schema";
import type { FastifyBaseLogger } from "fastify";
import { type ChatTurnPrincipal, chatConversationService } from "../conversations/chat-turns";
import type { ConversationStore } from "../conversations/service";

/** What the request a turn answers is addressed to, and what the user actually said. */
export interface ChatTurnRequest {
  readonly conversationId: string;
  readonly content: string;
  /** Files already resolved against the caller's authority; see `StartTurnInput.files`. */
  readonly files?: readonly MessageFilePart[];
}

/** The Run minted for a submitted turn. */
export interface ChatRunClaim {
  readonly runId: string;
  readonly businessId: string;
  /** The Turn this Run answers, so a retry can re-enter it instead of asking again. */
  readonly turnId: string;
}

export type ChatSubmission =
  | { readonly outcome: "submitted"; readonly run?: ChatRunClaim }
  | { readonly outcome: "duplicate"; readonly runId: string };

/** One submitter writes the user Message once; replay resolves to `duplicate`. */
export interface ChatTurnSubmitter {
  /** Checks duplicates before opening a conversation, avoiding empty refused conversations. */
  findSubmitted?(): Promise<{ readonly runId: string } | null>;
  submit(request: ChatTurnRequest): Promise<ChatSubmission>;
}

export interface DurableTurnSubmitterDeps {
  readonly store: ConversationStore;
  readonly invocations: DurableInvocationGateway;
  readonly principal: ChatTurnPrincipal;
  /** The request body normalized with the resolved Agent; published as the immutable request Artifact. */
  readonly payload: unknown;
  readonly agentId: string;
  readonly idempotencyKey: string;
  readonly log: FastifyBaseLogger;
}

/** Creates one durable Turn, Run, and request Artifact before streaming; leaves the Run queued. */
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
    submit: async ({ conversationId, content, files }) => {
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
        ...(files === undefined ? {} : { files }),
        idempotencyKey: deps.idempotencyKey,
      });

      return {
        outcome: "submitted",
        run: { runId: started.runId, businessId, turnId: started.turnId },
      };
    },
  };
}
