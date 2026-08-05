import { randomUUID } from "node:crypto";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { DurableInvocationGateway } from "@tulipfarm/run-kernel";
import type { SoulLoader } from "@tulipfarm/soul";
import type { ChannelRunDeliveryStore } from "@tulipfarm/storage";
import { surfaceActionKey } from "@tulipfarm/surface";
import { createSlackRenderer } from "@tulipfarm/surface-slack";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ToolApprovalService } from "../approvals/tool-approvals";
import { ErrorSchema } from "../auth/schemas";
import type { ConversationRepo } from "../chat/conversations";
import { durableTurnSubmitter } from "../chat/turn-submit";
import type { ChatTurnPrincipal } from "../conversations/chat-turns";
import type { ConversationStore } from "../conversations/service";
import type { IngressIdentityResolver } from "../ingress/identity";
import type { IntegrationConversationsRepo } from "../ingress/repo";
import { integrationSecretKey } from "../integrations/connection-env";
import { getAgent, getDefaultAssistant } from "../soul/agents/registry";
import type { SurfaceActionStore } from "../surfaces/action-store";
import type { SurfaceArtifactStore } from "../surfaces/artifact-store";

/** The subset of `SecretsService` the credential route needs (narrow for testability). */
export interface ChannelCredentialSecretStore {
  get(key: string): Promise<string>;
}

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * `/api/v1/internal/channels/*` — what `apps/integration-worker` calls back into to satisfy the
 * Channel ports (`packages/integrations/src/channels/ports.ts`) it cannot implement locally: it may
 * not import `apps/api`, so identity resolution, Run minting, reply reading, and approval decisions
 * all cross this boundary. Service-principal-only, same two gates as `registerInternalTurnRoutes`.
 */
export interface ChannelInternalRouteDeps {
  readonly store: ConversationStore;
  readonly invocations: DurableInvocationGateway;
  readonly conversations: ConversationRepo;
  readonly threads: IntegrationConversationsRepo;
  readonly identity: IngressIdentityResolver;
  readonly runDeliveries: ChannelRunDeliveryStore;
  readonly toolApprovals: ToolApprovalService;
  /** Backs rendering the Slack blocks for a Surface Artifact presented during a Channel Turn. */
  readonly surfaceStore?: SurfaceArtifactStore;
  /** Recovers the button/select handles minted when the Artifact was presented, for rendering. */
  readonly surfaceActionStore?: SurfaceActionStore;
  /**
   * Resolves the Slack bot/app-level tokens sealed at connect time (`sealConnectionEnv`) via the
   * fixed `integration.slack.SLACK_*_TOKEN` secret keys. Omitted routes report `credential/slack`
   * as unconfigured rather than failing app boot.
   */
  readonly secrets?: ChannelCredentialSecretStore;
  /** Resolves an Agent's human-readable `frontmatter.label` for `.../reply`'s `agentDisplayName`. */
  readonly soulLoader?: SoulLoader;
  readonly newId?: () => string;
  /**
   * Builds the user-facing bind-link URL from a raw token. Reused by the bind-offer route below —
   * see `bindLinkUrl` in `apps/api/src/index.ts` for why it must point at the web origin, not this
   * API's own host.
   */
  readonly bindLinkUrl: (token: string) => string;
}

interface ChannelMessageBody {
  externalAppId: string;
  channelId: string;
  threadId?: string;
  text: string;
}

function externalThreadKey(provider: string, message: ChannelMessageBody): string {
  return `${provider}:${message.channelId}:${message.threadId ?? message.channelId}`;
}

/**
 * The Slack Block Kit blocks for whatever Surface Artifact `present`/`update_presentation` last
 * produced for this Run, or `null` when there is none (no Artifact, not a Slack message target, or
 * a render the renderer itself refused — e.g. a provider limit). Rendering here, server-side, keeps
 * `apps/surface-slack` the only place that knows Block Kit shape; `integration-worker` stays a pure
 * transport for whatever this returns.
 */
async function slackBlocksForReply(
  deps: ChannelInternalRouteDeps,
  businessId: string,
  runId: string
): Promise<readonly Record<string, unknown>[] | null> {
  if (!deps.surfaceStore) return null;
  const artifact = await deps.surfaceStore.findByRun(runId);
  if (artifact?.target.channel !== "slack" || artifact.target.surface !== "message") {
    return null;
  }
  const delivery = await deps.runDeliveries.find(businessId, runId);
  if (!delivery) return null;

  const handles = deps.surfaceActionStore
    ? await deps.surfaceActionStore.listForArtifact(
        artifact.id,
        artifact.revision,
        delivery.principalId
      )
    : {};
  try {
    const rendered = createSlackRenderer("message").render(artifact, {
      destination: delivery.destination,
      principal: delivery.principalId,
      actionHandleFor: (action) => handles[surfaceActionKey(action)],
    });
    return rendered.blocks as unknown as readonly Record<string, unknown>[];
  } catch {
    return null;
  }
}

