import {
  type OperationalScope,
  operationalScopeMatches,
  operationalUpdateRequest,
} from "@tulipfarm/authz";
import type { FastifyRequest } from "fastify";
import type { RequestPrincipal } from "../identity/principal";
import type { RouteAuthorizer } from "./route-gate";

declare module "fastify" {
  interface FastifyContextConfig {
    operationalAction?: "deployment.update.read";
  }
}

export async function authorizeOperationalRequest(
  request: FastifyRequest,
  principal: RequestPrincipal,
  deployment: OperationalScope | undefined,
  authorizer: RouteAuthorizer | undefined
): Promise<boolean> {
  const scope = principal.operationalScope;
  if (
    !scope ||
    principal.kind !== "service" ||
    !operationalScopeMatches(scope, deployment) ||
    request.routeOptions.config.operationalAction !== "deployment.update.read" ||
    !authorizer
  ) {
    return false;
  }
  try {
    return await authorizer.authorize(principal, {
      ...operationalUpdateRequest(scope),
      fallback: "admin",
    });
  } catch {
    request.log.warn(
      { event: "authz.operational.unavailable" },
      "operational authorization denied"
    );
    return false;
  }
}
