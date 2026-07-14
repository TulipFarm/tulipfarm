import type { EventEmitter } from "node:events";
import type { SoulIntegration, SoulLoader } from "@tulipfarm/soul";
import type { FastifyBaseLogger } from "fastify";
import type { IngressUserLookup } from "../auth/users";
import { runHeadlessChatTurn } from "../chat/headless-chat-turn";
import type { ChatTurnContext } from "../chat/turn";
import { DOMAIN_EVENTS, type IntegrationEventPayload } from "../domain-events";
import type { ToolRegistry } from "../tools/registry";
import type { SlackIdentityResolver } from "./identity";
import type { IntegrationConversationsRepo, IntegrationEventsRepo } from "./repo";
import { postSlackReply } from "./responder";
import type { IngressJobPayload } from "./routes";
import { type ChatIngressMessage, classifySlackPayload } from "./slack-adapter";
import { type SlackAuthInfo, SlackClient } from "./slack-client";

/** User-facing Slack replies for failed turns — generic on purpose (no guard/stack internals). */
const GUARD_BLOCK_REPLY = "I can't help with that request.";
const ERROR_REPLY = "Something went wrong handling that — please try again.";

export interface IngressServiceDeps {
  soulLoader: SoulLoader;
  conversations: IntegrationConversationsRepo;
  integrationEvents: IntegrationEventsRepo;
  users: IngressUserLookup;
  identity: SlackIdentityResolver;
  chatCtx: ChatTurnContext;
  toolRegistry?: ToolRegistry;
  /** Domain-event bus; integration.event emissions fan out to routine event triggers. */
  events?: EventEmitter;
  log: FastifyBaseLogger;
  /** Injectable for tests. */
  makeClient?: (token: string) => SlackClient;
}

/** Per-boot auth.test cache (bot user id is stable for a given token). */
const authCache = new Map<string, SlackAuthInfo | null>();

/** Test hook: clear the per-boot auth.test cache. */
export function resetIngressAuthCache(): void {
  authCache.clear();
}

function botTokenFor(integration: SoulIntegration): string | undefined {
  const tokenEnv = integration.manifest.oauth?.["x-tulipfarm"]?.token_env ?? "SLACK_BOT_TOKEN";
  return integration.connection?.env?.[tokenEnv];
}

/**
 * The integration-ingress worker body. Classifies a verified, deduped delivery and runs the
 * matching path: chat (headless turn + Slack reply) or event (persist + domain event).
 * Throw discipline: anything BEFORE the chat turn starts may throw (pg-boss retries are safe —
 * the delivery-dedup row already exists, so a provider retry can't double-enqueue); once the
 * turn has run, failures are logged and answered with a generic Slack reply, never rethrown
 * (a retry would double-post the already-persisted user message).
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

  const token = botTokenFor(integration);
  const makeClient = deps.makeClient ?? ((t: string) => new SlackClient(t));
  const client = token ? makeClient(token) : null;

  let auth = authCache.get(slug);
  if (auth === undefined) {
    try {
      auth = client ? await client.authTest() : null;
    } catch (err) {
      deps.log.warn({ slug, err }, "slack auth.test failed; classifying without botUserId");
      auth = null;
    }
    authCache.set(slug, auth);
  }

  const decision = await classifySlackPayload(body, {
    botUserId: auth?.botUserId ?? null,
    hasThreadMapping: (teamId, channel, threadTs) =>
      deps.conversations.exists(slug, externalKey(teamId, channel, threadTs)),
  });

  if (decision.kind === "ignore") {
    deps.log.debug({ slug, reason: decision.reason }, "ingress event ignored");
    return;
  }

  if (decision.kind === "event") {
    const record = await deps.integrationEvents.insert({
      integrationSlug: slug,
      protocol: payload.protocol,
      eventType: decision.eventType,
      externalId: typeof body.event_id === "string" ? body.event_id : undefined,
      payload: decision.payload,
    });
    const eventPayload: IntegrationEventPayload = {
      integration: slug,
      protocol: payload.protocol,
      event: decision.eventType,
      eventId: record.id,
      payload: decision.payload,
    };
    deps.events?.emit(DOMAIN_EVENTS.INTEGRATION_EVENT, eventPayload);
    return;
  }

  await handleChat(slug, decision.msg, client, deps);
}

async function handleChat(
  slug: string,
  msg: ChatIngressMessage,
  client: SlackClient | null,
  deps: IngressServiceDeps
): Promise<void> {
  if (!client) {
    deps.log.error({ slug }, "chat ingress needs a bot token in the connection env; dropping");
    return;
  }
  // Everything up to the turn may throw → pg-boss retry (nothing persisted yet).
  const sender = await deps.identity.resolve(client, msg.slackUserId);
  if (!sender) {
    deps.log.error({ slug }, "no TulipFarm user resolvable (no admin exists); dropping");
    return;
  }
  const key = externalKey(msg.teamId, msg.channel, msg.threadTs);
  const mapping = await deps.conversations.find(slug, key);
  // The turn must run as the conversation OWNER (prepareChatTurn enforces ownership). When a
  // different Slack user chimes into a mapped thread, attribute them in the message text.
  let runAs = sender;
  let text = msg.text;
  if (mapping && mapping.userId !== sender._id) {
    const owner = await deps.users.findById(mapping.userId);
    if (owner) {
      runAs = owner;
      text = `[From Slack user <@${msg.slackUserId}>] ${text}`;
    }
  }

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
        externalKey: key,
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
    await postSlackReply(
      { toolRegistry: deps.toolRegistry, client, log: deps.log },
      {
        channel: msg.channel,
        text: replyText,
        threadTs: msg.isDm ? undefined : msg.threadTs,
      }
    );
  } catch (err) {
    deps.log.error({ slug, err }, "ingress chat turn threw; posting generic error reply");
    await postSlackReply(
      { toolRegistry: deps.toolRegistry, client, log: deps.log },
      { channel: msg.channel, text: ERROR_REPLY, threadTs: msg.isDm ? undefined : msg.threadTs }
    );
  }
}

function externalKey(teamId: string, channel: string, threadTs: string): string {
  return `${teamId}/${channel}/${threadTs}`;
}
