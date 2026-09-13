import { readFileSync } from "node:fs";
import {
  compileKnowledgeProfile,
  evaluateOimAuthVerification,
  type OimKnowledgeSyncDeps,
  pollOimIngress,
  projectVerifiedConnectionIdentity,
  syncOimKnowledge,
} from "@tulipfarm/integrations";
import {
  canonicalHash,
  type OimConnectionVerificationEvidence,
  type OimManifest,
  oimPackageDigest,
  parseOimFixtureSuite,
  parseOimManifest,
} from "@tulipfarm/schema";
import type { PersistedConnection, VerifiedConnectionExternalIdentity } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { createOimKnowledgeApi, createOimPollingDeps, type OimPollingStores } from "./oim-runtime";

const NOW = new Date("2026-09-13T12:00:00.000Z");

function loadProvider(name: "confluence" | "telegram") {
  const root = new URL(`../../../integrations/${name}/`, import.meta.url);
  const manifest = parseOimManifest(readFileSync(new URL("oim.yml", root), "utf8"));
  const fixtures = parseOimFixtureSuite(readFileSync(new URL("fixtures.yml", root), "utf8"));
  return { manifest, fixtures };
}

function fixtureResponse(provider: ReturnType<typeof loadProvider>, fixtureName: string): unknown {
  const fixture = provider.fixtures.cases.find(({ name }) => name === fixtureName);
  if (fixture?.response === undefined) throw new Error(`missing fixture response: ${fixtureName}`);
  return fixture.response.body;
}

function verify(
  manifest: OimManifest,
  configuration: Readonly<Record<string, string>>,
  checkId: string,
  response: unknown,
  credentialSlot: string
): OimConnectionVerificationEvidence {
  const verification = manifest.auth?.verification;
  if (verification === undefined) throw new Error("provider verification is missing");
  return evaluateOimAuthVerification({
    verification,
    configuration,
    responses: { [checkId]: response },
    binding: {
      businessId: "business-1",
      connectionId: `${manifest.metadata.id}-connection`,
      integrationId: manifest.metadata.id,
      integrationMajorVersion: 1,
      packageDigest: oimPackageDigest(manifest),
      configurationDigest: canonicalHash(configuration),
      authSteps: [
        {
          stepId: "credentials",
          revision: 1,
          credentials: [
            {
              slot: credentialSlot,
              referenceDigest: "a".repeat(64),
            },
          ],
        },
      ],
    },
    verifiedAt: NOW.toISOString(),
  });
}

