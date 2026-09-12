import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { LlmService } from "@tulipfarm/llm";
import type { SoulLoader } from "@tulipfarm/soul";
import { DEFAULT_ASSISTANT_ID, getAgent, resolveAgent } from "@tulipfarm/soul";
import { DOMAIN_EVENTS } from "@tulipfarm/storage";
import type { FastifyBaseLogger } from "fastify";
import type { AssetPrincipal, TeamAssetService } from "../team-assets/service";
import { mayUseAgent } from "./agent-access";
import type { ConversationDoc, ConversationRepo } from "./conversations";
import { buildAndStoreTitle } from "./title";
import type { ChatBody } from "./turn-helpers";

/** Chat destination resolved before durable writes. New Conversations remain uncommitted drafts. */

export interface ResolvedConversation {
  readonly conversation: ConversationDoc;
  readonly isNew: boolean;
  /** The Agent this turn runs as; the request Artifact carries it to the Worker. */
  readonly agentId: string;
  /** Explicit hand-off to commit only if this request creates a Turn. */
  readonly agentIdToPersist?: string;
}

/** A request refused before anything durable exists; the route maps it to a status code. */
export interface ConversationEntryError {
  readonly status: 403 | 404;
  readonly error: string;
}

export function isConversationEntryError(
  value: ResolvedConversation | ConversationEntryError
): value is ConversationEntryError {
  return "status" in value;
}

export interface ConversationEntryDeps {
  readonly repo: ConversationRepo;
  readonly llmService: LlmService;
  readonly soulLoader?: SoulLoader;
  readonly events?: EventEmitter;
  readonly teamAssets?: Pick<TeamAssetService, "access">;
}

export interface ConversationEntryInput {
  readonly userId: string;
  readonly principal: AssetPrincipal;
  readonly body: ChatBody;
  readonly log: FastifyBaseLogger;
}

/** Resolves an existing Conversation or prepares a new one for atomic Turn submission. */
export async function resolveConversationEntry(
  deps: ConversationEntryDeps,
  input: ConversationEntryInput
): Promise<ResolvedConversation | ConversationEntryError> {
  const { repo, soulLoader } = deps;
  const { body, userId } = input;

  if (!body.conversationId) {
    const requested = body.agentId ? getAgent(soulLoader, body.agentId) : undefined;
    if (requested && !(await mayUseAgent(requested, input.principal, deps.teamAssets))) {
      return { status: 403, error: "Agent use access is required" };
    }
    const conversation = prepareConversation(input, requested?.id);
    return {
      conversation,
      isNew: true,
      agentId: conversation.agentId ?? DEFAULT_ASSISTANT_ID,
    };
  }

  const found = await repo.findById(body.conversationId);
  if (!found || found.userId !== userId) {
    return { status: 404, error: "conversation not found" };
  }

  // Sticky `@mention` hand-off: a mid-conversation mention re-targets the Agent until a
  // different mention. Unknown names are ignored — the composer only offers real Agents,
  // so persisting one would leave a dangling reference.
  const currentAgentId = found.agentId ?? DEFAULT_ASSISTANT_ID;
  // This is the edge that turns a handle into an identity: `body.agentId` is whatever the composer
  // put in the `@mention`, a name, and what is stored from here on is the Agent's permanent id.
  const mentioned = body.agentId ? getAgent(soulLoader, body.agentId) : undefined;
  const selected = mentioned ?? resolveAgent(soulLoader, currentAgentId);
  if (!selected) return { status: 404, error: "agent not found" };
  if (!(await mayUseAgent(selected, input.principal, deps.teamAssets))) {
    return { status: 403, error: "Agent use access is required" };
  }
  return {
    conversation: found,
    isNew: false,
    agentId: selected.id,
    ...(mentioned !== undefined && mentioned.id !== currentAgentId
      ? { agentIdToPersist: mentioned.id }
      : {}),
  };
}

export function announceConversationCreated(
  deps: ConversationEntryDeps,
  input: ConversationEntryInput,
  conversation: ConversationDoc
): void {
  deps.events?.emit(DOMAIN_EVENTS.CONVERSATION_CREATED, {
    conversationId: conversation._id,
    actorId: input.userId,
    agentId: conversation.agentId,
  });
  void buildAndStoreTitle({
    repo: deps.repo,
    getModel: () => deps.llmService.effortModel("fast"),
    id: conversation._id,
    prompt: input.body.message.content,
    log: input.log,
  });
}

function prepareConversation(
  input: ConversationEntryInput,
  agentId: string | undefined
): ConversationDoc {
  const now = new Date();
  return {
    _id: randomUUID(),
    userId: input.userId,
    agentId,
    model: undefined,
    createdAt: now,
    updatedAt: now,
  };
}
