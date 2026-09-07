import { canonicalHash } from "@tulipfarm/schema";
import type { PersistedRoutingSnapshot } from "@tulipfarm/storage";
import { createSurfaceArtifact } from "@tulipfarm/surface";
import { createSlackRenderer } from "@tulipfarm/surface-slack";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { ChannelSenderResolution } from "../ingress/identity";
import { SlackHomeBodySchema, SlackHomeResponseSchema } from "./slack-home-schemas";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface SlackHomeProjection {
  readonly askUrl: string;
  readonly needsYou: readonly string[];
  readonly runningNow: readonly string[];
  readonly agents: readonly string[];
  readonly recentWork: readonly string[];
}

export interface SlackHomeRouteDeps {
  readonly businessId: string;
  readonly integrations: {
    loadRoutingSnapshot(
      businessId: string,
      provider: string,
      externalTenantId: string
    ): Promise<PersistedRoutingSnapshot>;
  };
  readonly identity: {
    resolve(input: {
      slug: string;
      sender: string;
      externalTenantId: string;
    }): Promise<ChannelSenderResolution>;
  };
  readonly projection: {
    load(input: {
      businessId: string;
      principalId: string;
      principalRef: string;
      roles: readonly string[];
    }): Promise<SlackHomeProjection>;
  };
  readonly bindLinkUrl: (token: string) => string;
  readonly unlinkedUrl: string;
}

interface SlackHomeBody {
  integrationId: string;
  externalTenantId: string;
  externalAppId: string;
  externalSubject: string;
}

function listOrEmpty(items: readonly string[], empty: string): string {
  return items.length === 0 ? `_${empty}_` : items.map((item) => `• ${item}`).join("\n");
}

function linkedBody(projection: SlackHomeProjection): string {
  return [
    "*Ask TulipFarm*",
    `<${projection.askUrl}|Open Chat> to ask TulipFarm to do work.`,
    "",
    "*Needs you*",
    listOrEmpty(projection.needsYou, "No pending Approvals or Tasks."),
    "",
    "*Running now*",
    listOrEmpty(projection.runningNow, "No Runs are active."),
    "",
    "*Your Agents*",
    listOrEmpty(projection.agents, "No Agents are available here yet."),
    "",
    "*Recent work*",
    listOrEmpty(projection.recentWork, "No recent completed Runs."),
  ].join("\n");
}

function renderHome(input: {
  id: string;
  body: string;
  audience: readonly string[];
  classification: "public" | "internal";
}) {
  const artifact = createSurfaceArtifact({
    id: input.id,
    component: { name: "Section", version: "1.0" },
    props: { heading: "TulipFarm", body: input.body },
    target: { channel: "slack", surface: "home" },
    audience: input.audience,
    classification: input.classification,
  });
  const rendered = createSlackRenderer("home").render(artifact, {
    destination: input.id,
  });
  if (rendered.view === undefined) throw new Error("Slack Home renderer returned no view");
  return rendered.view;
}

function activeBinding(snapshot: PersistedRoutingSnapshot, body: SlackHomeBody): boolean {
  const integration = snapshot.integrations.find(
    (candidate) =>
      candidate.id === body.integrationId &&
      candidate.externalTenantId === body.externalTenantId &&
      candidate.status === "active"
  );
  if (integration === undefined) return false;
  return snapshot.apps.some(
    (app) =>
      app.id === integration.appId &&
      app.provider === "slack" &&
      app.externalAppId === body.externalAppId &&
      app.status === "active"
  );
}

export function registerSlackHomeRoutes(
  app: FastifyInstance,
  deps: SlackHomeRouteDeps,
  requireAuth: PreHandler
): void {
  const requireService: PreHandler = async (req, reply) => {
    if (req.principal?.kind !== "service") {
      await reply.code(403).send({ error: "internal Slack Home host is service-only" });
    }
  };

  app.post(
    "/api/v1/internal/channels/slack/home",
    {
      preHandler: [requireAuth, requireService],
      schema: {
        description:
          "Resolve a Slack App Home viewer and render the authorized semantic Home projection.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: SlackHomeBodySchema,
        response: {
          200: SlackHomeResponseSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body as SlackHomeBody;
      const snapshot = await deps.integrations.loadRoutingSnapshot(
        deps.businessId,
        "slack",
        body.externalTenantId
      );
      if (!activeBinding(snapshot, body)) {
        return reply.code(404).send({ error: "Slack Integration is not active" });
      }

      const resolution = await deps.identity.resolve({
        slug: "slack",
        sender: body.externalSubject,
        externalTenantId: body.externalTenantId,
      });
      if (resolution.outcome === "unlinked" || resolution.principalKind !== "user") {
        const link =
          resolution.outcome === "unlinked" && resolution.bindOffer !== null
            ? deps.bindLinkUrl(resolution.bindOffer.token)
            : deps.unlinkedUrl;
        const view = renderHome({
          id: `slack-home-link-${body.externalSubject}`,
          body: `Link your TulipFarm account to use App Home.\n\n<${link}|Link account>`,
          audience: [],
          classification: "public",
        });
        return reply.send({
          integrationId: body.integrationId,
          linked: false,
          renderDigest: canonicalHash({ linked: false, view }),
          view,
        });
      }

      const projection = await deps.projection.load({
        businessId: deps.businessId,
        principalId: resolution.principalId,
        principalRef: resolution.principalRef,
        roles: [resolution.user.role],
      });
      const view = renderHome({
        id: `slack-home-${body.externalSubject}`,
        body: linkedBody(projection),
        audience: [resolution.principalRef],
        classification: "internal",
      });
      return reply.send({
        integrationId: body.integrationId,
        linked: true,
        renderDigest: canonicalHash({
          principal: resolution.principalRef,
          projection,
          view,
        }),
        view,
      });
    }
  );
}
