import { ConnectionResolver, type OimPackageCatalogEntry } from "@tulipfarm/integrations";
import { type OimManifest, oimPackageDigest } from "@tulipfarm/schema";
import type { PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { CatalogBoundOimOperationConnectionResolver } from "./catalog-bound-oim-operation-resolver";

const BUSINESS_ID = "business-1";
const CREDENTIAL_REF = "secret://11111111-1111-4111-8111-111111111111" as const;

function manifest(baseUrl: string): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "provider",
      name: "Provider",
      version: "1.0.0",
      description: "Provider package.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0", auth: "1.0" },
    auth: {
      credentialSlots: [{ id: "token", label: "Token", kind: "api_key", required: true }],
      steps: [],
    },
    operations: [
      {
        id: "read",
        name: "read",
        description: "Read data.",
        effect: "read",
        identityMode: "shared_only",
        credentialSlot: "token",
        credentialInjection: { in: "header", name: "Authorization", format: "Bearer {value}" },
        source: { type: "http", method: "GET", baseUrl, path: "/me" },
        requestSchema: { type: "object", additionalProperties: false, properties: {} },
        response: { schema: { type: "object" }, maxBytes: 16_384 },
      },
    ],
  };
}

function entry(key: string, value: OimManifest): OimPackageCatalogEntry {
  return { key, manifest: value, packageDigest: oimPackageDigest(value) };
}

function operation(value: OimManifest) {
  const [selected] = value.operations;
  if (selected === undefined) throw new Error("expected operation");
  return selected;
}

function connection(): PersistedConnection {
  return {
    businessId: BUSINESS_ID,
    id: "connection-1",
    integration: { id: "provider", majorVersion: 1 },
    label: "Provider",
    owner: { scope: "organization" },
    status: "active",
    isDefault: true,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: { token: CREDENTIAL_REF },
    health: { status: "healthy", checkedAt: "2026-09-13T00:00:00.000Z" },
    expiresAt: null,
    createdAt: new Date("2026-09-13T00:00:00.000Z"),
    updatedAt: new Date("2026-09-13T00:00:00.000Z"),
  };
}

function fixture(catalog: () => readonly OimPackageCatalogEntry[]) {
  const row = connection();
  const findById = vi.fn(async () => row);
  const listForOwner = vi.fn(async () => [row]);
  const listForIntegration = vi.fn(async () => [row]);
  const authSteps = { list: vi.fn(async () => []) };
  const resolver = new CatalogBoundOimOperationConnectionResolver(
    new ConnectionResolver(
      { findById, listForOwner, listForIntegration },
      { canUse: async () => true }
    ),
    authSteps,
    catalog
  );
  return { resolver, findById, listForOwner, authSteps };
}

describe("CatalogBoundOimOperationConnectionResolver", () => {
  it.each([
    ["original first", false],
    ["alternate first", true],
  ])("rejects duplicate package identities independent of order: %s", async (_name, reverse) => {
    const original = manifest("https://api.provider.example");
    const alternate = manifest("https://attacker.example");
    const entries = [entry("provider", original), entry("alternate", alternate)];
    const { resolver, findById, listForOwner, authSteps } = fixture(() =>
      reverse ? [...entries].reverse() : entries
    );

    await expect(
      resolver.resolve({
        businessId: BUSINESS_ID,
        manifest: alternate,
        operation: operation(alternate),
        principal: { kind: "user", id: "user-1" },
      })
    ).resolves.toEqual({ kind: "connection_denied", reason: "not_found" });
    expect(findById).not.toHaveBeenCalled();
    expect(listForOwner).not.toHaveBeenCalled();
    expect(authSteps.list).not.toHaveBeenCalled();
  });

  it("resolves credentials only for the unique exact catalog package", async () => {
    const original = manifest("https://api.provider.example");
    const { resolver } = fixture(() => [entry("provider", original)]);

    await expect(
      resolver.resolve({
        businessId: BUSINESS_ID,
        manifest: original,
        operation: operation(original),
        principal: { kind: "user", id: "user-1" },
      })
    ).resolves.toMatchObject({
      kind: "ready",
      credentialRef: CREDENTIAL_REF,
      binding: { manifestDigest: oimPackageDigest(original) },
    });
  });

  it("does not return a credential when the catalog becomes ambiguous during resolution", async () => {
    const original = manifest("https://api.provider.example");
    const alternate = manifest("https://attacker.example");
    const catalog = vi
      .fn<() => readonly OimPackageCatalogEntry[]>()
      .mockReturnValueOnce([entry("provider", original)])
      .mockReturnValue([entry("provider", original), entry("alternate", alternate)]);
    const { resolver } = fixture(catalog);

    await expect(
      resolver.resolve({
        businessId: BUSINESS_ID,
        manifest: original,
        operation: operation(original),
        principal: { kind: "user", id: "user-1" },
      })
    ).resolves.toEqual({ kind: "connection_denied", reason: "not_found" });
  });

  it("rejects reauthorization when the current catalog package changes", async () => {
    const original = manifest("https://api.provider.example");
    const alternate = manifest("https://attacker.example");
    let entries: readonly OimPackageCatalogEntry[] = [entry("provider", original)];
    const { resolver } = fixture(() => entries);
    const selectedOperation = operation(original);
    const resolved = await resolver.resolve({
      businessId: BUSINESS_ID,
      manifest: original,
      operation: selectedOperation,
      principal: { kind: "user", id: "user-1" },
    });
    if (resolved.kind !== "ready") throw new Error("expected ready Connection");

    entries = [entry("alternate", alternate)];

    await expect(
      resolver.reauthorizeConnection(
        BUSINESS_ID,
        original,
        selectedOperation,
        resolved.binding,
        CREDENTIAL_REF
      )
    ).resolves.toBeNull();
  });
});
