import type { EventEmitter } from "node:events";
import type { SoulLoader } from "@tulipfarm/soul";
import type { FastifyBaseLogger } from "fastify";
import type { IngressUserLookup } from "../auth/users";
import { runHeadlessChatTurn } from "../chat/headless-chat-turn";
import type { ChatTurnContext } from "../chat/turn";
import { DOMAIN_EVENTS, type IntegrationEventPayload } from "../domain-events";
import type { HookExecutor } from "../hooks/hook-executor";
import type { ToolRegistry } from "../tools/registry";
import type { IngressIdentityResolver } from "./identity";
import type { IntegrationConversationsRepo, IntegrationEventsRepo } from "./repo";
import { postReply } from "./responder";
import type { IngressJobPayload } from "./routes";
import { dotPath, renderBodyTemplate } from "./template";

/** User-facing replies for failed turns — generic on purpose (no guard/stack internals). */
const GUARD_BLOCK_REPLY = "I can't help with that request.";
const ERROR_REPLY = "Something went wrong handling that — please try again.";

/**
 * The decision contract for an integration's sandboxed `classify(ctx)` — the ONLY code an
 * integration contributes to the ingress path. `ctx` carries `{ body, hasThreadMapping }`;
 * the returned value is validated structurally here (never trusted).
 */
export type IngressDecision =
  | { kind: "ignore"; reason?: string }
  | {
      kind: "chat";
      /** External sender id, fed to the identity binding as {sender}. */
      sender: string;
      /** Message text for the conversation turn. */
      text: string;
      /** Chat only if the thread mapping already exists (thread-following semantics). */
      requireExistingThread?: boolean;
      /** Which manifest reply binding posts the answer, and its template vars. */
      reply: { binding: string; vars?: Record<string, string> };
    }
  | { kind: "event"; eventType: string; payload?: Record<string, unknown> };

export interface IngressServiceDeps {
  soulLoader: SoulLoader;
  conversations: IntegrationConversationsRepo;
  integrationEvents: IntegrationEventsRepo;
  users: IngressUserLookup;
  identity: IngressIdentityResolver;
  chatCtx: ChatTurnContext;
  /** Sandbox for the integration's classify() — ingress is disabled without it. */
  hookExecutor: HookExecutor;
  toolRegistry?: ToolRegistry;
  /** Domain-event bus; integration.event emissions fan out to routine event triggers. */
  events?: EventEmitter;
  log: FastifyBaseLogger;
}

/**
 * The integration-ingress worker body. Runs the integration's sandboxed classifier over a
 * verified, deduped delivery and interprets the decision: chat (headless turn + reply binding)
 * or event (persist + domain event). Throw discipline: anything BEFORE the chat turn starts may
 * throw (pg-boss retries are safe — the delivery-dedup row already exists, so a provider retry
 * can't double-enqueue); once the turn has run, failures are logged and answered with a generic
 * reply, never rethrown (a retry would double-post the already-persisted user message).
 */
export async function handleIngressJob(
  payload: IngressJobPayload,
  deps: IngressServiceDeps
): Promise<void> {
  const { slug, body } = payload;
  const integration = deps.soulLoader.integrations.get(slug);
  if (!integration?.connection?.enabled) {
    deps.log.warn({ slug }, "ingress job for a missing/disconnected integration; dropping");
    return;
  }
  const ingress = integration.manifest.ingress;
  const handler = integration.ingressHandler;
  if (!ingress || !handler) {
    deps.log.warn({ slug }, "ingress job for an integration without a loaded handler; dropping");
    return;
  }

  // Host pre-computes the external thread key + mapping existence so the sandboxed classifier
  // (which cannot do I/O) can express thread-following via `requireExistingThread`.
  const threadKey = ingress.chat ? renderBodyTemplate(ingress.chat.thread_key, body) : undefined;
  const hasThreadMapping = threadKey ? await deps.conversations.exists(slug, threadKey) : false;

  // A classifier error/timeout throws → pg-boss retry (nothing persisted yet); a structurally
  // invalid decision is deterministic, so log and drop instead of retrying.
  const raw = await deps.hookExecutor.runRoutineHook(
    handler.source,
    "classify",
    { body, hasThreadMapping },
    null,
    `ingress:${slug}`,
    { expectedHash: handler.hash }
  );
  const decision = parseDecision(raw);
  if (!decision) {
    deps.log.error({ slug, raw }, "ingress classify() returned an invalid decision; dropping");
    return;
  }

  if (decision.kind === "ignore") {
    deps.log.debug({ slug, reason: decision.reason }, "ingress event ignored");
    return;
  }

  if (decision.kind === "event") {
    if (!ingress.events) {
      deps.log.warn({ slug }, "classify() returned an event but manifest declares no events");
      return;
    }
    if (ingress.events.types && !ingress.events.types.includes(decision.eventType)) {
      deps.log.debug({ slug, eventType: decision.eventType }, "event type not allowlisted");
      return;
    }
    const record = await deps.integrationEvents.insert({
      integrationSlug: slug,
      protocol: integration.sourceIntegration,
      eventType: decision.eventType,
      externalId: dedupId(body, ingress.webhook.dedup_key),
      payload: decision.payload ?? body,
    });
    const eventPayload: IntegrationEventPayload = {
      integration: slug,
      protocol: integration.sourceIntegration,
      event: decision.eventType,
      eventId: record.id,
      payload: decision.payload ?? body,
    };
    deps.events?.emit(DOMAIN_EVENTS.INTEGRATION_EVENT, eventPayload);
    return;
  }

  if (!ingress.chat || !threadKey) {
    deps.log.warn({ slug }, "classify() returned chat but manifest declares no chat ingress");
    return;
  }
  if (decision.requireExistingThread && !hasThreadMapping) {
    deps.log.debug({ slug }, "thread-following chat without an existing mapping; ignored");
    return;
  }
  await handleChat(slug, threadKey, decision, deps, integration.sourceIntegration);
}