function connection(manifest: OimManifest): PersistedConnection {
  return {
    businessId: "business-1",
    id: `${manifest.metadata.id}-connection`,
    integration: { id: manifest.metadata.id, majorVersion: 1 },
    label: manifest.metadata.name,
    owner: { scope: "organization" },
    status: "active",
    isDefault: false,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {},
    health: { status: "healthy", checkedAt: NOW.toISOString() },
    expiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function storedIdentity(
  manifest: OimManifest,
  projected: NonNullable<ReturnType<typeof projectVerifiedConnectionIdentity>>
): VerifiedConnectionExternalIdentity {
  return {
    businessId: "business-1",
    connectionId: `${manifest.metadata.id}-connection`,
    integrationId: manifest.metadata.id,
    integrationMajorVersion: 1,
    externalTenantId: projected.externalTenantId,
    externalAccountId: projected.externalAccountId,
    proofKind: "auth",
    proofDigest: projected.proofDigest,
    verifiedAt: projected.verifiedAt,
    verifiedBy: projected.verifiedBy,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

describe("provider verification identity", () => {
  it("projects the authenticated Confluence site and passes Knowledge preflight", async () => {
    const provider = loadProvider("confluence");
    const evidence = verify(
      provider.manifest,
      { site: "example.atlassian.net" },
      "current-user",
      fixtureResponse(provider, "identifies-current-user"),
      "api_credential"
    );
    const projected = projectVerifiedConnectionIdentity(evidence);
    expect(projected).toMatchObject({
      externalTenantId: "example.atlassian.net",
      externalAccountId: "user-123",
    });
    if (projected === null) throw new Error("Confluence identity was not projected");

    const options = {
      businessId: "business-1",
      integrationSlug: "confluence",
      connectionId: "confluence-connection",
      sourceKindId: "space",
      scopes: [],
    };
    const plan = compileKnowledgeProfile(provider.manifest);
    const identity = storedIdentity(provider.manifest, projected);
    const claimConnection = vi.fn(async (input) => ({ ...input, connectionGeneration: 1 }));
    const deps: OimKnowledgeSyncDeps = {
      api: createOimKnowledgeApi(
        {
          manifestDigest: oimPackageDigest(provider.manifest),
          options,
          verifiedIdentity: projected,
        },
        plan,
        { executeKnowledgeOperation: vi.fn() }
      ),
      checkpoints: {
        load: vi.fn(async () => null),
        claim: vi.fn(async () => null),
        appendPage: vi.fn(async () => null),
        stageCompletion: vi.fn(async () => null),
        acknowledgeDeletions: vi.fn(async () => null),
        complete: vi.fn(async () => null),
        release: vi.fn(async () => null),
      },
      connections: { findById: vi.fn(async () => connection(provider.manifest)) },
      connectionIdentities: { find: vi.fn(async () => identity) },
      publications: {
        claimConnection,
        find: vi.fn(async () => null),
        publish: vi.fn(async () => true),
        quarantineSource: vi.fn(async () => true),
        quarantineScope: vi.fn(async () => []),
        quarantineInvalidConnection: vi.fn(async () => []),
        markDeleted: vi.fn(async () => true),
      },
      identity: {
        resolve: vi.fn(async () => ({ principals: [], incomplete: false })),
      },
      now: () => NOW,
      newId: () => "id-1",
    };
    const result = await syncOimKnowledge(plan, deps, options);

    expect(claimConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        externalTenantId: "example.atlassian.net",
        externalAccountId: "user-123",
      })
    );
    expect(result.failures).toEqual([]);
  });

  it("uses the authenticated Telegram bot as the polling tenant, not a chat", async () => {
    const provider = loadProvider("telegram");
    const evidence = verify(
      provider.manifest,
      {},
      "current-bot",
      fixtureResponse(provider, "identifies-bot"),
      "bot_token"
    );
    const projected = projectVerifiedConnectionIdentity(evidence);
    expect(projected).toMatchObject({
      externalTenantId: "123456789",
      externalAccountId: "123456789",
    });
    if (projected === null) throw new Error("Telegram identity was not projected");

    const identity = storedIdentity(provider.manifest, projected);
    type RecordVerifiedIfActive = OimPollingStores["polling"]["recordVerifiedIfActive"];
    const recordVerifiedIfActive = vi.fn(
      async (
        key: Parameters<RecordVerifiedIfActive>[0],
        input: Parameters<RecordVerifiedIfActive>[1]
      ): Promise<Awaited<ReturnType<RecordVerifiedIfActive>>> => ({
        accepted: true,
        delivery: {
          businessId: key.businessId,
          ...input,
          state: "accepted",
          attempts: 0,
          lastError: null,
          normalizedPayload: null,
          replayOfId: null,
          receivedAt: NOW,
          nextAttemptAt: NOW,
          leaseExpiresAt: null,
          rawDeletedAt: null,
        },
      })
    );
    const stores = {
      connections: { findById: vi.fn(async () => connection(provider.manifest)) },
      identities: { find: vi.fn(async () => identity) },
      teardowns: { isDisabled: vi.fn(async () => false) },
      polling: {
        claim: vi.fn(async () => ({ cursor: null })),
        complete: vi.fn(async () => true),
        release: vi.fn(async () => true),
        recordVerifiedIfActive,
      },
    };
    const encryptPayload = vi.fn(async (_payload: Buffer) => "encrypted");
    const update = {
      update_id: 101,
      message: {
        message_id: 9,
        text: "Launch ready?",
        date: 1788760800,
        chat: { id: -1001234567890, title: "Launch room" },
      },
    };

    await pollOimIngress(
      createOimPollingDeps(
        stores,
        {
          listPollingRegistrations: vi.fn(async () => [
            {
              businessId: "business-1",
              connectionId: "telegram-connection",
              integrationId: "telegram",
              integrationMajorVersion: 1,
            },
          ]),
          resolveConnectionManifest: vi.fn(async () => provider.manifest),
          executePollingOperation: vi.fn(async () => ({
            response: { ok: true, result: [update] },
            authenticatedEvidenceDigest: evidence.proofDigest,
            verifiedIdentity: projected,
          })),
          encryptPayload,
        },
        { now: () => NOW, newId: () => "id-1" }
      )
    );

    expect(recordVerifiedIfActive).toHaveBeenCalledWith(
      expect.objectContaining({
        externalTenantId: "123456789",
        externalAccountId: "123456789",
      }),
      expect.objectContaining({
        eventType: "message.received",
      })
    );
    const pollingPayload = encryptPayload.mock.calls[0]?.[0];
    expect(pollingPayload).toBeDefined();
    expect(JSON.parse(pollingPayload?.toString("utf8") ?? "")).toMatchObject({
      message: { chat: { id: -1001234567890 } },
    });
  });
});
