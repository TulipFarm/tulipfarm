import {
  createOimFixturePaginationRuntime,
  type EgressHttpRequest,
  resolveOimPackage,
} from "@tulipfarm/integrations";
import { canonicalHash, oimFileDigest, oimPackageDigest } from "@tulipfarm/schema";
import { bundledIntegrationsDir } from "@tulipfarm/soul";
import type { ConnectionAuthStep, PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { loadBundledOimCatalog } from "./oim-catalog";
import { createOimVerificationHost } from "./oim-verification-host";

const reference = "secret://00000000-0000-4000-8000-000000000001";
const connection: PersistedConnection = {
  businessId: "business-1",
  id: "linear-connection",
  integration: { id: "linear", majorVersion: 1 },
  label: "Linear",
  owner: { scope: "organization" },
  status: "active",
  isDefault: true,
  configuration: {},
  agentVisibleConfiguration: [],
  secretBindings: { api_key: reference },
  health: { status: "healthy", checkedAt: "2026-09-17T12:00:00.000Z" },
  expiresAt: null,
  createdAt: new Date("2026-09-17T12:00:00.000Z"),
  updatedAt: new Date("2026-09-17T12:00:00.000Z"),
};
const step: ConnectionAuthStep = {
  businessId: connection.businessId,
  connectionId: connection.id,
  stepId: "key",
  status: "active",
  accessSlot: null,
  accessSecretRef: null,
  refreshSlot: null,
  refreshSecretRef: null,
  externalIdentity: null,
  expiresAt: null,
  healthCheckedAt: null,
  revision: 7,
  createdAt: "2026-09-17T12:00:00.000Z",
  updatedAt: "2026-09-17T12:00:00.000Z",
};

async function fixture(body: unknown = { data: { viewer: { id: "viewer-1" } } }, status = 200) {
  const catalog = await loadBundledOimCatalog(bundledIntegrationsDir(), {
    requireVerification: true,
  });
  const pkg = resolveOimPackage(catalog, "linear");
  if (pkg === undefined) throw new Error("Linear must activate through the production catalog");
  const sent: EgressHttpRequest[] = [];
  const read: string[] = [];
  const host = createOimVerificationHost({
    authSteps: { list: async () => [step] },
    credentials: {
      read: async (ref) => {
        read.push(ref);
        return "offline-linear-key";
      },
    },
    http: {
      send: async (request) => {
        sent.push(request);
        return { status, headers: {}, body };
      },
    },
    paginationRuntime: createOimFixturePaginationRuntime(),
  });
  return { pkg, sent, read, host };
}

describe("Linear production GraphQL verification", () => {
  it("dispatches the pinned Viewer query and binds evidence to this exact Credential revision", async () => {
    const { pkg, sent, read, host } = await fixture();
    const evidence = await host.verify({ package: pkg, connection });
    expect(evidence).toMatchObject({
      assurance: "identified",
      issuer: "https://api.linear.app",
      subject: { kind: "human", id: "viewer-1" },
      binding: {
        businessId: connection.businessId,
        connectionId: connection.id,
        integrationId: "linear",
        integrationMajorVersion: 1,
        packageDigest: pkg.packageDigest,
        configurationDigest: canonicalHash({}),
        authSteps: [
          {
            stepId: "key",
            revision: 7,
            credentials: [{ slot: "api_key", referenceDigest: canonicalHash(reference) }],
          },
        ],
      },
    });
    expect(read).toEqual([reference]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "POST",
      url: "https://api.linear.app/graphql",
      headers: { Authorization: "offline-linear-key" },
      body: { operationName: "Viewer", variables: {} },
    });
    expect(sent[0]?.body).toHaveProperty("query", pkg.documents?.["operations/viewer.graphql"]);
    expect(JSON.stringify(evidence)).not.toContain("offline-linear-key");
  });

  it.each([
    [{ errors: [{ message: "denied" }] }, 200],
    [{ data: { viewer: { id: "viewer-1" } }, errors: [{ message: "partial" }] }, 200],
    [{ data: { viewer: null } }, 200],
    [{ data: { viewer: { id: "" } } }, 200],
    [{ data: { viewer: { id: "viewer-1" } } }, 401],
  ])("rejects provider failure or missing identity %#", async (body, status) => {
    const { pkg, host } = await fixture(body, status);
    await expect(host.verify({ package: pkg, connection })).rejects.toThrow();
  });

  it.each([
    "missing",
    "tampered",
    "mutation",
    "subscription",
    "write",
    "slots",
    "package",
  ] as const)("refuses %s verification before transport", async (failure) => {
    const { pkg, sent, host } = await fixture();
    const manifest = structuredClone(pkg.manifest);
    const documents = { ...pkg.documents };
    const viewer = manifest.operations.find(({ id }) => id === "viewer");
    const file = manifest.files?.find(({ path }) => path === "operations/viewer.graphql");
    if (viewer === undefined || file === undefined) throw new Error("missing Viewer");
    if (failure === "missing") delete documents[file.path];
    if (failure === "tampered") documents[file.path] = "query Viewer { viewer { name } }";
    if (failure === "mutation") {
      documents[file.path] = 'mutation Viewer { issueDelete(id: "issue-1") { success } }';
      file.sha256 = oimFileDigest(documents[file.path]);
    }
    if (failure === "subscription") {
      documents[file.path] = "subscription Viewer { viewer { id } }";
      file.sha256 = oimFileDigest(documents[file.path]);
    }
    if (failure === "write") viewer.effect = "update";
    if (failure === "slots") viewer.credentialSlot = "other_key";
    await expect(
      host.verify({
        package: {
          ...pkg,
          manifest,
          documents,
          packageDigest: failure === "package" ? "0".repeat(64) : oimPackageDigest(manifest),
        },
        connection,
      })
    ).rejects.toThrow();
    expect(sent).toEqual([]);
  });

  it.each([
    { ...step, connectionId: "another-connection" },
    { ...step, businessId: "another-business" },
    { ...step, status: "pending" as const },
  ])("refuses unrelated or inactive auth-step evidence %#", async (authStep) => {
    const { pkg, sent, host } = await fixture();
    await expect(
      host.verifyCandidate({
        package: pkg,
        connection,
        authSteps: [authStep],
        credentialValues: { api_key: "offline-linear-key" },
      })
    ).rejects.toThrow();
    expect(sent).toEqual([]);
  });
});