async function handleChat(
  slug: string,
  threadKey: string,
  decision: Extract<IngressDecision, { kind: "chat" }>,
  deps: IngressServiceDeps,
  sourceIntegration: string
): Promise<void> {
  const integration = deps.soulLoader.integrations.get(slug);
  const chat = integration?.manifest.ingress?.chat;
  if (!chat) return;

  // Everything up to the turn may throw → pg-boss retry (nothing persisted yet).
  const sender = await deps.identity.resolve({
    slug,
    sender: decision.sender,
    identity: chat.identity,
    registry: deps.toolRegistry,
  });
  if (!sender) {
    deps.log.error({ slug }, "no TulipFarm user resolvable (no admin exists); dropping");
    return;
  }
  const mapping = await deps.conversations.find(slug, threadKey);
  // The turn must run as the conversation OWNER (prepareChatTurn enforces ownership). When a
  // different external user chimes into a mapped thread, attribute them in the message text.
  let runAs = sender;
  let text = decision.text;
  if (mapping && mapping.userId !== sender._id) {
    const owner = await deps.users.findById(mapping.userId);
    if (owner) {
      runAs = owner;
      text = `[From ${sourceIntegration} user ${decision.sender}] ${text}`;
    }
  }

  const replyVars = decision.reply.vars ?? {};
  const reply = (replyText: string) =>
    postReply(
      { registry: deps.toolRegistry, log: deps.log },
      { slug, reply: chat.reply, binding: decision.reply.binding, vars: replyVars, text: replyText }
    );

  // From here on: log-don't-throw (the user message is persisted inside the turn).
  try {
    const result = await runHeadlessChatTurn(deps.chatCtx, {
      user: runAs,
      body: {
        conversationId: mapping?.conversationId,
        message: { role: "user", content: text },
        autonomy: "full",
      },
      log: deps.log,
    });

    if (!mapping && result.conversationId) {
      await deps.conversations.insert({
        integrationSlug: slug,
        externalKey: threadKey,
        conversationId: result.conversationId,
        userId: runAs._id,
      });
    }

    const replyText =
      result.status === "ok"
        ? result.text.trim() || ERROR_REPLY
        : result.status === "guardrail_block"
          ? GUARD_BLOCK_REPLY
          : ERROR_REPLY;
    if (result.status !== "ok") {
      deps.log.warn(
        { slug, status: result.status, error: result.errorMessage },
        "ingress chat turn did not complete cleanly"
      );
    }
    await reply(replyText);
  } catch (err) {
    deps.log.error({ slug, err }, "ingress chat turn threw; posting generic error reply");
    await reply(ERROR_REPLY);
  }
}

/** Structural validation of the sandbox's return value — malformed decisions are dropped. */
export function parseDecision(raw: unknown): IngressDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (d.kind === "ignore") {
    return { kind: "ignore", reason: typeof d.reason === "string" ? d.reason : undefined };
  }
  if (d.kind === "event") {
    if (typeof d.eventType !== "string" || !d.eventType) return null;
    const payload =
      d.payload && typeof d.payload === "object" && !Array.isArray(d.payload)
        ? (d.payload as Record<string, unknown>)
        : undefined;
    return { kind: "event", eventType: d.eventType, payload };
  }
  if (d.kind === "chat") {
    if (typeof d.sender !== "string" || !d.sender) return null;
    if (typeof d.text !== "string") return null;
    const reply = d.reply as Record<string, unknown> | undefined;
    if (!reply || typeof reply !== "object" || typeof reply.binding !== "string") return null;
    let vars: Record<string, string> | undefined;
    if (reply.vars && typeof reply.vars === "object" && !Array.isArray(reply.vars)) {
      vars = {};
      for (const [k, v] of Object.entries(reply.vars as Record<string, unknown>)) {
        if (typeof v === "string") vars[k] = v;
      }
    }
    return {
      kind: "chat",
      sender: d.sender,
      text: d.text,
      requireExistingThread: d.requireExistingThread === true,
      reply: { binding: reply.binding, vars },
    };
  }
  return null;
}

function dedupId(body: Record<string, unknown>, dedupKey?: string): string | undefined {
  if (!dedupKey) return undefined;
  const value = dotPath(body, dedupKey);
  return typeof value === "string" ? value : undefined;
}
