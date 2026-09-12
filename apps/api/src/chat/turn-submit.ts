import type { DurableInvocationGateway } from "@tulipfarm/run-kernel";
import { canonicalHash, type MessageFilePart } from "@tulipfarm/schema";
import type { FastifyBaseLogger } from "fastify";
import { type ChatTurnPrincipal, chatConversationService } from "../conversations/chat-turns";
import {
  ConversationIdempotencyConflictError,
  type ConversationStore,
  type NewConversation,
} from "../conversations/service";
import type { ConversationDoc } from "./conversations";

/** What the request a turn answers is addressed to, and what the user actually said. */
export interface ChatTurnRequest {
  readonly conversationId: string;
  readonly content: string;
  /** Files already resolved against the caller's authority; see `StartTurnInput.files`. */
  readonly files?: readonly MessageFilePart[];
  /** New Conversation draft. It commits with the winning Turn or not at all. */
  readonly newConversation?: ConversationDoc;
  /** Existing Conversation mutation committed only when this request creates a Turn. */
  readonly conversationUpdate?: { readonly agentId?: string };
}

/** The Run minted for a submitted turn. */
export interface ChatRunClaim {
  readonly runId: string;
  readonly businessId: string;
  /** The Turn this Run answers, so a retry can re-enter it instead of asking again. */
  readonly turnId: string;
  readonly conversationId: string;
  readonly conversationCreated: boolean;
  readonly replayed: boolean;
}

export type ChatSubmission =
  | { readonly outcome: "submitted"; readonly run: ChatRunClaim }
  | { readonly outcome: "conflict" };

/** One submitter writes the user Message once; equivalent replay resumes the established Run. */
export interface ChatTurnSubmitter {
  /** Fast replay check for callers that must avoid side effects before submission. */
  findSubmitted?(): Promise<
    | { readonly outcome: "replayed"; readonly runId: string }
    | { readonly outcome: "conflict" }
    | null
  >;
  submit(request: ChatTurnRequest): Promise<ChatSubmission>;
}

export interface DurableTurnSubmitterDeps {
  readonly store: ConversationStore;
  readonly invocations: DurableInvocationGateway;
  readonly principal: ChatTurnPrincipal;
  /** The request body normalized with the resolved Agent; published as the immutable request Artifact. */
  readonly payload: unknown;
  /** Raw normalized request used for idempotency; excludes mutable Conversation defaults. */
  readonly requestFingerprintPayload?: unknown;
  readonly agentId: string;
  readonly idempotencyKey: string;
  readonly log: FastifyBaseLogger;
}

function conversationReservation(conversation: ConversationDoc): NewConversation {
  if (conversation.userId === undefined) throw new Error("new_conversation_owner_missing");
  return {
    id: conversation._id,
    userId: conversation.userId,
    ...(conversation.agentId === undefined ? {} : { agentId: conversation.agentId }),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

/** Creates one durable Turn, Run, and request Artifact before streaming; leaves the Run queued. */
export function durableTurnSubmitter(deps: DurableTurnSubmitterDeps): ChatTurnSubmitter {
  const businessId = deps.principal.businessId;
  const requestFingerprint = canonicalHash(deps.requestFingerprintPayload ?? deps.payload);
  const findSubmitted = async () => {
    const existing = await deps.store.findTurnByIdempotencyKey(businessId, deps.idempotencyKey);
    if (existing?.runId === null || existing === undefined) return null;
    const messages = await deps.store.listMessages(businessId, existing.conversationId);
    const request = messages.find((message) => message.id === existing.requestMessageId);
    const fingerprint = request?.metadata?.submissionFingerprint;
    if (typeof fingerprint === "string" && fingerprint !== requestFingerprint) {
      return { outcome: "conflict" as const };
    }
    return { outcome: "replayed" as const, runId: existing.runId };
  };
  return {
    findSubmitted,
    submit: async ({ conversationId, content, files, newConversation, conversationUpdate }) => {
      const conversationToCreate =
        newConversation === undefined ? undefined : conversationReservation(newConversation);
      const conversations = chatConversationService(
        { store: deps.store, invocations: deps.invocations },
        { principal: deps.principal, payload: deps.payload, agentId: deps.agentId }
      );
      try {
        const started = await conversations.startTurn({
          businessId,
          conversationId,
          content,
          ...(files === undefined ? {} : { files }),
          idempotencyKey: deps.idempotencyKey,
          requestFingerprint,
          ...(conversationToCreate === undefined ? {} : { newConversation: conversationToCreate }),
          ...(conversationUpdate === undefined ? {} : { conversationUpdate }),
        });

        return {
          outcome: "submitted",
          run: {
            runId: started.runId,
            businessId,
            turnId: started.turnId,
            conversationId: started.conversationId,
            conversationCreated: started.conversationCreated,
            replayed: started.outcome === "replayed",
          },
        };
      } catch (error) {
        if (error instanceof ConversationIdempotencyConflictError) {
          return { outcome: "conflict" };
        }
        throw error;
      }
    },
  };
}
