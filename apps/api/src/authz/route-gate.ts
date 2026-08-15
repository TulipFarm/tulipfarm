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

/**
 * Whether the decision engine's answer is served, or merely observed.
 *
 * `authorization-design.md` §5 orders the programme "declare before enforce":
 * step 2 runs the gate in shadow mode and collects evidence, step 3 flips it.
 * Enforcement in fact arrived first, which was safe only because `fallback` is
 * required and can therefore never widen a check. That reasoning does not
 * extend to the step-5 flip for business-authored Roles, where a wrong
 * allow-list can lock a deployment out of itself — so the evidence mechanism
 * has to exist before then, and this is it.
 */
export type AuthorizationMode = "enforcing" | "shadow";

/**
 * One request where the decision engine and the static fallback disagreed.
 *
 * Recorded in both modes. A would-deny under `shadow` is the signal step 2
 * asks for; a would-allow under `enforcing` says a Role grant is wider than
 * the check it replaced, which ADR-009 forbids.
 */
export interface AuthorizationDivergence {
  readonly mode: AuthorizationMode;
  readonly action: string;
  readonly resourceType: string;
  readonly principalKind: RequestPrincipal["kind"];
  readonly principalId: string;
  readonly fallback: RouteAuthorization["fallback"];
  /** What the static admin/authenticated check said. */
  readonly fallbackAllowed: boolean;
  /** What `decideEffectivePermission` said, or `"threw"` when it could not answer. */
  readonly engineAllowed: boolean | "threw";
  /** Present only when `engineAllowed` is `"threw"`. */
  readonly error?: string;
}

export interface AuthorizationGateOptions {
  readonly mode?: AuthorizationMode;
  readonly observe?: (divergence: AuthorizationDivergence) => void;
}

/**
 * Reads the deployment's gate mode and pairs it with a divergence log.
 *
 * Default `enforcing` — a deployment must opt *out* of enforcement, never into
 * it by omission. `log` is deferred because the composition root builds the
 * gate before Fastify exists.
 */
export function deploymentGateOptions(
  log: () => { warn: (payload: object, message: string) => void },
  env: NodeJS.ProcessEnv = process.env
): AuthorizationGateOptions {
  return {
    mode: env.AUTHZ_MODE === "shadow" ? "shadow" : "enforcing",
    observe: (divergence) => {
      log().warn({ event: "authz.divergence", ...divergence }, "authorization divergence");
    },
  };
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
export function makeRequireAuthorization(
  authorizer?: RouteAuthorizer,
  options?: AuthorizationGateOptions
): RequireAuthorization {
  const check = makeAuthorizationCheck(authorizer, options);
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
export function makeAuthorizationCheck(
  authorizer?: RouteAuthorizer,
  options?: AuthorizationGateOptions
): AuthorizationCheck {
  const mode = options?.mode ?? "enforcing";
  const observe = options?.observe;
  return async (principal, authorization) => {
    const fallbackAllowed =
      authorization.fallback === "authenticated" || isDeploymentAdmin(principal);
    if (authorizer === undefined) {
      return fallbackAllowed;
    }
    const record = (engineAllowed: boolean | "threw", error?: string) => {
      observe?.({
        mode,
        action: authorization.action,
        resourceType: authorization.resourceType,
        principalKind: principal.kind,
        principalId: principal.id,
        fallback: authorization.fallback,
        fallbackAllowed,
        engineAllowed,
        ...(error === undefined ? {} : { error }),
      });
    };

    let engineAllowed: boolean;
    try {
      engineAllowed = await authorizer.authorize(
        callerAuthorityPrincipal(principal),
        authorization
      );
    } catch (error) {
      // Shadow mode exists to rehearse the engine at zero risk, so an engine that
      // cannot answer must not fail the request it is only observing. Enforcing
      // mode still rethrows: there, a missing answer has to be a denial.
      if (mode === "enforcing") throw error;
      record("threw", error instanceof Error ? error.message : String(error));
      return fallbackAllowed;
    }

    if (engineAllowed !== fallbackAllowed) {
      record(engineAllowed);
    }
    return mode === "shadow" ? fallbackAllowed : engineAllowed;
  };
}
