import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthorizationCheck, RequireAuthorization } from "../../authz/route-gate";
import { registerOimConnectionAuthCallbackRoute } from "../auth-routes";
import { registerOimConnectionRoutes } from "./routes";
import type { OimConnectionService } from "./service";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerOimConnectionFeature(
  app: FastifyInstance,
  service: OimConnectionService,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization,
  authorizationCheck: AuthorizationCheck,
  callbackRegistered: boolean
): void {
  registerOimConnectionRoutes(app, {
    service,
    requireAuth,
    requireAuthorization,
    authorizationCheck,
  });
  if (!callbackRegistered) registerOimConnectionAuthCallbackRoute(app, service);
}
