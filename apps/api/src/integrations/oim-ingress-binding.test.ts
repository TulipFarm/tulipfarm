import type { OimManifest } from "@tulipfarm/schema";
import type { SoulLoader } from "@tulipfarm/soul";
import type { ConnectionStore, PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import {
  oimIngressCallbackUrl,
  oimIngressResolver,
  oimWebhookBinding,
} from "./oim-ingress-binding";

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

  describe("oimIngressCallbackUrl", () => {
    it("uses the configured public API origin and never request headers", () => {
      expect(oimIngressCallbackUrl("https://api.example.com/", "twilio")).toBe(
        "https://api.example.com/api/v1/hooks/oim/twilio"
      );
      expect(oimIngressCallbackUrl("https://api.example.com", "twilio", "team one")).toBe(
        "https://api.example.com/api/v1/hooks/oim/twilio?connectionId=team%20one"
      );
    });
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

  it("does not expose a webhook route for polling-only ingress", async () => {
    const pollingManifest = {
      ...MANIFEST,
      ingress: {
        kind: "polling",
        operationId: "get-updates",
        intervalSeconds: 60,
        cursor: {
          mode: "max_integer_plus_one",
          responsePointer: "/result",
          itemPointer: "/update_id",
          requestParameter: "offset",
        },
      },
    } as unknown as OimManifest;
    const resolve = oimIngressResolver(
      loader({ weather: { oimManifest: pollingManifest } }),
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
    expect(await binding({ ...REQUEST, connectionId: "connection-1" })).toBeNull();
  });

  it("ignores a Connection that never bound the signing Secret", async () => {
    const binding = oimWebhookBinding(store([connection({ secretBindings: { api_key: "x" } })]));
    expect(await binding(REQUEST)).toBeNull();
    expect(await binding({ ...REQUEST, connectionId: "connection-1" })).toBeNull();
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

  it.each([
    ["organization", { scope: "organization" } as const],
    ["Team", { scope: "team", teamId: "00000000-0000-4000-8000-000000000004" } as const],
    ["personal", { scope: "personal", principalKind: "user", principalId: "user-1" } as const],
  ])("uses an explicit Connection identity for an exact %s binding", async (_label, owner) => {
    const binding = oimWebhookBinding(store([connection({ id: "exact-connection", owner })]));

    await expect(binding({ ...REQUEST, connectionId: "exact-connection" })).resolves.toEqual({
      connectionId: "exact-connection",
      secretRef: "secret://sec-1",
    });
  });

  it.each([
    ["Team", { scope: "team", teamId: "00000000-0000-4000-8000-000000000004" } as const],
    ["personal", { scope: "personal", principalKind: "user", principalId: "user-1" } as const],
  ])("does not select a %s Connection when the webhook URL names none", async (_label, owner) => {
    const binding = oimWebhookBinding(
      store([connection({ id: "scoped-connection", isDefault: true, owner })])
    );

    await expect(binding(REQUEST)).resolves.toBeNull();
  });

  it("never falls back when an explicit Connection id is missing or mismatched", async () => {
    const binding = oimWebhookBinding(
      store([
        connection({ id: "organization-default", isDefault: true }),
        connection({
          id: "wrong-major",
          integration: { id: "weather", majorVersion: 2 },
        }),
      ])
    );

    await expect(binding({ ...REQUEST, connectionId: "missing" })).resolves.toBeNull();
    await expect(binding({ ...REQUEST, connectionId: "wrong-major" })).resolves.toBeNull();
  });
});
