import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { useSecureCookies } from "./cookie-security";
import { SESSION_COOKIE } from "./middleware";
import type { SessionStore } from "./session-store";

export const CSRF_COOKIE = "csrf_token";
export const CSRF_HEADER = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Routes that authenticate a caller who has no session yet, so they cannot carry a session-bound
 * token: the session they establish does not exist when the request is made, and any session id the
 * browser already holds is destroyed by rotation (see `rotateSession`). Forcing one is contained by
 * the `SameSite=strict` session cookie plus that rotation.
 *
 * Invite preview and accept belong here for the same reason, and *must* be exempt rather than
 * merely unauthenticated: an invite is redeemed in whatever browser the link was opened in, which
 * in the recovery case is often one still holding the sender's live session. Gating on "no session
 * cookie" would reject exactly the person the link was issued to.
 */
const CSRF_EXEMPT_PATHS = new Set([
  "/api/v1/auth/login",
  "/api/v1/auth/invites/preview",
  "/api/v1/auth/invites/accept",
]);

export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function setCsrfCookie(reply: FastifyReply, token: string, maxAge?: number): void {
  reply.setCookie(CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: "strict",
    secure: useSecureCookies(),
    path: "/",
    ...(maxAge !== undefined && { maxAge }),
  });
}

function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export async function csrfHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (SAFE_METHODS.has(req.method)) return;
  if (CSRF_EXEMPT_PATHS.has(req.routeOptions?.url ?? req.url)) return;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return;

  const sid = req.cookies[SESSION_COOKIE];
  if (!sid) return;

  const cookieToken = req.cookies[CSRF_COOKIE];
  const raw = req.headers[CSRF_HEADER];
  const headerToken = Array.isArray(raw) ? raw[0] : raw;

  if (!cookieToken || !headerToken || !tokensMatch(cookieToken, headerToken)) {
    return reply.code(403).send({ error: "invalid csrf token" });
  }
}

/**
 * CSRF hook bound to the server-side session. Double-submit alone only proves the caller could
 * set a cookie; binding the token to the session record means a token planted by a subdomain or
 * carried over from an earlier session is rejected, and the token dies with its session.
 */
export function makeCsrfHook(store: SessionStore) {
  return async function boundCsrfHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (SAFE_METHODS.has(req.method)) return;
    if (CSRF_EXEMPT_PATHS.has(req.routeOptions?.url ?? req.url)) return;

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) return;

    const sid = req.cookies[SESSION_COOKIE];
    if (!sid) return;

    const cookieToken = req.cookies[CSRF_COOKIE];
    const raw = req.headers[CSRF_HEADER];
    const headerToken = Array.isArray(raw) ? raw[0] : raw;

    if (!cookieToken || !headerToken || !tokensMatch(cookieToken, headerToken)) {
      return reply.code(403).send({ error: "invalid csrf token" });
    }

    // A stale/expired sid cookie (e.g. left over from before a dev DB reset) resolves to no
    // session. That's not a CSRF violation — there's no authenticated session to forge a request
    // against — so let the request through; requireAuth downstream will 401 it on its own terms
    // instead of this hook masking that with a confusing "invalid csrf token".
    const session = await store.read(sid);
    if (!session) return;
    // An unbound session (legacy `SessionStore.create`) has already been checked by the
    // double-submit comparison above; a bound one must also match its stored token.
    if (session.csrfToken && !tokensMatch(session.csrfToken, headerToken)) {
      return reply.code(403).send({ error: "invalid csrf token" });
    }
  };
}