/**
 * The Agent's human-readable `frontmatter.label` for a Conversation, falling back to its raw
 * `agentId` when the Agent (or its label) cannot be resolved — never the unlisted default
 * harness's internal slug (`DEFAULT_ASSISTANT_NAME`), which must never reach a delivery surface.
 */
async function agentDisplayNameFor(
  deps: ChannelInternalRouteDeps,
  conversationId: string
): Promise<string | undefined> {
  const conversation = await deps.conversations.findById(conversationId).catch(() => null);
  const agentId = conversation?.agentId;
  const agent = getAgent(deps.soulLoader, agentId ?? "") ?? getDefaultAssistant(agentId);
  const label = agent?.frontmatter.label;
  return typeof label === "string" ? label : undefined;
}

export function registerChannelInternalRoutes(
  app: FastifyInstance,
  deps: ChannelInternalRouteDeps,
  requireAuth: PreHandler
): void {
  const requireService: PreHandler = async (req, reply) => {
    if (req.principal?.kind !== "service") {
      await reply.code(403).send({ error: "internal channel host is service-only" });
    }
  };
  const preHandler = [requireAuth, requireService];
  const newId = deps.newId ?? randomUUID;

  app.post(
    "/api/v1/internal/channels/identity/resolve",
    {
      preHandler,
      schema: {
        description:
          "Resolve a verified Channel sender to its own Tulip principal. Never substitutes " +
          "another user — an unmapped sender resolves to `linked: false`, and the bind link that " +
          "could fix that is never handed to a worker.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: {
          type: "object",
          required: ["provider", "externalSubject"],
          additionalProperties: false,
          properties: {
            provider: { type: "string", minLength: 1 },
            externalSubject: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["linked"],
            properties: {
              linked: { type: "boolean" },
              principal: {
                type: "object",
                required: ["kind", "id"],
                properties: { kind: { type: "string" }, id: { type: "string" } },
              },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { provider, externalSubject } = req.body as {
        provider: string;
        externalSubject: string;
      };
      const resolution = await deps.identity.resolve({ slug: provider, sender: externalSubject });
      if (resolution.outcome === "unlinked") return reply.send({ linked: false });
      return reply.send({ linked: true, principal: { kind: "user", id: resolution.user._id } });
    }
  );

  app.post(
    "/api/v1/internal/channels/identity/bind-offer",
    {
      preHandler,
      schema: {
        description:
          "Answers an unmapped Slack sender with a single-use bind link, posted to Slack from " +
          "this process. The bind token is a bearer credential and must never cross into a " +
          "Worker process (see `apps/api/src/internal/delivery-host.ts`'s module doc), so this " +
          "route resolves the offer and posts the reply itself rather than handing the token back.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: {
          type: "object",
          required: ["provider", "externalSubject", "channelId"],
          additionalProperties: false,
          properties: {
            provider: { type: "string", minLength: 1 },
            externalSubject: { type: "string", minLength: 1 },
            channelId: { type: "string", minLength: 1 },
            threadId: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["outcome"],
            properties: {
              outcome: { type: "string", enum: ["sent", "no_offer", "unconfigured"] },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { provider, externalSubject, channelId, threadId } = req.body as {
        provider: string;
        externalSubject: string;
        channelId: string;
        threadId?: string;
      };
      const resolution = await deps.identity.resolve({ slug: provider, sender: externalSubject });
      if (resolution.outcome === "linked" || resolution.bindOffer === null) {
        return reply.send({ outcome: "no_offer" });
      }

      if (deps.secrets === undefined) return reply.send({ outcome: "unconfigured" });
      const botToken = await deps.secrets
        .get(integrationSecretKey("slack", "SLACK_BOT_TOKEN"))
        .catch(() => undefined);
      if (botToken === undefined) return reply.send({ outcome: "unconfigured" });

      const text = "I don't know who you are yet — connect your account to talk to me.";
      const blocks = [
        {
          type: "section",
          text: { type: "mrkdwn", text: `${text} It works once and expires in 15 minutes.` },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Connect account" },
              url: deps.bindLinkUrl(resolution.bindOffer.token),
              style: "primary",
            },
          ],
        },
      ];
      try {
        // Ephemeral, not postMessage: only the sender who triggered this — never the rest of the
        // channel — may see (or click) their own single-use bind link.
        const res = await fetch("https://slack.com/api/chat.postEphemeral", {
          method: "POST",
          headers: {
            authorization: `Bearer ${botToken}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            channel: channelId,
            user: externalSubject,
            text,
            blocks,
            ...(threadId === undefined ? {} : { thread_ts: threadId }),
          }),
        });
        const body = (await res.json()) as { ok: boolean; error?: string };
        if (!body.ok) {
          req.log.warn({ error: body.error }, "slack bind-offer reply failed");
          return reply.send({ outcome: "unconfigured" });
        }
      } catch (err) {
        req.log.warn({ err }, "slack bind-offer reply failed");
        return reply.send({ outcome: "unconfigured" });
      }
      return reply.send({ outcome: "sent" });
    }
  );

  app.post(
    "/api/v1/internal/channels/runs",
    {
      preHandler,
      schema: {
        description:
          "Mint (or replay-resolve) the durable Run that answers one Channel message. The " +
          "external thread maps 1:1 onto a Conversation, created on first message and reused " +
          "after; `eventId` is the Turn's idempotency key, so a redelivered event never answers " +
          "twice.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: {
          type: "object",
          required: [
            "eventId",
            "provider",
            "integrationId",
            "routeId",
            "agentId",
            "principal",
            "message",
          ],
          additionalProperties: false,
          properties: {
            eventId: { type: "string", minLength: 1 },
            provider: { type: "string", minLength: 1 },
            integrationId: { type: "string", minLength: 1 },
            routeId: { type: "string", minLength: 1 },
            agentId: { type: "string", minLength: 1 },
            principal: {
              type: "object",
              required: ["kind", "id"],
              additionalProperties: false,
              properties: {
                kind: { type: "string", enum: ["user", "guest"] },
                id: { type: "string" },
              },
            },
            message: {
              type: "object",
              required: ["externalAppId", "channelId", "text"],
              additionalProperties: false,
              properties: {
                externalAppId: { type: "string" },
                channelId: { type: "string" },
                threadId: { type: "string" },
                text: { type: "string" },
              },
            },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["runId", "outcome"],
            properties: {
              runId: { type: "string" },
              outcome: { type: "string", enum: ["started", "duplicate"] },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body as {
        eventId: string;
        provider: string;
        integrationId: string;
        routeId: string;
        agentId: string;
        principal: { kind: "user" | "guest"; id: string };
        message: ChannelMessageBody;
      };
      const businessId = DEPLOYMENT_BUSINESS_ID;
      const threadKey = externalThreadKey(body.provider, body.message);

      let mapping = await deps.threads.find(body.provider, threadKey);
      if (mapping === null) {
        const conversationId = newId();
        const now = new Date();
        await deps.conversations.create({
          _id: conversationId,
          userId: body.principal.id,
          agentId: body.agentId,
          createdAt: now,
          updatedAt: now,
        });
        await deps.threads.insert({
          integrationSlug: body.provider,
          externalKey: threadKey,
          conversationId,
          userId: body.principal.id,
        });
        mapping = {
          integrationSlug: body.provider,
          externalKey: threadKey,
          conversationId,
          userId: body.principal.id,
        };
      }

      const principal: ChatTurnPrincipal = {
        kind: body.principal.kind,
        id: body.principal.id,
        businessId,
      };
      // The request Artifact must satisfy CHAT_REQUEST_SCHEMA_REF, which every turn — channel or
      // not — is minted against; the raw provider envelope does not conform, so it is normalized
      // into the same chat-shaped payload the web client sends.
      const submitter = durableTurnSubmitter({
        store: deps.store,
        invocations: deps.invocations,
        principal,
        payload: {
          conversationId: mapping.conversationId,
          agentId: body.agentId,
          message: { role: "user" as const, content: body.message.text },
        },
        agentId: body.agentId,
        idempotencyKey: body.eventId,
        log: req.log as FastifyBaseLogger,
      });
      const submission = await submitter.submit({
        conversationId: mapping.conversationId,
        content: body.message.text,
      });

      if (submission.outcome === "duplicate") {
        return reply.send({ runId: submission.runId, outcome: "duplicate" });
      }

      const runId = submission.run?.runId;
      if (runId === undefined) {
        return reply.code(409).send({ error: "run_not_started" });
      }

      await deps.runDeliveries.create({
        businessId,
        runId,
        integrationId: body.integrationId,
        routeId: body.routeId,
        provider: body.provider,
        destination: body.message.channelId,
        ...(body.message.threadId === undefined ? {} : { threadId: body.message.threadId }),
        agentId: body.agentId,
        principalId: body.principal.id,
        idempotencyKey: body.eventId,
      });

      return reply.send({ runId, outcome: "started" });
    }
  );

  app.get(
    "/api/v1/internal/channels/runs/:runId/reply",
    {
      preHandler,
      schema: {
        description:
          "The recorded answer for a finished Channel Run, read out of the durable conversation " +
          "— never generated here. `pending` when the Turn has not completed the attempt yet.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: {
          type: "object",
          required: ["runId"],
          properties: { runId: { type: "string", minLength: 1 } },
        },
        querystring: {
          type: "object",
          properties: { attempt: { type: "integer", minimum: 1 } },
        },
        response: {
          200: {
            type: "object",
            required: ["status"],
            properties: {
              status: { type: "string", enum: ["succeeded", "failed", "pending"] },
              text: { type: "string" },
              agentDisplayName: { type: "string" },
              blocks: { type: "array", items: { type: "object", additionalProperties: true } },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId } = req.params as { runId: string };
      const { attempt } = req.query as { attempt?: number };
      const businessId = DEPLOYMENT_BUSINESS_ID;

      const turn = await deps.store.findTurnByRunId(businessId, runId);
      if (turn === undefined) return reply.code(404).send({ error: "run_not_found" });

      const completion = await deps.store.findCompletion(
        businessId,
        turn.id,
        attempt ?? turn.attempt
      );
      if (completion === undefined) return reply.send({ status: "pending" });
      if (completion.status !== "succeeded" || completion.messageId === null) {
        return reply.send({ status: "failed" });
      }

      const messages = await deps.store.listMessages(businessId, turn.conversationId);
      const answer = messages.find((message) => message.id === completion.messageId);
      const blocks = await slackBlocksForReply(deps, businessId, runId);
      const agentDisplayName = await agentDisplayNameFor(deps, turn.conversationId);
      return reply.send({
        status: "succeeded",
        text: answer?.content.trim() ?? "",
        ...(agentDisplayName ? { agentDisplayName } : {}),
        ...(blocks ? { blocks } : {}),
      });
    }
  );

  app.get(
    "/api/v1/internal/channels/runs/:runId/pending-approval",
    {
      preHandler,
      schema: {
        description:
          "The tool-call approval a Channel-originated Run is currently parked on, if any — read " +
          "here so a Channel host knows whether (and what) to post an Approve/Deny prompt for.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: {
          type: "object",
          required: ["runId"],
          properties: { runId: { type: "string", minLength: 1 } },
        },
        response: {
          200: {
            type: "object",
            required: ["pending"],
            properties: {
              pending: { type: "boolean" },
              approvalId: { type: "string" },
              toolName: { type: "string" },
              args: {},
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId } = req.params as { runId: string };
      const pending = await deps.toolApprovals.pendingForRun(runId);
      if (pending === null) return reply.send({ pending: false });
      return reply.send({
        pending: true,
        approvalId: pending.approvalId,
        toolName: pending.toolName,
        args: pending.args,
      });
    }
  );

  app.get(
    "/api/v1/internal/channels/slack/credential",
    {
      preHandler,
      schema: {
        description:
          "The Slack bot and app-level tokens sealed at connect time, resolved from the " +
          "encrypted secrets store. `apps/integration-worker` may not read secrets directly, so " +
          "it leases both tokens here rather than holding a long-lived plaintext copy of either.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["configured"],
            properties: {
              configured: { type: "boolean" },
              botToken: { type: "string" },
              appToken: { type: "string" },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      if (deps.secrets === undefined) return reply.send({ configured: false });
      const [botToken, appToken] = await Promise.all([
        deps.secrets.get(integrationSecretKey("slack", "SLACK_BOT_TOKEN")).catch(() => undefined),
        deps.secrets.get(integrationSecretKey("slack", "SLACK_APP_TOKEN")).catch(() => undefined),
      ]);
      if (botToken === undefined || appToken === undefined) {
        return reply.send({ configured: false });
      }
      return reply.send({ configured: true, botToken, appToken });
    }
  );

  app.post(
    "/api/v1/internal/channels/approvals/:approvalId/decide",
    {
      preHandler,
      schema: {
        description:
          "Resolve a Slack Block Kit Approve/Deny click to a tool-call approval decision. The " +
          "clicking sender is resolved to a principal here, in this process — a worker states " +
          "only the click, never the identity it decides as.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: {
          type: "object",
          required: ["approvalId"],
          properties: { approvalId: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          required: ["provider", "externalSubject", "decision"],
          additionalProperties: false,
          properties: {
            provider: { type: "string", minLength: 1 },
            externalSubject: { type: "string", minLength: 1 },
            decision: { type: "string", enum: ["approved", "denied"] },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["outcome"],
            properties: {
              outcome: {
                type: "string",
                enum: ["resumed", "already_settled", "forbidden", "not_found", "unlinked"],
              },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { approvalId } = req.params as { approvalId: string };
      const body = req.body as {
        provider: string;
        externalSubject: string;
        decision: "approved" | "denied";
      };

      const resolution = await deps.identity.resolve({
        slug: body.provider,
        sender: body.externalSubject,
      });
      if (resolution.outcome === "unlinked") return reply.send({ outcome: "unlinked" });

      const outcome = await deps.toolApprovals.signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: body.decision,
        principal: `user:${resolution.user._id}`,
      });
      return reply.send({ outcome });
    }
  );
}
