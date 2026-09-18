import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppOptions } from "../app";
import { registerMcpKnowledgeWorkerRoutes } from "../knowledge-sources/mcp/routes";
import { registerInternalProductTelemetryRoutes } from "../system/telemetry/routes";
import { registerChannelInternalRoutes } from "./channel-routes";
import { registerNativeChannelInternalRoutes } from "./native-channel-routes";
import { registerInternalTurnRoutes } from "./routes";
import { registerRoutineMcpToolRoutes } from "./routine-mcp-tool-routes";
import { registerSlackEventRoutes } from "./slack-event-routes";
import { registerSlackHomeRoutes } from "./slack-home-routes";
import { registerSurfaceInternalRoutes } from "./surfaces-routes";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
type InternalRouteOptions = Omit<AppOptions, "nativeChannels"> & {
  readonly nativeChannels?: ReturnType<NonNullable<AppOptions["nativeChannels"]>>;
};

/**
 * The service-principal plane: everything the Worker and the channel adapters call back into
 * while they cannot import this app. Split out of `buildApp` because these families share one
 * audience and one authentication story, and none of them is reachable by a user session.
 */
export function registerInternalRouteFamily(
  app: FastifyInstance,
  opts: InternalRouteOptions,
  requireAuth: PreHandler
): void {
  const nativeChannels = opts.nativeChannels?.service;
  if (nativeChannels) {
    registerNativeChannelInternalRoutes(app, nativeChannels, requireAuth);
  }
  if (opts.productTelemetry)
    registerInternalProductTelemetryRoutes(app, opts.productTelemetry, requireAuth);
  if (opts.internalTurns) {
    registerInternalTurnRoutes(app, opts.internalTurns, requireAuth);
  }
  if (opts.internalRoutineMcp) {
    const requireService: PreHandler = async (request, reply) => {
      if (request.principal?.kind !== "service") {
        await reply.code(403).send({ error: "Routine MCP routes are service-only" });
      }
    };
    registerRoutineMcpToolRoutes(app, opts.internalRoutineMcp, [requireAuth, requireService]);
  }
  if (opts.mcpKnowledge) {
    registerMcpKnowledgeWorkerRoutes(
      app,
      opts.mcpKnowledge,
      async (request, reply) => {
        await requireAuth(request, reply);
        if (reply.sent) return;
        if (request.principal?.kind !== "service") {
          await reply.code(403).send({ error: "Knowledge Worker routes are service-only" });
        }
      },
      async (runId) => {
        if (!opts.mcpKnowledgeReader)
          throw new Error("MCP Knowledge Run reader resolution is not configured");
        return opts.mcpKnowledgeReader(runId);
      }
    );
  }
  if (opts.channels) {
    const channelDeps = opts.channels(app.log);
    registerChannelInternalRoutes(app, channelDeps, requireAuth);
    if (channelDeps.surfaceActionStore) {
      registerSurfaceInternalRoutes(
        app,
        {
          ...(channelDeps.soulLoader ? { soulLoader: channelDeps.soulLoader } : {}),
          identity: channelDeps.identity,
          actions: channelDeps.surfaceActionStore,
          store: channelDeps.store,
          invocations: channelDeps.invocations,
          runDeliveries: channelDeps.runDeliveries,
          ...(nativeChannels ? { nativeChannels } : {}),
          ...(opts.guardrailsService ? { guardrails: opts.guardrailsService } : {}),
        },
        requireAuth
      );
    }
  }
  if (opts.slackHome) {
    registerSlackHomeRoutes(app, opts.slackHome(app.log), requireAuth);
  }
  if (opts.slackEvents) {
    registerSlackEventRoutes(app, opts.slackEvents(app.log), requireAuth);
  }
}
