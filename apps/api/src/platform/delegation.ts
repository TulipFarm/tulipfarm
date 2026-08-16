import { randomUUID } from "node:crypto";
import {
  type AgentDelegationDeps,
  createAgentDelegation,
  DelegationError,
  type StartChildRunInput,
} from "@tulipfarm/agent-runtime";
import type { DurableInvocationGateway } from "@tulipfarm/run-kernel";
import type { ConversationRepo } from "../chat/conversations";
import { chatConversationService } from "../conversations/chat-turns";
import type { ConversationStore } from "../conversations/service";

export interface ChildConversationDeps {
  readonly conversations: Pick<ConversationRepo, "create">;
  readonly store: ConversationStore;
  readonly invocations: DurableInvocationGateway;
  readonly newId?: () => string;
  readonly now?: () => Date;
}

/** Mints the helper's Conversation and its chat Run through the only Run-minting door there is. */
export function startChildConversation(
  deps: ChildConversationDeps
): (input: StartChildRunInput) => Promise<{ childRunId: string; conversationId: string }> {
  const newId = deps.newId ?? randomUUID;
  const now = deps.now ?? (() => new Date());
  return async (input) => {
    const conversationId = newId();
    const timestamp = now();
    await deps.conversations.create({
      _id: conversationId,
      agentId: input.agentId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    // The helper acts as the delegating Agent, not as whoever prompted it: initiator and
    // effective subject must match or the invocation gateway refuses identity substitution.
    const principal = { kind: "agent", id: input.agentId, businessId: input.businessId };
    const payload = {
      conversationId,
      agentId: input.agentId,
      message: { role: "user", content: input.task },
    };
    const conversations = chatConversationService(
      { store: deps.store, invocations: deps.invocations, newId, now },
      { principal, payload, agentId: input.agentId }
    );
    const started = await conversations.startTurn({
      businessId: input.businessId,
      conversationId,
      content: input.task,
      idempotencyKey: `delegation:${input.parentRunId}:${conversationId}`,
    });
    return { childRunId: started.runId, conversationId };
  };
}

export type { AgentDelegationDeps };
export { createAgentDelegation, DelegationError };
