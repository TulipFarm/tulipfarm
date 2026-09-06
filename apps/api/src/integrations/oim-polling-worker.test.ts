import { PGlite } from "@electric-sql/pglite";
import type { OimManifest } from "@tulipfarm/schema";
import { POLLING_INGRESS_STORAGE_STATEMENTS, PollingIngressStore } from "@tulipfarm/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pollOimIngress } from "./oim-polling-worker";

const connection = {
  businessId: "business-1",
  id: "connection-1",
  integration: { id: "acme", majorVersion: 1 },
  label: "Acme",
  owner: { scope: "organization" as const },
  status: "active" as const,
  isDefault: true,
  configuration: {},
  agentVisibleConfiguration: [],
  secretBindings: { token: "secret://token" },
  health: { status: "healthy" as const, checkedAt: null },
  expiresAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const manifest: OimManifest = {
  oimVersion: "1.0",
  kind: "Integration",
  metadata: { id: "acme", name: "Acme", version: "1.0.0", description: "Acme", license: "MIT" },
  profiles: { core: "1.0", events: "1.0", auth: "1.0" },
  auth: { credentialSlots: [{ id: "token", label: "Token", kind: "api_key" }], steps: [] },
  operations: [
    {
      id: "poll",
      name: "poll_events",
      description: "Poll events.",
      effect: "read",
      identityMode: "shared_only",
      credentialSlot: "token",
      credentialInjection: { in: "header", name: "Authorization", format: "******" },
      source: {
        type: "http",
        method: "GET",
        baseUrl: "https://api.acme.test",
        path: "/events",
        parameters: [{ name: "cursor", in: "query", schema: { type: "string" } }],
      },
      response: { schema: { type: "object" }, maxBytes: 4096 },
    },
  ],
  events: {
    path: "/acme",
    verification: { scheme: "shared_secret", secretSlot: "token", signatureHeader: "x-token" },
    deduplication: { kind: "none" },
    eventTypes: [
      {
        type: "updated",
        selector: { pointer: "/type", equals: "updated" },
        schema: { type: "object" },
      },
    ],
  },
  ingress: {
    kind: "polling",
    operationId: "poll",
    intervalSeconds: 60,
    cursor: { responsePointer: "/cursor", requestParameter: "cursor" },
  },
};

describe("pollOimIngress", () => {
  let database: PGlite;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of POLLING_INGRESS_STORAGE_STATEMENTS) await database.exec(statement);
  });
  afterAll(async () => database.close());
  beforeEach(async () => database.query("TRUNCATE TABLE polling_ingress_state"));

  function deps(responses: unknown[], events: unknown[] = []) {
    const http = vi.fn(async (_request: { url: string }) => ({
      status: 200,
      headers: {},
      body: responses.shift() ?? { type: "updated", cursor: "after-2" },
    }));
    return {
      connections: { listPollingFallbacks: async () => [connection] },
      state: new PollingIngressStore({
        withTransaction: async (callback) =>
          callback({ query: database.query.bind(database) } as never),
      }),
      secrets: {
        leaseConnection: async () => ({
          use: async (callback: (secret: string) => unknown) => callback("credential"),
        }),
        leaseConnectionSet: async () => ({
          use: async (callback: (credentials: Readonly<Record<string, string>>) => unknown) =>
            callback({ token: "credential" }),
        }),
      } as never,
      http: { send: http },
      soulLoader: { integrations: new Map([["acme", { oimManifest: manifest }]]) } as never,
      dispatch: async (event: unknown) => {
        events.push(event);
      },
      log: { info: vi.fn(), error: vi.fn() },
      newLeaseToken: () => crypto.randomUUID(),
    };
  }

  it("resumes from the durable cursor after restart without replaying or skipping events", async () => {
    const events: Array<{ payload: { cursor: string } }> = [];
    const first = deps([{ type: "updated", cursor: "after-1" }], events);
    await pollOimIngress(first);
    const second = deps([{ type: "updated", cursor: "after-2" }], events);
    await pollOimIngress({ ...second, now: () => new Date(Date.now() + 61_000) });

    expect(events.map((event) => event.payload.cursor)).toEqual(["after-1", "after-2"]);
    expect((second.http.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].url).toContain(
      "cursor=after-1"
    );
  });

  it("leases a Connection to prevent concurrent polls from dispatching it twice", async () => {
    const test = deps([{ type: "updated", cursor: "after-1" }]);
    await Promise.all([pollOimIngress(test), pollOimIngress(test)]);

    expect(test.http.send).toHaveBeenCalledTimes(1);
  });
});
