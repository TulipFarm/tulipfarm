import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { NativeWebhookError, type NativeWebhookProvider } from "@tulipfarm/integrations";
import { DEFINITION_API_VERSION } from "@tulipfarm/schema";
import type { PersistedChannelRoute } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../../auth/schemas";
import type { RequireAuthorization } from "../../authz/route-gate";
import { NativeChannelError, object } from "./credentials";
import type { NativeChannelService } from "./service";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
const Provider = Type.Union([Type.Literal("slack"), Type.Literal("github")]);
const Params = Type.Object({ provider: Provider }, { additionalProperties: false });
const Id = Type.String({ minLength: 1, maxLength: 200 });
const SetupBody = Type.Object(
  {
    integrationId: Id,
    routeId: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,100}$" }),
    agentId: Id,
    channelId: Id,
    threadId: Type.Optional(Id),
    principalIds: Type.Array(Id, { minItems: 1, maxItems: 100, uniqueItems: true }),
    enabled: Type.Boolean(),
  },
  { additionalProperties: false }
);
const Route = Type.Object({
  id: Id,
  integrationId: Id,
  agentId: Id,
  channelId: Type.Union([Id, Type.Null()]),
  threadId: Type.Union([Id, Type.Null()]),
  eventTypes: Type.Array(Id),
  priority: Type.Number(),
  status: Type.Union([Type.Literal("active"), Type.Literal("revoked")]),
  principalIds: Type.Array(Id),
});
const RoutineRoute = Type.Object({
  id: Id,
  integrationId: Id,
  destination: Id,
  eventType: Id,
  routineId: Id,
  enabled: Type.Boolean(),
});
const SetupResponse = Type.Object({
  provider: Provider,
  webhookUrl: Type.String(),
  integrations: Type.Array(
    Type.Object({
      id: Id,
      externalTenantId: Id,
      status: Type.Union([Type.Literal("active"), Type.Literal("revoked")]),
    })
  ),
  routes: Type.Array(Route),
  routineRoutes: Type.Array(RoutineRoute),
});
const errors = {
  400: ErrorSchema,
  401: ErrorSchema,
  403: ErrorSchema,
  404: ErrorSchema,
  409: ErrorSchema,
  413: ErrorSchema,
  503: ErrorSchema,
};

export async function nativeRouteError(error: unknown, reply: FastifyReply) {
  if (error instanceof NativeChannelError) {
    return reply.code(error.status).send({ error: error.code });
  }
  if (error instanceof NativeWebhookError) {
    return reply
      .code(error.code === "body_too_large" ? 413 : error.code === "signature_invalid" ? 401 : 400)
      .send({ error: error.code });
  }
  if (error instanceof Error && error.message === "native_delivery_conflict") {
    return reply.code(409).send({ error: "native_delivery_conflict" });
  }
  throw error;
}

export interface NativeChannelRouteDeps {
  readonly service: NativeChannelService;
  readonly publicApiUrl: () => string;
}

