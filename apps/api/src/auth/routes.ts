import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hashPassword, verifyPassword } from "./passwords";
import type { SessionStore } from "./session-store";
import { type UserDoc, type UserRepo, toPublicUser } from "./users";

declare module "fastify" {
  interface FastifyRequest {
    user?: UserDoc;
  }
}

export const SESSION_COOKIE = "tf_sid";
const DEFAULT_TTL_SECONDS = 604800; // 7 days

interface AuthRouteOptions {
  ttlSeconds?: number;
}

// Precomputed lazily and reused: verifying against a dummy hash on unknown-user
// login keeps response timing similar to the known-user path (no user enumeration).
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword("tulipfarm-timing-equalizer");
  }
  return dummyHashPromise;
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

export function makeRequireAuth(store: SessionStore, repo: UserRepo) {
  return async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const sid = req.cookies[SESSION_COOKIE];
    if (!sid) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    const userId = await store.get(sid);
    if (!userId) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    const user = await repo.findById(userId);
    if (!user) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    req.user = user;
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  store: SessionStore,
  repo: UserRepo,
  options: AuthRouteOptions = {}
): void {
  const ttlSeconds =
    options.ttlSeconds ??
    Number.parseInt(process.env.SESSION_TTL_SECONDS ?? String(DEFAULT_TTL_SECONDS), 10);
  const requireAuth = makeRequireAuth(store, repo);

  app.post("/api/v1/auth/login", async (req, reply) => {
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) {
      return reply.code(400).send({ error: "email and password are required" });
    }

    const user = await repo.findByEmail(email);
    if (!user) {
      await verifyPassword(await getDummyHash(), password);
      return reply.code(401).send({ error: "invalid credentials" });
    }
    if (!(await verifyPassword(user.passwordHash, password))) {
      return reply.code(401).send({ error: "invalid credentials" });
    }

    const sid = await store.create(user._id);
    reply.setCookie(SESSION_COOKIE, sid, cookieOptions(ttlSeconds));
    return reply.code(200).send({ user: toPublicUser(user) });
  });

  app.post("/api/v1/auth/logout", async (req, reply) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) {
      await store.destroy(sid);
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/v1/auth/session", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user;
    if (!user) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return reply.send({ user: toPublicUser(user) });
  });
}
