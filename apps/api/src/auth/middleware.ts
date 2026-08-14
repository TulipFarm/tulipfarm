import { PrincipalDeniedError } from "@tulipfarm/authz";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  API_CLIENT_TOKEN_PREFIX,
  type ApiClientRepo,
  authenticateApiClient,
} from "../identity/api-clients";
import {
  apiClientPrincipal,
  assertApiClientAuthenticatable,
  assertUserAuthenticatable,
  userPrincipal,
} from "../identity/principal";
import { findTokenForRawToken, type TokenRepo } from "./api-tokens";
import type { SessionStore } from "./session-store";
import type { UserDoc, UserRepo } from "./users";

declare module "fastify" {
  interface FastifyRequest {
    user?: UserDoc;
  }
}

export const SESSION_COOKIE = "tf_sid";

/** Clients always receive the same opaque 401; audit records the rejection reason. */
export type AuthDenialReason =
  | "no_credential"
  | "unknown_session"
  | "unknown_user"
  | "unknown_token"
  | "unknown_client"
  | "principal_disabled"
  | "principal_expired";

export interface RequireAuthDeps {
  store: SessionStore;
  userRepo: UserRepo;
  tokenRepo: TokenRepo;
  apiClientRepo?: ApiClientRepo;
}

function denialFromPrincipalError(error: unknown): AuthDenialReason | null {
  if (!(error instanceof PrincipalDeniedError)) return null;
  return error.reason === "disabled" ? "principal_disabled" : "principal_expired";
}

/** Resolves credentials cookie, API-client, then user-token; every path enforces status. */
export function makeRequireAuth(deps: RequireAuthDeps) {
  const { store, userRepo, tokenRepo, apiClientRepo } = deps;

  return async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const deny = (reason: AuthDenialReason) => {
      req.log?.warn(
        { event: "auth.denied", reason, credential: credentialKind(req) },
        "auth denied"
      );
      return reply.code(401).send({ error: "unauthorized" });
    };

    const sid = req.cookies[SESSION_COOKIE];
    if (sid) {
      const session = await store.read(sid);
      if (!session) return deny("unknown_session");
      const user = await userRepo.findById(session.userId);
      if (!user) return deny("unknown_user");
      try {
        assertUserAuthenticatable(user);
      } catch (error) {
        const reason = denialFromPrincipalError(error);
        if (!reason) throw error;
        return deny(reason);
      }
      req.user = user;
      req.principal = userPrincipal(user, "session", session);
      return;
    }

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const rawToken = authHeader.slice(7);

      if (rawToken.startsWith(API_CLIENT_TOKEN_PREFIX)) {
        if (!apiClientRepo) return deny("unknown_client");
        const client = await authenticateApiClient(apiClientRepo, rawToken);
        if (!client) return deny("unknown_client");
        try {
          assertApiClientAuthenticatable(client);
        } catch (error) {
          const reason = denialFromPrincipalError(error);
          if (!reason) throw error;
          return deny(reason);
        }
        req.principal = apiClientPrincipal(client);
        return;
      }

      const tokenDoc = await findTokenForRawToken(tokenRepo, rawToken);
      if (!tokenDoc) return deny("unknown_token");
      const user = await userRepo.findById(tokenDoc.userId);
      if (!user) return deny("unknown_user");
      try {
        assertUserAuthenticatable(user);
      } catch (error) {
        const reason = denialFromPrincipalError(error);
        if (!reason) throw error;
        return deny(reason);
      }
      req.user = user;
      req.principal = userPrincipal(user, "api_token");
      return;
    }

    return deny("no_credential");
  };
}

function credentialKind(req: FastifyRequest): string {
  if (req.cookies?.[SESSION_COOKIE]) return "session";
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith(`Bearer ${API_CLIENT_TOKEN_PREFIX}`)) return "client_secret";
  if (authHeader?.startsWith("Bearer ")) return "api_token";
  return "none";
}