export function registerNativeChannelRoutes(
  app: FastifyInstance,
  deps: NativeChannelRouteDeps,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  const configure = [
    requireAuth,
    requireAuthorization({
      action: "integration.connect",
      resourceType: "integration",
      fallback: "admin",
    }),
  ];
  const { integrations, businessId } = deps.service.deps;
  const setup = async (provider: NativeWebhookProvider) => {
    const snapshot = await integrations.loadProviderSnapshot(businessId, provider);
    return {
      provider,
      webhookUrl: new URL(
        `/api/v1/integrations/native/${provider}/events`,
        deps.publicApiUrl()
      ).toString(),
      integrations: snapshot.integrations.map(({ id, externalTenantId, status }) => ({
        id,
        externalTenantId,
        status,
      })),
      routes: snapshot.routes.map((route) => {
        const grant = snapshot.accessGrants.find(
          (candidate) =>
            candidate.id === route.id && candidate.integrationId === route.integrationId
        );
        const principals = object(object(grant?.definition)?.spec)?.principals;
        return {
          ...route,
          principalIds: Array.isArray(principals)
            ? principals.flatMap((value) => {
                const principal = object(value);
                return principal?.kind === "user" && typeof principal.id === "string"
                  ? [principal.id]
                  : [];
              })
            : [],
        };
      }),
      routineRoutes: await deps.service.deps.inbox.routineRoutes(businessId, provider),
    };
  };
  app.put(
    "/api/v1/integrations/native/:provider/routines",
    {
      preHandler: configure,
      schema: {
        description: "Bind a native automated event to one currently approved published Routine.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: Params,
        body: Type.Object(
          {
            integrationId: Id,
            destination: Id,
            eventType: Type.Union([
              Type.Literal("github.push"),
              Type.Literal("github.issues"),
              Type.Literal("github.pull_request"),
              Type.Literal("slack.reaction_added"),
              Type.Literal("slack.reaction_removed"),
            ]),
            routineId: Id,
            enabled: Type.Boolean(),
          },
          { additionalProperties: false }
        ),
        response: { 200: SetupResponse, ...errors },
      },
    },
    async (request, reply) => {
      const { provider } = request.params as { provider: NativeWebhookProvider };
      const body = request.body as {
        integrationId: string;
        destination: string;
        eventType: string;
        routineId: string;
        enabled: boolean;
      };
      try {
        const snapshot = await integrations.loadProviderSnapshot(businessId, provider);
        if (
          !body.eventType.startsWith(`${provider}.`) ||
          !snapshot.integrations.some(
            (integration) =>
              integration.id === body.integrationId && integration.status === "active"
          )
        )
          throw new NativeChannelError("native_routine_binding_invalid", 400);
        const store = deps.service.deps.inbox;
        const current = (await store.routineRoutes(businessId, provider)).find(
          (route) =>
            route.integrationId === body.integrationId &&
            route.destination === body.destination &&
            route.eventType === body.eventType
        );
        const route = {
          ...body,
          id:
            current?.id ??
            createHash("sha256")
              .update(
                JSON.stringify([provider, body.integrationId, body.destination, body.eventType])
              )
              .digest("hex"),
          provider,
          businessId,
        };
        if (!body.enabled) {
          await store.putRoutineRoute({ ...route, authority: null });
          return reply.send(await setup(provider));
        }
        deps.service.deps.credentials.assertEnabled(provider);
        const authorize = deps.service.deps.authorizeRoutine;
        if (!authorize) throw new NativeChannelError("native_routine_authority_unavailable", 503);
        const authority = await authorize({ ...body, provider });
        if (!authority.definitionRef.startsWith("published:routine:")) {
          throw new NativeChannelError("native_routine_not_published");
        }
        await store.putRoutineRoute({
          ...route,
          authority,
        });
        return reply.send(await setup(provider));
      } catch (error) {
        return nativeRouteError(error, reply);
      }
    }
  );
  app.get(
    "/api/v1/integrations/native/:provider/setup",
    {
      preHandler: configure,
      schema: {
        description: "Read native Slack or GitHub channel setup without exposing credentials.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: Params,
        response: { 200: SetupResponse, ...errors },
      },
    },
    async (request) => setup((request.params as { provider: NativeWebhookProvider }).provider)
  );
  app.put(
    "/api/v1/integrations/native/:provider/setup",
    {
      preHandler: configure,
      schema: {
        description: "Set one exact native channel route and its linked-user access grants.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: Params,
        body: SetupBody,
        response: { 200: SetupResponse, ...errors },
      },
    },
    async (request, reply) => {
      const { provider } = request.params as { provider: NativeWebhookProvider };
      const body = request.body as {
        integrationId: string;
        routeId: string;
        agentId: string;
        channelId: string;
        threadId?: string;
        principalIds: string[];
        enabled: boolean;
      };
      try {
        deps.service.deps.credentials.assertEnabled(provider);
        const snapshot = await integrations.loadProviderSnapshot(businessId, provider);
        if (
          !snapshot.integrations.some(
            (integration) =>
              integration.id === body.integrationId && integration.status === "active"
          )
        ) {
          throw new NativeChannelError("native_installation_not_active", 404);
        }
        if (
          (provider === "github" &&
            (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(body.channelId) ||
              (body.threadId !== undefined && !/^[1-9]\d*$/.test(body.threadId)))) ||
          (provider === "slack" && !/^[CGD][A-Z0-9]+$/.test(body.channelId))
        ) {
          throw new NativeChannelError("native_destination_invalid", 400);
        }
        for (const principalId of body.principalIds) {
          if (!(await deps.service.deps.mayUseAgent(body.agentId, principalId))) {
            throw new NativeChannelError("native_agent_access_denied");
          }
        }
        const hash = createHash("sha256")
          .update(JSON.stringify([provider, body.integrationId, body.routeId]))
          .digest("hex");
        const existing = snapshot.routes.find(
          (route) => route.id === body.routeId && route.integrationId === body.integrationId
        );
        const routeId =
          existing?.id ??
          `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        const status = body.enabled ? "active" : "revoked";
        const route: PersistedChannelRoute = {
          id: routeId,
          businessId,
          integrationId: body.integrationId,
          agentId: body.agentId,
          channelId: body.channelId,
          threadId: body.threadId ?? null,
          eventTypes: ["message"],
          priority: body.threadId === undefined ? 10 : 20,
          status,
        };
        // Revoke admission first: a crash cannot leave an edited route with its former grant.
        await integrations.putRoute({ ...route, status: "revoked" });
        await integrations.putAccessGrant({
          id: routeId,
          businessId,
          integrationId: body.integrationId,
          status,
          definition: {
            apiVersion: DEFINITION_API_VERSION,
            kind: "AccessGrant",
            metadata: {
              id: routeId,
              slug: `native-channel-${routeId}`,
              displayName: "Native channel access",
              schemaVersion: 1,
              authoredVersion: 1,
              lifecycle: "published",
            },
            spec: {
              integrationId: body.integrationId,
              principals: body.principalIds.map((id) => ({ kind: "user", id })),
              actions: ["channels.message.receive", "channels.message.send"],
              externalTargets: [
                {
                  type: provider === "github" ? "github.repository" : "slack.channel",
                  ids: [body.channelId],
                },
              ],
              delegable: false,
            },
          },
        });
        await integrations.putRoute(route);
        return reply.send(await setup(provider));
      } catch (error) {
        return nativeRouteError(error, reply);
      }
    }
  );
  app.register(async (webhooks) => {
    webhooks.removeContentTypeParser("application/json");
    webhooks.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body)
    );
    webhooks.post(
      "/api/v1/integrations/native/:provider/events",
      {
        bodyLimit: 1024 * 1024,
        schema: {
          description:
            "Verify a native provider signature and persist an event before acknowledgement.",
          tags: ["integrations"],
          params: Params,
          body: Type.Unsafe<Buffer>({
            type: "object",
            additionalProperties: true,
            description: "Provider JSON preserved as raw bytes for signature verification.",
          }),
          response: {
            200: Type.Union([
              Type.Object({ challenge: Type.String() }),
              Type.Object({
                outcome: Type.Union([Type.Literal("accepted"), Type.Literal("duplicate")]),
                eventId: Id,
              }),
            ]),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        try {
          if (!Buffer.isBuffer(request.body)) {
            throw new NativeChannelError("native_raw_body_required", 400);
          }
          return reply.send(
            await deps.service.accept(
              (request.params as { provider: NativeWebhookProvider }).provider,
              request.body,
              request.headers
            )
          );
        } catch (error) {
          return nativeRouteError(error, reply);
        }
      }
    );
  });
}
