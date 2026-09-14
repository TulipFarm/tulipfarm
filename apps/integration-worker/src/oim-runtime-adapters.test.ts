import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type OimKnowledgeSyncOptions,
  pollOimIngress,
  type VerifiedProviderIdentity,
} from "@tulipfarm/integrations";
import { canonicalHash, type OimManifest, parseOimManifest } from "@tulipfarm/schema";
import type { PersistedConnection, VerifiedConnectionExternalIdentity } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import {
  createOimKnowledgeApi,
  createOimPollingDeps,
  type OimPollingHost,
  type OimPollingStores,
} from "./oim-runtime";

const manifest = parseOimManifest(
  readFileSync(join(__dirname, "../../../integrations/telegram/oim.yml"), "utf8")
);
const now = new Date("2026-09-13T12:00:00.000Z");

function connection(overrides: Partial<PersistedConnection> = {}): PersistedConnection {
  return {
    id: "telegram-connection",
    businessId: "business-1",
    integration: { id: manifest.metadata.id, majorVersion: 1 },
    label: "Telegram",
    owner: { scope: "organization" },
    status: "active",
    isDefault: false,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {},
    health: { status: "healthy", checkedAt: now.toISOString() },
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function identity(): VerifiedConnectionExternalIdentity {
  return {
    businessId: "business-1",
    connectionId: "telegram-connection",
    integrationId: manifest.metadata.id,
    integrationMajorVersion: 1,
    externalTenantId: "tenant-1",
    externalAccountId: "account-1",
    proofKind: "health",
    proofDigest: "a".repeat(64),
    verifiedAt: now.toISOString(),
    verifiedBy: "get-me",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function pollingStores(
  selectedConnection: PersistedConnection,
  tornDown = false
): OimPollingStores {
  return {
    connections: { findById: vi.fn(async () => selectedConnection) },
    identities: { find: vi.fn(async () => identity()) },
    teardowns: { isDisabled: vi.fn(async () => tornDown) },
    polling: {
      claim: vi.fn(async () => ({ cursor: null })),
      complete: vi.fn(async () => true),
      release: vi.fn(async () => true),
      recordVerifiedIfActive: vi.fn(async () => {
        throw new Error("unexpected record");
      }),
    },
  };
}

function pollingHost(
  resolveConnectionManifest: OimPollingHost["resolveConnectionManifest"],
  executePollingOperation = vi.fn(async () => ({
    response: { ok: true, result: [] },
    authenticatedEvidenceDigest: "b".repeat(64),
    verifiedIdentity: {
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
    },
  }))
): OimPollingHost {
  return {
    encryptPayload: vi.fn(async () => "encrypted"),
    listPollingRegistrations: vi.fn(async () => [
      {
        businessId: "business-1",
        connectionId: "telegram-connection",
        integrationId: manifest.metadata.id,
        integrationMajorVersion: 1,
      },
    ]),
    resolveConnectionManifest,
    executePollingOperation,
  };
}

describe("OIM polling composition", () => {
  it.each([
    ["revoked", connection({ status: "revoked" }), false],
    [
      "action-required",
      connection({ health: { status: "action_required", checkedAt: now.toISOString() } }),
      false,
    ],
    [
      "unknown-health",
      connection({ health: { status: "unknown", checkedAt: now.toISOString() } }),
      false,
    ],
    ["expired-healthy", connection({ expiresAt: "2026-09-13T11:59:59.000Z" }), false],
    [
      "expired-expiring",
      connection({
        health: { status: "expiring", checkedAt: now.toISOString() },
        expiresAt: "2026-09-13T11:59:59.000Z",
      }),
      false,
    ],
    ["torn-down", connection(), true],
  ])(
    "rejects %s Connections before manifest or provider access",
    async (_name, current, tornDown) => {
      const resolveManifest = vi.fn(async () => manifest);
      const execute = vi.fn(async () => ({
        response: { ok: true, result: [] },
        authenticatedEvidenceDigest: "b".repeat(64),
        verifiedIdentity: {
          externalTenantId: "tenant-1",
          externalAccountId: "account-1",
        },
      }));

      await pollOimIngress(
        createOimPollingDeps(
          pollingStores(current, tornDown),
          pollingHost(resolveManifest, execute),
          { now: () => now, newId: () => "lease-1" }
        )
      );

      expect(resolveManifest).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it("binds provider execution to the reviewed manifest and rejects a changed package", async () => {
    const changedManifest: OimManifest = {
      ...manifest,
      metadata: {
        ...manifest.metadata,
        description: `${manifest.metadata.description} changed`,
      },
    };
    const resolveManifest = vi
      .fn<OimPollingHost["resolveConnectionManifest"]>()
      .mockResolvedValueOnce(manifest)
      .mockResolvedValueOnce(changedManifest);
    const execute = vi.fn(async () => ({
      response: { ok: true, result: [] },
      authenticatedEvidenceDigest: "b".repeat(64),
      verifiedIdentity: {
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
      },
    }));
    const stores = pollingStores(connection());

    const result = await pollOimIngress(
      createOimPollingDeps(stores, pollingHost(resolveManifest, execute), {
        now: () => now,
        newId: () => "lease-1",
      })
    );

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ expectedManifestDigest: canonicalHash(manifest) })
    );
    expect(stores.polling.recordVerifiedIfActive).not.toHaveBeenCalled();
    expect(stores.polling.complete).not.toHaveBeenCalled();
    expect(stores.polling.release).toHaveBeenCalledOnce();
    expect(result.failures).toEqual([expect.objectContaining({ code: "source_revoked" })]);
  });
});

describe("OIM Knowledge composition", () => {
  it("binds every operation request to the reviewed manifest digest", async () => {
    const executeKnowledgeOperation = vi.fn(async () => ({ body: { items: [] } }));
    const options: OimKnowledgeSyncOptions = {
      businessId: "business-1",
      integrationSlug: "confluence",
      connectionId: "confluence-connection",
      sourceKindId: "pages",
      scopes: ["space-1"],
    };
    const verifiedIdentity: VerifiedProviderIdentity = {
      externalTenantId: "site-1",
      externalAccountId: "user-1",
    };
    const api = createOimKnowledgeApi(
      {
        manifestDigest: "c".repeat(64),
        options,
        verifiedIdentity,
      },
      { integrationId: "confluence", majorVersion: 1 },
      { executeKnowledgeOperation }
    );

    await api.execute({
      operationId: "list-pages",
      parameters: { spaceId: "space-1" },
      pageToken: "next",
    });

    expect(executeKnowledgeOperation).toHaveBeenCalledWith({
      businessId: "business-1",
      connectionId: "confluence-connection",
      integrationId: "confluence",
      integrationMajorVersion: 1,
      operationId: "list-pages",
      parameters: { spaceId: "space-1" },
      pageToken: "next",
      purpose: "knowledge_sync",
      expectedManifestDigest: "c".repeat(64),
    });
  });
});
