import { ProductTelemetryReporter, type ProductTelemetryState } from "@tulipfarm/observability";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../../app";
import { PgTokenRepo } from "../../auth/api-tokens";
import { MemorySessionStore } from "../../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../../auth/users";

class Users implements UserRepo {
  users: UserDoc[] = [];
  async count() {
    return this.users.length;
  }
  async findByEmail(email: string) {
    return this.users.find((u) => u.email === email) ?? null;
  }
  async findById(id: string) {
    return this.users.find((u) => u._id === id) ?? null;
  }
  async insert(user: UserDoc) {
    this.users.push(user);
  }
}
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function fixture(role: "member" | "admin") {
  const userRepo = new Users();
  const sessionStore = new MemorySessionStore();
  const user = await createUser(userRepo, "admin@tulipfarm.dev", "valid-password", role);
  const session = await sessionStore.issue({ userId: user._id, authMethods: ["password"] });
  let state: ProductTelemetryState;
  const reporter = new ProductTelemetryReporter({
    maxLevel: 1,
    production: false,
    store: {
      async initialize(value) {
        state ??= value;
      },
      async locked(fn) {
        return fn(state);
      },
    },
    bootstrap: async () => ({
      version: "1",
      os: "linux",
      architecture: "x64",
      deployment_method: "unknown",
    }),
    snapshot: async () => ({
      users: 1,
      resource_types: 0,
      integrations: 0,
      skills: 0,
      bundled_skills: 0,
      agents: 0,
      routines: 0,
    }),
  });
  await reporter.initialize();
  await reporter.completeSetup();
  const app = await buildApp({
    userRepo,
    sessionStore,
    productTelemetry: reporter,
    tokenRepo: new PgTokenRepo({ query: async () => ({ rows: [] }) }),
  });
  apps.push(app);
  return {
    app,
    headers: {
      cookie: `tf_sid=${session.sid}; csrf_token=${session.csrfToken}`,
      "x-csrf-token": session.csrfToken,
    },
  };
}
it("requires administrator authority for previews and changes", async () => {
  const { app, headers } = await fixture("member");
  expect(
    (await app.inject({ method: "GET", url: "/api/v1/system/telemetry", headers })).statusCode
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/system/telemetry",
        headers,
        payload: { level: 0 },
      })
    ).statusCode
  ).toBe(403);
});
it("previews a capped candidate without configuring optional sharing and saves level zero", async () => {
  const { app, headers } = await fixture("admin");
  const preview = await app.inject({
    method: "GET",
    url: "/api/v1/system/telemetry?level=2",
    headers,
  });
  expect(preview.statusCode).toBe(200);
  expect(preview.json()).toMatchObject({
    configured: false,
    level: 2,
    effectiveLevel: 1,
    maxLevel: 1,
    enabled: false,
    preview: { snapshot: { telemetry_level: 1 } },
  });
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/system/telemetry",
    headers,
    payload: { level: 0 },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toMatchObject({
    configured: true,
    level: 0,
    effectiveLevel: 0,
    preview: { snapshot: null },
  });
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/system/telemetry",
        headers,
        payload: { level: 3 },
      })
    ).statusCode
  ).toBe(400);
  const internal = await app.inject({
    method: "POST",
    url: "/api/v1/internal/system/telemetry/dispatch",
    headers,
  });
  expect(internal.statusCode).toBe(403);
});
