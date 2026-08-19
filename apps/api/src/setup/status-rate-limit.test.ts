import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRateLimiter } from "../rate-limit.js";
import { registerSetupStatusRoute } from "./routes.js";

/**
 * Every boot of the web app calls `GET /setup/status` before it renders anything, and a failure
 * there is not degraded — the SPA shows "Application Error". So the endpoint is on the critical
 * path for *every* page load, not just the first-run wizard.
 *
 * The 30/min/IP limit exists to protect the pre-setup answer, which reads the soul from disk and
 * counts users. Once setup is settled the handler latches and answers from memory, touching
 * neither. Keeping the limit on past that point buys nothing and costs availability: one office
 * behind one NAT, or one person reloading briskly, trips it and gets the error screen.
 */
describe("GET /setup/status rate limiting", () => {
  let app: FastifyInstance;

  async function makeApp(hasUsers: boolean): Promise<FastifyInstance> {
    const instance = Fastify();
    registerSetupStatusRoute(instance, {
      userRepo: { count: async () => (hasUsers ? 1 : 0) } as never,
      soulPath: "/nonexistent-soul",
      rateLimiter: new MemoryRateLimiter(),
    });
    await instance.ready();
    return instance;
  }

  const get = () => app.inject({ method: "GET", url: "/api/v1/setup/status" });

  afterEach(async () => {
    await app?.close();
  });

  beforeEach(() => {
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;
  });

  it("keeps answering a settled instance long past the limit, so a shell boot cannot be refused", async () => {
    app = await makeApp(true);
    expect((await get()).json()).toEqual({ needsSetup: false });

    for (let i = 0; i < 60; i++) {
      const res = await get();
      expect(res.statusCode, `request ${i + 2}`).toBe(200);
      expect(res.json()).toEqual({ needsSetup: false });
    }
  });

  it("still limits an unsettled instance, where each answer costs a disk read and a user count", async () => {
    app = await makeApp(false);
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      if ((await get()).statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
