import type { AccessGrantDefinition } from "@tulipfarm/schema";
import { decideIntegrationAccess } from "../grants";

export type ChannelProjectionStatus = "active" | "revoked";

export interface ChannelApp {
  id: string;
  businessId: string;
  provider: string;
  externalAppId: string;
  credentialRefs: string[];
  status: ChannelProjectionStatus;
}

export interface ChannelIntegration {
  id: string;
  businessId: string;
  appId: string;
  externalTenantId: string;
  externalAccountId?: string;
  credentialRef?: string;
  status: ChannelProjectionStatus;
}

export interface ChannelRoute {
  id: string;
  businessId: string;
  integrationId: string;
  agentId: string;
  channelId?: string;
  threadId?: string;
  eventTypes: string[];
  priority: number;
  status: ChannelProjectionStatus;
}

export interface ChannelRoutingSnapshot {
  apps: ChannelApp[];
  integrations: ChannelIntegration[];
  accessGrants: AccessGrantDefinition[];
  routes: ChannelRoute[];
}

export interface ChannelRouteRequest {
  businessId: string;
  provider: string;
  externalTenantId: string;
  externalAppId: string;
  channelId: string;
  threadId?: string;
  eventType: string;
  principal: { kind: string; id: string };
  grantPrincipals?: { kind: string; id: string }[];
  action: string;
  targetType: string;
}

export interface ResolvedChannelRoute {
  appId: string;
  integrationId: string;
  routeId: string;
  agentId: string;
  principal: ChannelRouteRequest["principal"];
  credentialRef: string;
  accessGrantId: string;
}

export type ChannelRouteDenialReason =
  | "app_not_found"
  | "app_ambiguous"
  | "integration_not_found"
  | "integration_ambiguous"
  | "route_not_found"
  | "ambiguous_route"
  | "credential_missing"
  | "credential_ambiguous"
  | "access_denied";

/** A safe routing denial contains a stable code and no provider identifiers or payload. */
export class ChannelRouteDeniedError extends Error {
  readonly name = "ChannelRouteDeniedError";

  constructor(readonly reason: ChannelRouteDenialReason) {
    super(`channel_route_denied:${reason}`);
  }
}

function one<T>(
  matches: T[],
  missing: ChannelRouteDenialReason,
  ambiguous: ChannelRouteDenialReason
): T {
  if (matches.length === 0) throw new ChannelRouteDeniedError(missing);
  if (matches.length !== 1) throw new ChannelRouteDeniedError(ambiguous);
  return matches[0];
}

function routeMatches(route: ChannelRoute, request: ChannelRouteRequest): boolean {
  if (route.status !== "active") return false;
  if (route.channelId !== undefined && route.channelId !== request.channelId) return false;
  if (route.threadId !== undefined && route.threadId !== request.threadId) return false;
  return route.eventTypes.includes(request.eventType);
}

function credentialRef(app: ChannelApp, integration: ChannelIntegration): string {
  if (integration.credentialRef !== undefined) return integration.credentialRef;
  if (app.credentialRefs.length === 0) {
    throw new ChannelRouteDeniedError("credential_missing");
  }
  if (app.credentialRefs.length !== 1) {
    throw new ChannelRouteDeniedError("credential_ambiguous");
  }
  return app.credentialRefs[0];
}

/**
 * Resolve an inbound channel event through Provider → App/Bot → Integration → AccessGrant →
 * Route. The App and Agent remain separate identities and every ambiguous dimension fails closed.
 */
export function resolveChannelRoute(
  snapshot: ChannelRoutingSnapshot,
  request: ChannelRouteRequest,
  now = new Date()
): ResolvedChannelRoute {
  const app = one(
    snapshot.apps.filter(
      (candidate) =>
        candidate.status === "active" &&
        candidate.businessId === request.businessId &&
        candidate.provider === request.provider &&
        candidate.externalAppId === request.externalAppId
    ),
    "app_not_found",
    "app_ambiguous"
  );

  const integration = one(
    snapshot.integrations.filter(
      (candidate) =>
        candidate.status === "active" &&
        candidate.businessId === request.businessId &&
        candidate.appId === app.id &&
        candidate.externalTenantId === request.externalTenantId
    ),
    "integration_not_found",
    "integration_ambiguous"
  );

  const matchingRoutes = snapshot.routes
    .filter(
      (route) =>
        route.businessId === request.businessId &&
        route.integrationId === integration.id &&
        routeMatches(route, request)
    )
    .sort((left, right) => right.priority - left.priority);
  const highestPriority = matchingRoutes[0]?.priority;
  if (highestPriority === undefined) throw new ChannelRouteDeniedError("route_not_found");
  const route = one(
    matchingRoutes.filter((candidate) => candidate.priority === highestPriority),
    "route_not_found",
    "ambiguous_route"
  );

  const access = decideIntegrationAccess(
    snapshot.accessGrants,
    {
      integrationId: integration.id,
      principals: request.grantPrincipals ?? [request.principal],
      action: request.action,
      target: { type: request.targetType, id: request.channelId },
    },
    now
  );
  if (!access.allowed) throw new ChannelRouteDeniedError("access_denied");

  return {
    appId: app.id,
    integrationId: integration.id,
    routeId: route.id,
    agentId: route.agentId,
    principal: request.principal,
    credentialRef: credentialRef(app, integration),
    accessGrantId: access.grantId,
  };
}
