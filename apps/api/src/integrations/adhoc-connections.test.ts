import type { SecretsService } from "@tulipfarm/secrets";
import type { PersistedConnection } from "@tulipfarm/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADHOC_CREDENTIAL_SLOT,
  AdhocConnectionError,
  adhocIntegrationId,
  assertUsableRule,
  createAdhocConnection,
  matchAdhocConnection,
  ruleOf,
} from "./adhoc-connections";

const BUSINESS = "biz-1";
const ORIGIN = "https://api.example.com";
const RULE = { location: "header", name: "authorization", valuePrefix: "Bearer " } as const;

class FakeConnections {
  readonly rows: PersistedConnection[] = [];

  async put(_businessId: string, connection: unknown): Promise<void> {
    this.rows.push(connection as PersistedConnection);
  }

  async listForOwner(
    _businessId: string,
    integration: { id: string },
    owner: { scope: string; principalId?: string }
  ): Promise<PersistedConnection[]> {
    return this.rows.filter(
      (row) =>
        row.integration.id === integration.id &&
        row.owner.scope === owner.scope &&
        (row.owner.scope !== "personal" || row.owner.principalId === owner.principalId)
    );
  }
}

function secretsFake() {
  const written = new Map<string, string>();
  return {
    written,
    service: {
      set: vi.fn(async (key: string, value: string) => {
        written.set(key, value);
      }),
    } as unknown as SecretsService,
  };
}

let ids = 0;
beforeEach(() => {
  ids = 0;
});
const newId = () => `id-${++ids}`;

describe("adhocIntegrationId", () => {
  it("gives one origin one identity", () => {
    expect(adhocIntegrationId(ORIGIN)).toBe(
      adhocIntegrationId("https://api.example.com/v1/things")
    );
  });

  it("separates origins a slug would otherwise flatten together", () => {
    // A slug cannot hold a scheme or a port, so these would collide if the id were spelled out —
    // and a credential confirmed for one would be offered for the other.
    const ids = new Set([
      adhocIntegrationId("https://api.example.com"),
      adhocIntegrationId("https://api.example.com:8443"),
      adhocIntegrationId("https://other.example.com"),
    ]);
    expect(ids.size).toBe(3);
  });

  it("produces a valid slug", () => {
    expect(adhocIntegrationId(ORIGIN)).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
  });
});

describe("assertUsableRule", () => {
  it("refuses a copied browser session", () => {
    expect(() => assertUsableRule({ ...RULE, name: "Cookie" })).toThrow(AdhocConnectionError);
  });

  it("refuses an empty header name", () => {
    expect(() => assertUsableRule({ ...RULE, name: "  " })).toThrow(AdhocConnectionError);
  });

  it("admits an ordinary API key header", () => {
    expect(() =>
      assertUsableRule({ location: "header", name: "x-api-key", valuePrefix: "" })
    ).not.toThrow();
  });
});

describe("createAdhocConnection", () => {
  it("binds the Connection to the exact confirmed origin and keeps the value out of it", async () => {
    const connections = new FakeConnections();
    const secrets = secretsFake();

    const created = await createAdhocConnection(
      { connections, secrets: secrets.service, newId },
      {
        businessId: BUSINESS,
        origin: "https://api.example.com/v1/messages?q=1",
        rule: RULE,
        secretValue: "tok-live",
        label: "Example API",
        owner: { scope: "personal", principalKind: "user", principalId: "user-1" },
      }
    );

    expect(created.origin).toBe(ORIGIN);
    const [row] = connections.rows;
    expect(row?.integration.id).toBe(adhocIntegrationId(ORIGIN));
    expect(row?.configuration.origin).toBe(ORIGIN);
    expect(row?.owner).toEqual({ scope: "personal", principalKind: "user", principalId: "user-1" });
    // The plaintext lives only in the Secrets backend; the Connection carries a reference.
    expect(JSON.stringify(row)).not.toContain("tok-live");
    expect([...secrets.written.values()]).toEqual(["tok-live"]);
  });

  it("exposes only the origin to a model, never the injection rule", async () => {
    const connections = new FakeConnections();
    await createAdhocConnection(
      { connections, secrets: secretsFake().service, newId },
      {
        businessId: BUSINESS,
        origin: ORIGIN,
        rule: RULE,
        secretValue: "tok-live",
        label: "Example API",
        owner: { scope: "organization" },
      }
    );
    expect(connections.rows[0]?.agentVisibleConfiguration).toEqual(["origin"]);
  });

  it("refuses a session header before writing anything", async () => {
    const connections = new FakeConnections();
    const secrets = secretsFake();
    await expect(
      createAdhocConnection(
        { connections, secrets: secrets.service, newId },
        {
          businessId: BUSINESS,
          origin: ORIGIN,
          rule: { ...RULE, name: "cookie" },
          secretValue: "session=abc",
          label: "Example",
          owner: { scope: "organization" },
        }
      )
    ).rejects.toThrow(AdhocConnectionError);
    expect(connections.rows).toHaveLength(0);
    expect(secrets.written.size).toBe(0);
  });

  it("refuses an origin that is not a usable public destination", async () => {
    const connections = new FakeConnections();
    await expect(
      createAdhocConnection(
        { connections, secrets: secretsFake().service, newId },
        {
          businessId: BUSINESS,
          origin: "not a url",
          rule: RULE,
          secretValue: "tok",
          label: "Example",
          owner: { scope: "organization" },
        }
      )
    ).rejects.toThrow(AdhocConnectionError);
    expect(connections.rows).toHaveLength(0);
  });
});

