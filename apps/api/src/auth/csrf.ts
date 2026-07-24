import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE } from "./middleware";
import type { SessionStore } from "./session-store";

export const CSRF_COOKIE = "csrf_token";
export const CSRF_HEADER = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Login cannot carry a session-bound token: the session it authenticates does not exist yet, and
 * any session id the browser already holds is destroyed by rotation (see `rotateSession`). Forced
 * login is contained by the `SameSite=strict` session cookie plus that rotation.
 */
const CSRF_EXEMPT_PATHS = new Set(["/api/v1/auth/login"]);

export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function setCsrfCookie(reply: FastifyReply, token: string, maxAge?: number): void {
  reply.setCookie(CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
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

    const session = await store.read(sid);
    if (!session) {
      return reply.code(403).send({ error: "invalid csrf token" });
    }
    // An unbound session (legacy `SessionStore.create`) has already been checked by the
    // double-submit comparison above; a bound one must also match its stored token.
    if (session.csrfToken && !tokensMatch(session.csrfToken, headerToken)) {
      return reply.code(403).send({ error: "invalid csrf token" });
    }
  };
}
