import { randomUUID } from "node:crypto";
import type { DurableInvocationGateway } from "@tulipfarm/run-kernel";
import { CHAT_REQUEST_SCHEMA_REF } from "@tulipfarm/schema";
import {
  ConversationService,
  type ConversationStore,
  type RunLauncher,
  type StartedTurn,
} from "./service";

export interface ChatTurnPrincipal {
  readonly kind: string;
  readonly id: string;
  readonly businessId: string;
}

export interface ChatTurnSubmission {
  readonly principal: ChatTurnPrincipal;
  /** The request body as accepted by the route; stored verbatim as the Run's request Artifact. */
  readonly payload: unknown;
  readonly agentId: string;
}

export interface ChatTurnDeps {
  readonly store: ConversationStore;
  readonly invocations: DurableInvocationGateway;
  readonly newId?: () => string;
  readonly now?: () => Date;
}

/**
 * Dispatches one interactive Turn through the persist-first gateway.
 *
 * The gateway's idempotency key is `${turnId}:${attempt}`, so re-dispatching a Turn whose Run
 * reference was lost resolves to the Run it already minted, while a `same_turn` retry (a higher
 * attempt) legitimately mints a new one.
 */
function chatRunLauncher(
  invocations: DurableInvocationGateway,
  submission: ChatTurnSubmission
): RunLauncher {
  const principal = {
    kind: submission.principal.kind,
    id: submission.principal.id,
  };
  return {
    start: async ({ businessId, turnId, attempt }) => {
      const result = await invocations.start({
        source: "chat",
        runSource: "chat",
        businessId,
        initiator: principal,
        effectiveSubject: principal,
        definitionRef: `published:agent:${submission.agentId}`,
        payload: submission.payload,
        payloadSchemaRef: CHAT_REQUEST_SCHEMA_REF,
        idempotencyKey: `${turnId}:${attempt}`,
      });
      return { runId: result.runId };
    },
  };
}

/**
 * A `ConversationService` bound to one submission, because the request payload and the submitting
 * principal are what the Run is minted from and neither is carried on the `RunLauncher` port.
 */
export function chatConversationService(
  deps: ChatTurnDeps,
  submission: ChatTurnSubmission
): ConversationService {
  return new ConversationService({
    store: deps.store,
    runs: chatRunLauncher(deps.invocations, submission),
    // The route authenticated this principal; a Turn is authorized when it stays inside that
    // principal's own business. No ability vocabulary is enforced in this deployment, so the grant
    // claims none rather than inventing names nothing checks.
    authorize: async (_action, businessId) =>
      businessId === submission.principal.businessId
        ? {
            businessId,
            principal: `${submission.principal.kind}:${submission.principal.id}`,
            abilities: [],
          }
        : null,
    newId: deps.newId ?? randomUUID,
    now: deps.now ?? (() => new Date()),
  });
}

export type { StartedTurn };
