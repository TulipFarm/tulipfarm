import type { OimManifest } from "@tulipfarm/schema";
import type { SoulLoader } from "@tulipfarm/soul";
import type { ConnectionStore, PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { oimIngressResolver, oimWebhookBinding } from "./oim-ingress-binding";

const MANIFEST = {
  metadata: { id: "weather", version: "1.0.0" },
  events: { path: "/weather" },
} as unknown as OimManifest;

function loader(entries: Record<string, unknown>): SoulLoader {
  return { integrations: new Map(Object.entries(entries)) } as unknown as SoulLoader;
}

function connection(overrides: Partial<PersistedConnection> = {}): PersistedConnection {
  return {
    id: "connection-1",
    integration: { id: "weather", majorVersion: 1 },
    status: "active",
    isDefault: false,
    secretBindings: { webhook_secret: "secret://sec-1" },
    owner: { scope: "organization" },
    ...overrides,
  } as PersistedConnection;
}

function store(rows: PersistedConnection[]): Pick<ConnectionStore, "findById" | "listForOwner"> {
  return {
    findById: async (_businessId: string, id: string) => rows.find((row) => row.id === id) ?? null,
    listForOwner: async (
      _businessId: string,
      _integration: PersistedConnection["integration"],
      owner: PersistedConnection["owner"]
    ) =>
      rows.filter(
        (row) =>
          row.owner.scope === owner.scope &&
          (owner.scope !== "team" ||
            (row.owner.scope === "team" && row.owner.teamId === owner.teamId))
      ),
  } as unknown as Pick<ConnectionStore, "findById" | "listForOwner">;
}

const REQUEST = {
  businessId: "biz-1",
  integrationId: "weather",
  majorVersion: 1,
  secretSlot: "webhook_secret",
};

describe("oimIngressResolver", () => {
  it("resolves a connected Integration that declares events", async () => {
    const resolve = oimIngressResolver(
      loader({ weather: { oimManifest: MANIFEST, connection: { enabled: true } } }),
      "biz-1"
    );
    expect(await resolve("weather")).toEqual({ businessId: "biz-1", manifest: MANIFEST });
  });

  it("does not use the legacy Soul connection flag for an OIM Integration", async () => {
    // OIM Connection state is durable Postgres state. The separate binding lookup refuses a
    // delivery unless an active Connection owns its signing Secret.
    const resolve = oimIngressResolver(
      loader({ weather: { oimManifest: MANIFEST, connection: { enabled: false } } }),
      "biz-1"
    );
    expect(await resolve("weather")).toEqual({ businessId: "biz-1", manifest: MANIFEST });
  });

  it("resolves nothing for an Integration that declares no events", async () => {
    const resolve = oimIngressResolver(
      loader({
        weather: { oimManifest: { metadata: MANIFEST.metadata }, connection: { enabled: true } },
      }),
      "biz-1"
    );
    expect(await resolve("weather")).toBeNull();
  });

  it("resolves nothing for a slug nobody installed", async () => {
    expect(await oimIngressResolver(loader({}), "biz-1")("weather")).toBeNull();
  });
});

describe("oimWebhookBinding", () => {
  it("uses the only Connection that binds the signing slot", async () => {
    const binding = oimWebhookBinding(store([connection()]));
    expect(await binding(REQUEST)).toEqual({
      connectionId: "connection-1",
      secretRef: "secret://sec-1",
    });
  });

  it("prefers the Connection an operator marked default", async () => {
    const binding = oimWebhookBinding(
      store([
        connection({ id: "connection-1" }),
        connection({ id: "connection-2", isDefault: true }),
      ])
    );
    expect(await binding(REQUEST)).toMatchObject({ connectionId: "connection-2" });
  });

  it("refuses to guess between two Connections", async () => {
    const binding = oimWebhookBinding(
      store([connection({ id: "connection-1" }), connection({ id: "connection-2" })])
    );
    expect(await binding(REQUEST)).toBeNull();
  });

  it("ignores a revoked Connection", async () => {
    const binding = oimWebhookBinding(store([connection({ status: "revoked" })]));
    expect(await binding(REQUEST)).toBeNull();
  });

  it("ignores a Connection that never bound the signing Secret", async () => {
    const binding = oimWebhookBinding(store([connection({ secretBindings: { api_key: "x" } })]));
    expect(await binding(REQUEST)).toBeNull();
  });

  it("asks only for organization Connections", async () => {
    // A webhook arrives with no principal, so no person's own Connection can be the right answer.
    let asked: unknown;
    const binding = oimWebhookBinding({
      findById: async () => null,
      listForOwner: async (
        _businessId: string,
        _integration: PersistedConnection["integration"],
        owner: PersistedConnection["owner"]
      ) => {
        asked = owner;
        return [connection()];
      },
    });

    await binding(REQUEST);
    expect(asked).toEqual({ scope: "organization" });
  });

  it("uses the connection identity in a Team webhook URL", async () => {
    const binding = oimWebhookBinding(
      store([
        connection({
          id: "team-connection",
          owner: { scope: "team", teamId: "00000000-0000-4000-8000-000000000004" },
        }),
      ])
    );

    await expect(binding({ ...REQUEST, connectionId: "team-connection" })).resolves.toEqual({
      connectionId: "team-connection",
      secretRef: "secret://sec-1",
    });
  });

  it("does not select a Team Connection when the webhook URL names none", async () => {
    const binding = oimWebhookBinding(
      store([
        connection({
          id: "team-connection",
          isDefault: true,
          owner: { scope: "team", teamId: "00000000-0000-4000-8000-000000000004" },
        }),
      ])
    );

    await expect(binding(REQUEST)).resolves.toBeNull();
  });
});
