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

/** Chat destination resolved before durable writes; the conversation must exist before the Run. */

export interface ResolvedConversation {
  readonly conversation: ConversationDoc;
  readonly isNew: boolean;
  /** The Agent this turn runs as; the request Artifact carries it to the Worker. */
  readonly agentId: string;
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

/** Opens or loads the conversation before Message, Turn, or Run creation. */
export async function resolveConversationEntry(
  deps: ConversationEntryDeps,
  input: ConversationEntryInput
): Promise<ResolvedConversation | ConversationEntryError> {
  const { repo, soulLoader } = deps;
  const { body, userId, log } = input;

  if (!body.conversationId) {
    const requested = body.agentId ? getAgent(soulLoader, body.agentId) : undefined;
    if (requested && !(await mayUseAgent(requested, input.principal, deps.teamAssets))) {
      return { status: 403, error: "Agent use access is required" };
    }
    const conversation = await openConversation(deps, input, requested?.id);
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
  if (mentioned && mentioned.id !== currentAgentId) {
    found.agentId = mentioned.id;
    try {
      await repo.setAgent(found._id, mentioned.id);
    } catch (err) {
      // Non-fatal: the turn still runs as the mentioned Agent, it just does not stick to the
      // conversation. Failing the request would be a worse answer to a transient database error.
      log.error({ err, conversationId: found._id }, "setAgent (user @mention switch) failed");
    }
  }

  await repo.touch(found._id);
  return { conversation: found, isNew: false, agentId: found.agentId ?? DEFAULT_ASSISTANT_ID };
}

async function openConversation(
  deps: ConversationEntryDeps,
  input: ConversationEntryInput,
  agentId: string | undefined
): Promise<ConversationDoc> {
  const now = new Date();
  const conversation: ConversationDoc = {
    _id: randomUUID(),
    userId: input.userId,
    agentId,
    model: undefined,
    createdAt: now,
    updatedAt: now,
  };
  await deps.repo.create(conversation);
  deps.events?.emit(DOMAIN_EVENTS.CONVERSATION_CREATED, {
    conversationId: conversation._id,
    actorId: input.userId,
    agentId,
  });
  // Best-effort and off the critical path: the title is derived from the first message by the quick
  // tier and lands whenever it lands. A failure degrades to a truncated-prompt fallback.
  void buildAndStoreTitle({
    repo: deps.repo,
    getModel: () => deps.llmService.effortModel("fast"),
    id: conversation._id,
    prompt: input.body.message.content,
    log: input.log,
  });
  return conversation;
}
