import { assertPrincipalAuthenticatable, type Principal } from "@tulipfarm/authz";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { AuthMethod } from "../auth/session-store";
import type { UserDoc } from "../auth/users";
import type { ApiClientDoc } from "./api-clients";

/** How the credential presented on a request was carried. */
export type CredentialKind = "session" | "api_token" | "client_secret";

/**
 * The typed principal every authenticated request resolves to (SPEC §12). Callers read this
 * instead of re-deriving identity from cookies or headers: it names who is acting, how they
 * proved it, and how strong that proof is, which is what step-up and audit evidence need.
 */
export interface RequestPrincipal {
  readonly id: string;
  readonly kind: "user" | "service";
  readonly businessId: string;
  readonly credential: CredentialKind;
  readonly authMethods: readonly AuthMethod[];
  readonly authenticatedAt: Date;
  /** Present only for session-backed principals. */
  readonly sessionId?: string;
  /** When a second factor was last proven for this principal, if ever. */
  readonly mfaVerifiedAt?: Date;
  /** Present only for `kind: "user"`. */
  readonly userId?: string;
  /** Present only for `kind: "service"`. */
  readonly clientId?: string;
  readonly role?: UserDoc["role"];
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: RequestPrincipal;
  }
}

/**
 * Projects a local user onto the authz principal contract for status/expiry checks. Only `active`
 * authenticates — the mapping is allowlist-shaped on purpose, so a future lifecycle state (as
 * `invited` was) cannot silently default into an authenticatable principal.
 */
export function userAsAuthzPrincipal(user: UserDoc): Principal {
  return {
    id: user._id,
    businessId: DEPLOYMENT_BUSINESS_ID,
    kind: "user",
    status: user.status === "active" ? "active" : "disabled",
  };
}

/** Projects an API client onto the authz principal contract for status/expiry checks. */
export function apiClientAsAuthzPrincipal(client: ApiClientDoc): Principal {
  return {
    id: client._id,
    businessId: DEPLOYMENT_BUSINESS_ID,
    kind: "service",
    status: client.status === "disabled" ? "disabled" : "active",
    ...(client.expiresAt ? { expiresAt: client.expiresAt } : {}),
  };
}

/**
 * Throws `PrincipalDeniedError` unless the user may authenticate right now. Disabled users are
 * rejected at every credential path, not just at login.
 */
export function assertUserAuthenticatable(user: UserDoc, now: Date = new Date()): void {
  assertPrincipalAuthenticatable(userAsAuthzPrincipal(user), now);
}

/** Throws `PrincipalDeniedError` unless the API client is active and unexpired. */
export function assertApiClientAuthenticatable(client: ApiClientDoc, now: Date = new Date()): void {
  assertPrincipalAuthenticatable(apiClientAsAuthzPrincipal(client), now);
}

export function userPrincipal(
  user: UserDoc,
  credential: Extract<CredentialKind, "session" | "api_token">,
  session?: { sid: string; authMethods: readonly AuthMethod[]; mfaVerifiedAt: Date | null }
): RequestPrincipal {
  return {
    id: user._id,
    kind: "user",
    businessId: DEPLOYMENT_BUSINESS_ID,
    credential,
    authMethods: session ? [...session.authMethods] : [],
    authenticatedAt: new Date(),
    userId: user._id,
    role: user.role,
    ...(session ? { sessionId: session.sid } : {}),
    ...(session?.mfaVerifiedAt ? { mfaVerifiedAt: session.mfaVerifiedAt } : {}),
  };
}

export function apiClientPrincipal(client: ApiClientDoc): RequestPrincipal {
  return {
    id: client._id,
    kind: "service",
    businessId: DEPLOYMENT_BUSINESS_ID,
    credential: "client_secret",
    authMethods: [],
    authenticatedAt: new Date(),
    clientId: client.clientId,
  };
}
