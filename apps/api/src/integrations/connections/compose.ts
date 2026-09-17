import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthorizationCheck, RequireAuthorization } from "../../authz/route-gate";
import { registerOimConnectionAuthCallbackRoute } from "../auth-routes";
import { registerIntegrationOperationsRoutes } from "../operations/routes";
import type { IntegrationOperationsService } from "../operations/service";
import { registerOimConnectionRoutes } from "./routes";
import type { OimConnectionService } from "./service";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerOimConnectionFeature(
  app: FastifyInstance,
  service: OimConnectionService,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization,
  authorizationCheck: AuthorizationCheck,
  callbackRegistered: boolean,
  operations?: IntegrationOperationsService
): void {
  registerOimConnectionRoutes(app, {
    service,
    requireAuth,
    requireAuthorization,
    authorizationCheck,
  });
  if (operations) {
    registerIntegrationOperationsRoutes(
      app,
      operations,
      requireAuth,
      requireAuthorization,
      authorizationCheck
    );
  }
  if (!callbackRegistered) registerOimConnectionAuthCallbackRoute(app, service);
}
