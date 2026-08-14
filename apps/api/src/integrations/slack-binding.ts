import type { SecretsService } from "@tulipfarm/secrets";
import type { SoulLoader } from "@tulipfarm/soul";
import type { IntegrationStore } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { DEFAULT_ASSISTANT_NAME } from "../soul/agents/platform-agents";
import { integrationSecretKey, resolveConnectionEnv } from "./connection-env";

/* Slack-specific bridge from connected workspace to integration-worker channel routing. */

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface SlackAuthTestResult {
  teamId: string;
  appId: string;
}

/** Resolve real Slack App ID from bot id; Events API envelopes carry `api_app_id`, not `bot_id`. */
async function resolveSlackAppId(botToken: string, botId: string): Promise<string> {
  const res = await fetch(`https://slack.com/api/bots.info?bot=${encodeURIComponent(botId)}`, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const body = (await res.json()) as {
    ok: boolean;
    error?: string;
    bot?: { app_id?: string };
  };
  if (!body.ok || !body.bot?.app_id) {
    throw new Error(body.error ?? "Slack bots.info failed to resolve app_id");
  }
  return body.bot.app_id;
}

/** Verifies auth.test; absent `app_id` resolves via bots.info, never `bot_id`. */
export async function verifySlackBotToken(botToken: string): Promise<SlackAuthTestResult> {
  const res = await fetch("https://slack.com/api/auth.test", {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const body = (await res.json()) as {
    ok: boolean;
    error?: string;
    team_id?: string;
    app_id?: string;
    bot_id?: string;
  };
  if (!body.ok || !body.team_id) {
    throw new Error(body.error ?? "Slack auth.test failed");
  }
  const appId =
    body.app_id ?? (body.bot_id ? await resolveSlackAppId(botToken, body.bot_id) : undefined);
  if (!appId) {
    throw new Error("Slack auth.test response has neither app_id nor bot_id");
  }
  return { teamId: body.team_id, appId };
}

export interface SlackBindDeps {
  soulLoader: SoulLoader;
  secretsService: SecretsService;
  integrations: IntegrationStore;
  businessId: string;
  requireAuth: PreHandler;
  /** Overridable for tests — defaults to a real Slack API call. */
  verifyBotToken?: (botToken: string) => Promise<SlackAuthTestResult>;
}

const RouteSchema = {
  type: "object",
  required: ["id", "agentId", "channelId", "priority"],
  properties: {
    id: { type: "string" },
    agentId: { type: "string" },
    channelId: { type: ["string", "null"] },
    priority: { type: "number" },
  },
} as const;

/** Recomputes deterministic Slack app/integration ids so bind/list/unbind target one row. */
async function resolveSlackIntegration(
  deps: SlackBindDeps,
  verify: (botToken: string) => Promise<SlackAuthTestResult>
): Promise<
  | { ok: true; appRowId: string; integrationId: string; verified: SlackAuthTestResult }
  | { ok: false; code: 400 | 404 | 502; error: string }
> {
  const slack = deps.soulLoader.integrations.get("slack");
  if (slack?.connection?.enabled !== true) {
    return { ok: false, code: 404, error: "Slack is not connected" };
  }
  const env = await resolveConnectionEnv(slack.connection.env ?? {}, deps.secretsService);
  const botToken = env.SLACK_BOT_TOKEN;
  if (!botToken) {
    return { ok: false, code: 400, error: "Slack connection is missing SLACK_BOT_TOKEN" };
  }
  try {
    const verified = await verify(botToken);
    // Deterministic (not random) so re-resolving the same Slack workspace always lands on the
    // same app/integration rows via ON CONFLICT instead of minting duplicates that make
    // resolveChannelRoute's one() lookups throw *_ambiguous and deny all inbound messages.
    return {
      ok: true,
      appRowId: `slack:${verified.appId}`,
      integrationId: `slack:${verified.appId}:${verified.teamId}`,
      verified,
    };
  } catch (err) {
    return {
      ok: false,
      code: 502,
      error: `Slack auth.test failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Best-effort default Slack binding; route listing surfaces bad-token failures later. */
export async function ensureDefaultSlackRoute(deps: SlackBindDeps): Promise<void> {
  const verify = deps.verifyBotToken ?? verifySlackBotToken;
  const resolved = await resolveSlackIntegration(deps, verify);
  if (!resolved.ok) return;
  const { appRowId, integrationId, verified } = resolved;
  const routeId = `slack:${verified.appId}:${verified.teamId}:route:default`;

  await deps.integrations.putApp({
    id: appRowId,
    businessId: deps.businessId,
    provider: "slack",
    externalAppId: verified.appId,
    credentialRefs: [
      integrationSecretKey("slack", "SLACK_BOT_TOKEN"),
      integrationSecretKey("slack", "SLACK_APP_TOKEN"),
    ],
    status: "active",
  });
  await deps.integrations.putIntegration({
    id: integrationId,
    businessId: deps.businessId,
    appId: appRowId,
    externalTenantId: verified.teamId,
    status: "active",
  });
  await deps.integrations.putRoute({
    id: routeId,
    businessId: deps.businessId,
    integrationId,
    agentId: DEFAULT_ASSISTANT_NAME,
    channelId: null,
    threadId: null,
    eventTypes: ["message"],
    priority: 0,
    status: "active",
  });
}

export function registerSlackBindRoute(app: FastifyInstance, deps: SlackBindDeps): void {
  const verify = deps.verifyBotToken ?? verifySlackBotToken;

  app.post(
    "/api/v1/integrations/slack/bind",
    {
      preHandler: deps.requireAuth,
      schema: {
        description:
          "Bind a channel (or the default/DM catch-all when channelId is omitted) in the " +
          "connected Slack workspace to an Agent's routing table. One Slack app can route " +
          "different channels to different Agents.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["agentId"],
          properties: {
            agentId: { type: "string" },
            channelId: {
              type: "string",
              description: "Slack channel id (e.g. C0123ABC). Omit to bind the default catch-all.",
            },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["status", "teamId", "appId", "routeId", "channelId"],
            properties: {
              status: { type: "string" },
              teamId: { type: "string" },
              appId: { type: "string" },
              routeId: { type: "string" },
              channelId: { type: ["string", "null"] },
            },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          502: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { agentId, channelId } = req.body as { agentId: string; channelId?: string };
      if (!deps.soulLoader.agents.get(agentId)) {
        return reply.code(400).send({ error: `agent not found: ${agentId}` });
      }

      const resolved = await resolveSlackIntegration(deps, verify);
      if (!resolved.ok) {
        return reply.code(resolved.code).send({ error: resolved.error });
      }
      const { appRowId, integrationId, verified } = resolved;
      const routeId = `slack:${verified.appId}:${verified.teamId}:route:${channelId ?? "default"}`;

      await deps.integrations.putApp({
        id: appRowId,
        businessId: deps.businessId,
        provider: "slack",
        externalAppId: verified.appId,
        credentialRefs: [
          integrationSecretKey("slack", "SLACK_BOT_TOKEN"),
          integrationSecretKey("slack", "SLACK_APP_TOKEN"),
        ],
        status: "active",
      });
      await deps.integrations.putIntegration({
        id: integrationId,
        businessId: deps.businessId,
        appId: appRowId,
        externalTenantId: verified.teamId,
        status: "active",
      });
      await deps.integrations.putRoute({
        id: routeId,
        businessId: deps.businessId,
        integrationId,
        agentId,
        channelId: channelId ?? null,
        threadId: null,
        eventTypes: ["message"],
        // A channel-specific route must win over the default catch-all when both match.
        priority: channelId === undefined ? 0 : 10,
        status: "active",
      });

      return {
        status: "bound",
        teamId: verified.teamId,
        appId: verified.appId,
        routeId,
        channelId: channelId ?? null,
      };
    }
  );

  app.get(
    "/api/v1/integrations/slack/routes",
    {
      preHandler: deps.requireAuth,
      schema: {
        description: "List the connected Slack workspace's channel-to-Agent routing table.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["routes"],
            properties: { routes: { type: "array", items: RouteSchema } },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          502: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      const resolved = await resolveSlackIntegration(deps, verify);
      if (!resolved.ok) {
        return reply.code(resolved.code).send({ error: resolved.error });
      }
      const routes = await deps.integrations.listRoutes(deps.businessId, resolved.integrationId);
      return {
        routes: routes
          .filter((route) => route.status === "active")
          .map((route) => ({
            id: route.id,
            agentId: route.agentId,
            channelId: route.channelId,
            priority: route.priority,
          })),
      };
    }
  );

  app.delete(
    "/api/v1/integrations/slack/routes/:routeId",
    {
      preHandler: deps.requireAuth,
      schema: {
        description: "Unbind one channel (or the default catch-all) from the routing table.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["routeId"],
          properties: { routeId: { type: "string" } },
        },
        response: {
          200: { type: "object", required: ["status"], properties: { status: { type: "string" } } },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { routeId } = req.params as { routeId: string };
      const slack = deps.soulLoader.integrations.get("slack");
      if (slack?.connection?.enabled !== true) {
        return reply.code(404).send({ error: "Slack is not connected" });
      }
      await deps.integrations.revokeRoute(deps.businessId, routeId);
      return { status: "revoked" };
    }
  );
}
