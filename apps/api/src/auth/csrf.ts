import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { cookieSecure } from "./cookie-secure";
import { SESSION_COOKIE } from "./middleware";

export const CSRF_COOKIE = "csrf_token";
export const CSRF_HEADER = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function setCsrfCookie(reply: FastifyReply, token: string, maxAge?: number): void {
  reply.setCookie(CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: "strict",
    secure: cookieSecure(),
    path: "/",
    ...(maxAge !== undefined && { maxAge }),
  });
}

export async function csrfHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (SAFE_METHODS.has(req.method)) return;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return;

  const sid = req.cookies[SESSION_COOKIE];
  if (!sid) return;

  const cookieToken = req.cookies[CSRF_COOKIE];
  const raw = req.headers[CSRF_HEADER];
  const headerToken = Array.isArray(raw) ? raw[0] : raw;

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return reply.code(403).send({ error: "invalid csrf token" });
  }
}
