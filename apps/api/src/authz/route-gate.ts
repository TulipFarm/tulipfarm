/** The HTTP adapter for `decideEffectivePermission` (authorization-design D4). */

import { type AuthorityLayer, decideEffectivePermission } from "@tulipfarm/authz";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthorityPrincipal } from "../identity/authority-layers";
import { callerAuthorityPrincipal } from "../identity/authority-layers";
import type { RequestPrincipal } from "../identity/principal";

/**
 * What a route requires of its caller, in the same vocabulary a Role grant is written in.
 *
 * `fallback` is mandatory because a deployment or test that wires no authorizer must still be
 * refused by something: the Tool dispatcher shipped a variant of this gate that returned `proceed`
 * whenever a half was missing, which looked wired and enforced nothing.
 */
export interface RouteAuthorization {
  readonly action: string;
  readonly resourceType: string;
  readonly domain?: string;
  readonly dataClass?: string;
  /**
   * Request context an owner-scoped grant is written against, e.g. `{ subject: "other_user" }`.
   * A grant's conditions must all equal the request's, so declaring one narrows, never widens.
   */
  readonly conditions?: Readonly<Record<string, string>>;
  /** The static check applied when no authorizer is wired. It may never be wider than the grant. */
  readonly fallback: "admin" | "authenticated";
}

export interface RouteAuthorizer {
  authorize(principal: AuthorityPrincipal, request: RouteAuthorization): Promise<boolean>;
}

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Applies one declaration to one route. */
export type RequireAuthorization = (authorization: RouteAuthorization) => PreHandler;

/** The same decision, for callers that need a boolean rather than a preHandler. */
export type AuthorizationCheck = (
  principal: RequestPrincipal,
  authorization: RouteAuthorization
) => Promise<boolean>;

/** Fail closed: API clients hold no deployment role, so only signed-in admin users pass. */
export function isDeploymentAdmin(principal: RequestPrincipal): boolean {
  return principal.kind === "user" && principal.role === "admin";
}

export class LiveRouteAuthorizer implements RouteAuthorizer {
  constructor(
    private readonly layers: {
      resolvePrincipalLayer(name: string, principal: AuthorityPrincipal): Promise<AuthorityLayer>;
    },
    private readonly now: () => Date = () => new Date()
  ) {}

  async authorize(principal: AuthorityPrincipal, request: RouteAuthorization): Promise<boolean> {
    const caller = await this.layers.resolvePrincipalLayer(principal.kind, principal);
    return decideEffectivePermission(
      [caller],
      {
        action: request.action,
        resourceType: request.resourceType,
        ...(request.domain === undefined ? {} : { domain: request.domain }),
        ...(request.dataClass === undefined ? {} : { dataClass: request.dataClass }),
        ...(request.conditions === undefined ? {} : { conditions: request.conditions }),
      },
      this.now()
    ).allowed;
  }
}

/**
 * Builds the one preHandler every gated route uses. Routes declare what they need; they never
 * compare a role themselves.
 */
export function makeRequireAuthorization(authorizer?: RouteAuthorizer): RequireAuthorization {
  const check = makeAuthorizationCheck(authorizer);
  return (authorization) => async (req, reply) => {
    const principal = req.principal;
    if (principal === undefined) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    if (!(await check(principal, authorization))) {
      await reply.code(403).send({ error: "forbidden" });
    }
  };
}

/**
 * The decision behind {@link makeRequireAuthorization}, for the two callers that are not routes:
 * the operational API's grant resolver and the Run event audience split. They need the answer as a
 * value, and duplicating the comparison is exactly the drift this module exists to stop.
 */
export function makeAuthorizationCheck(authorizer?: RouteAuthorizer): AuthorizationCheck {
  return async (principal, authorization) => {
    if (authorizer === undefined) {
      return authorization.fallback === "authenticated" || isDeploymentAdmin(principal);
    }
    return authorizer.authorize(callerAuthorityPrincipal(principal), authorization);
  };
}
