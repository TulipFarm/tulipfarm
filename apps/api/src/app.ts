import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify from "fastify";

export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ?? "http://localhost:4000",
    credentials: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
