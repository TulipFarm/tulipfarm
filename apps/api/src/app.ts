import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify from "fastify";
import { registerAuthRoutes } from "./auth/routes";
import type { SessionStore } from "./auth/session-store";
import type { UserRepo } from "./auth/users";

export interface AppOptions {
  sessionStore?: SessionStore;
  userRepo?: UserRepo;
}

export async function buildApp(opts: AppOptions = {}) {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ?? `http://localhost:${process.env.VITE_PORT ?? 4000}`,
    credentials: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });

  await app.register(cookie);

  app.get("/health", async () => ({ status: "ok" }));

  if (opts.sessionStore && opts.userRepo) {
    registerAuthRoutes(app, opts.sessionStore, opts.userRepo);
  }

  return app;
}
