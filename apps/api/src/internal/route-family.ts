import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppOptions } from "../app";
import { registerCuratorRoutes } from "../curator/routes";
import { registerChannelInternalRoutes } from "./channel-routes";
import { registerInternalTurnRoutes } from "./routes";
import { registerSurfaceInternalRoutes } from "./surfaces-routes";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * The service-principal plane: everything the Worker and the channel adapters call back into
 * while they cannot import this app. Split out of `buildApp` because these families share one
 * audience and one authentication story, and none of them is reachable by a user session.
 */
export function registerInternalRouteFamily(
  app: FastifyInstance,
  opts: AppOptions,
  requireAuth: PreHandler
): void {
  if (opts.internalTurns) {
    registerInternalTurnRoutes(app, opts.internalTurns, requireAuth);
  }
  if (opts.curator) {
    registerCuratorRoutes(app, opts.curator, DEPLOYMENT_BUSINESS_ID, requireAuth);
  }
  if (opts.channels) {
    const channelDeps = opts.channels(app.log);
    registerChannelInternalRoutes(app, channelDeps, requireAuth);
    if (channelDeps.surfaceActionStore) {
      registerSurfaceInternalRoutes(
        app,
        {
          identity: channelDeps.identity,
          actions: channelDeps.surfaceActionStore,
          store: channelDeps.store,
          invocations: channelDeps.invocations,
          runDeliveries: channelDeps.runDeliveries,
          ...(opts.guardrailsService ? { guardrails: opts.guardrailsService } : {}),
        },
        requireAuth
      );
    }
  }
}