describe("matchAdhocConnection", () => {
  async function seed(owner: PersistedConnection["owner"], connections = new FakeConnections()) {
    await createAdhocConnection(
      { connections, secrets: secretsFake().service, newId },
      {
        businessId: BUSINESS,
        origin: ORIGIN,
        rule: RULE,
        secretValue: "tok-live",
        label: "Example",
        owner,
      }
    );
    return connections;
  }

  it("reuses one exact authorized match", async () => {
    const connections = await seed({
      scope: "personal",
      principalKind: "user",
      principalId: "user-1",
    });
    const match = await matchAdhocConnection(
      { connections },
      { businessId: BUSINESS, origin: ORIGIN, principalId: "user-1" }
    );
    expect(match).toMatchObject({ kind: "match", rule: RULE });
  });

  it("does not offer another person's personal Connection", async () => {
    const connections = await seed({
      scope: "personal",
      principalKind: "user",
      principalId: "user-1",
    });
    const match = await matchAdhocConnection(
      { connections },
      { businessId: BUSINESS, origin: ORIGIN, principalId: "user-2" }
    );
    expect(match).toEqual({ kind: "none" });
  });

  it("never matches a different origin", async () => {
    const connections = await seed({ scope: "organization" });
    const match = await matchAdhocConnection(
      { connections },
      { businessId: BUSINESS, origin: "https://api.example.com:8443", principalId: "user-1" }
    );
    expect(match).toEqual({ kind: "none" });
  });

  it("asks rather than choosing between a personal and an organization Connection", async () => {
    // Picking one silently spends a person's credential under the organization's name, or the
    // reverse.
    const connections = await seed({
      scope: "personal",
      principalKind: "user",
      principalId: "user-1",
    });
    await seed({ scope: "organization" }, connections);
    const match = await matchAdhocConnection(
      { connections },
      { businessId: BUSINESS, origin: ORIGIN, principalId: "user-1" }
    );
    expect(match).toEqual({ kind: "ambiguous", count: 2 });
  });

  it("ignores a revoked or expired Connection", async () => {
    const connections = await seed({ scope: "organization" });
    const [row] = connections.rows;
    if (row === undefined) throw new Error("seed failed");
    connections.rows[0] = { ...row, status: "revoked" } as PersistedConnection;
    await expect(
      matchAdhocConnection(
        { connections },
        { businessId: BUSINESS, origin: ORIGIN, principalId: "u" }
      )
    ).resolves.toEqual({ kind: "none" });

    connections.rows[0] = { ...row, expiresAt: "2000-01-01T00:00:00Z" } as PersistedConnection;
    await expect(
      matchAdhocConnection(
        { connections },
        { businessId: BUSINESS, origin: ORIGIN, principalId: "u" }
      )
    ).resolves.toEqual({ kind: "none" });
  });
});

describe("ruleOf", () => {
  it("refuses a stored rule that would inject a session header", () => {
    // Storage is not a second confirmation: a row edited to name `cookie` must not become usable.
    const connection = {
      configuration: { location: "header", name: "cookie", valuePrefix: "" },
      secretBindings: { [ADHOC_CREDENTIAL_SLOT]: "secret://x" },
    } as unknown as PersistedConnection;
    expect(ruleOf(connection)).toBeUndefined();
  });

  it("refuses a stored rule with an unknown location", () => {
    const connection = {
      configuration: { location: "body", name: "token", valuePrefix: "" },
    } as unknown as PersistedConnection;
    expect(ruleOf(connection)).toBeUndefined();
  });
});
