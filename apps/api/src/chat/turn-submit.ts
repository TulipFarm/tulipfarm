import type { FastifyBaseLogger } from "fastify";
import { type ChatTurnPrincipal, chatConversationService } from "../conversations/chat-turns";
import type { ConversationStore } from "../conversations/service";
import type { ChatTurnSubmitter } from "../runtime/chat-run";
import type { ChatRunLifecycle } from "../runtime/chat-run-lifecycle";
import type { DurableInvocationGateway } from "../runtime/invocation-gateway";
import { fromUserText, type MessageRepo } from "./messages";

/**
 * Writes the user Message and nothing else — the submitter for callers with no Turn table and no
 * invocation gateway wired. The turn still runs and stays visible in the UI, but nothing about it is
 * reconstructable: there is no Run, and no persisted request to reconstruct one from.
 */
export function messageOnlySubmitter(messageRepo: MessageRepo): ChatTurnSubmitter {
  return {
    submit: async ({ conversationId, content }) => {
      await messageRepo.create(fromUserText(conversationId, content));
      return { outcome: "submitted" };
    },
  };
}

export interface DurableTurnSubmitterDeps {
  readonly store: ConversationStore;
  readonly invocations: DurableInvocationGateway;
  readonly principal: ChatTurnPrincipal;
  /** The request body verbatim; published as the Run's immutable request Artifact. */
  readonly payload: unknown;
  readonly agentId: string;
  readonly idempotencyKey: string;
  readonly lifecycle?: ChatRunLifecycle;
  readonly log: FastifyBaseLogger;
}

/**
 * The submission path every channel converges on: one durable Turn, one Run, one request Artifact,
 * committed before anything streams.
 *
 * A replayed idempotency key resolves to the Turn that already answered the request instead of
 * appending a second Message, and the Run is claimed here — before the first byte — so the API owns
 * the Run it just minted rather than leaving it `queued` for a Worker to execute a second time.
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
      // Re-checked after prepare: a replay that raced this turn's own prepare still must not stream.
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

      const lifecycle = deps.lifecycle;
      if (!lifecycle) return { outcome: "submitted", run: { runId: started.runId, businessId } };

      // The API executes this turn in-process, so the Run must not stay `queued` for a worker to
      // claim and execute too. A lost race is logged, never fatal — the user still gets their reply,
      // it just streams without a lease.
      const claimed = await lifecycle.claim(businessId, started.runId);
      if (!claimed) {
        deps.log.warn(
          { runId: started.runId },
          "chat run was not claimable; streaming without a lease"
        );
        return { outcome: "submitted" };
      }

      return {
        outcome: "submitted",
        run: {
          runId: started.runId,
          businessId,
          abandonRun: async () => {
            const completed = await lifecycle.complete(businessId, started.runId, "failed");
            if (!completed) {
              deps.log.warn({ runId: started.runId }, "chat run was not releasable");
            }
          },
        },
      };
    },
  };
}
