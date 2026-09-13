import type { PGlite } from "@electric-sql/pglite";
import {
  type KnowledgeProfilePlan,
  type OimKnowledgeSyncDeps,
  syncOimKnowledge,
} from "@tulipfarm/integrations";
import type { OimConnection } from "@tulipfarm/schema";
import {
  ConnectionExternalIdentityStore,
  ConnectionStore,
  type OimKnowledgeCheckpointKey,
  OimKnowledgeCheckpointStore,
  type OimKnowledgePublicationClaim,
  OimKnowledgePublicationStore,
  type OimKnowledgeSourcePublication,
  transactionPort,
} from "@tulipfarm/storage";
import { afterEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { PgKnowledgeSourceStore } from "./source-store";

type ScopeQuarantineInput = Parameters<OimKnowledgePublicationStore["quarantineScope"]>[0] & {
  readonly claim: OimKnowledgePublicationClaim;
};

const BUSINESS_ID = "business-1";
const CONNECTION_ID = "connection-1";
const CAPTURED_AT = "2026-09-13T10:00:00.000Z";

function connection(overrides: Partial<OimConnection> = {}): OimConnection {
  return {
    id: CONNECTION_ID,
    integration: { id: "wiki", majorVersion: 2 },
    label: CONNECTION_ID,
    owner: { scope: "organization" },
    status: "active",
    isDefault: false,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {},
    health: { status: "healthy", checkedAt: CAPTURED_AT },
    expiresAt: null,
    ...overrides,
  };
}

function source(itemId: string, scope: string): OimKnowledgeSourcePublication {
  return {
    businessId: BUSINESS_ID,
    sourceId: `wiki:${CONNECTION_ID}/${itemId}`,
    integrationId: "wiki",
    integrationMajorVersion: 2,
    provider: "wiki",
    externalId: itemId,
    externalTenantId: "tenant-1",
    ownerExternalId: "account-1",
    sourceLocator: {
      kind: "oim",
      integrationSlug: "wiki-install",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: CONNECTION_ID,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      sourceKindId: "page",
      scope,
      itemId,
    },
    revision: "provider-revision-1",
    classification: ["internal"],
    verification: "verified",
    accessControlMode: "snapshot",
    accessControlMaximumAgeSeconds: 300,
    aclRevision: "acl-1",
    aclCapturedAt: CAPTURED_AT,
    aclPrincipals: [{ kind: "user", id: "user-1" }],
    provenanceCapturedAt: CAPTURED_AT,
    provenanceContentHash: "a".repeat(64),
    provenanceCheckpoint: "scan-1",
    provenanceConnectionId: CONNECTION_ID,
    lastSyncedAt: CAPTURED_AT,
  };
}

function operation(id: string): KnowledgeProfilePlan["list"]["operation"] {
  return {
    id,
    name: id,
    description: id,
    effect: "read",
    identityMode: "shared_only",
    source: {
      type: "http",
      method: "GET",
      baseUrl: "https://wiki.example",
      path: `/${id}`,
      parameters: [],
    },
    response: { schema: { type: "object" }, maxBytes: 1_048_576 },
  };
}

function syncPlan(): KnowledgeProfilePlan {
  return {
    integrationId: "wiki",
    integrationVersion: "2.1.0",
    majorVersion: 2,
    sourceKinds: [{ id: "page", label: "Page" }],
    list: {
      operation: operation("list"),
      scopeParameter: "space",
      itemsPointer: "/items",
      mapping: { itemId: "/id", revision: "/revision" },
      cursor: { kind: "operation_pagination" },
      maxPagesPerRun: 1,
    },
    content: {
      operation: operation("content"),
      itemParameter: "id",
      mapping: { content: "/content", revision: "/revision" },
      sensitive: false,
    },
    acl: {
      mode: "scope",
      operation: operation("acl"),
      parameter: "space",
      entriesPointer: "/readers",
      entry: { defaultKind: "user", providerUserId: "/id" },
    },
    deletion: { kind: "absent_from_full_list" },
  };
}

async function claimScope(
  transactions: ReturnType<typeof transactionPort>,
  key: OimKnowledgeCheckpointKey,
  scanId: string,
  leaseToken: string,
  now: Date
): Promise<OimKnowledgePublicationClaim> {
  const checkpoint = await new OimKnowledgeCheckpointStore(transactions).claim(
    key,
    scanId,
    leaseToken,
    300,
    now
  );
  const connectionClaim = await new OimKnowledgePublicationStore(transactions).claimConnection({
    businessId: BUSINESS_ID,
    integrationId: "wiki",
    integrationMajorVersion: 2,
    connectionId: CONNECTION_ID,
    externalTenantId: "tenant-1",
    externalAccountId: "account-1",
  });
  if (
    checkpoint === null ||
    checkpoint.scanId === null ||
    checkpoint.leaseToken === null ||
    connectionClaim === null
  ) {
    throw new Error("expected OIM publication claim");
  }
  return {
    ...connectionClaim,
    sourceKindId: key.sourceKind,
    scope: key.scope,
    scanId: checkpoint.scanId,
    leaseToken: checkpoint.leaseToken,
    checkpointRevision: checkpoint.revision,
  };
}

describe("OIM stale scope quarantine fencing", () => {
  let database: PGlite | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("preserves a completed replacement publication when the stale ACL worker quarantines its scope", async () => {
    database = await makeMigratedPglite();
    const transactions = transactionPort(database);
    const publications = new OimKnowledgePublicationStore(transactions);
    const checkpoints = new OimKnowledgeCheckpointStore(transactions);
    const sources = new PgKnowledgeSourceStore(database);
    const leaseStartedAt = new Date();
    const raceKey: OimKnowledgeCheckpointKey = {
      businessId: BUSINESS_ID,
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: CONNECTION_ID,
      sourceKind: "page",
      scope: "space-race",
    };

    await new ConnectionStore(transactions).put(BUSINESS_ID, connection());
    await new ConnectionExternalIdentityStore(transactions).bindVerified({
      businessId: BUSINESS_ID,
      connectionId: CONNECTION_ID,
      integrationId: "wiki",
      integrationMajorVersion: 2,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofKind: "auth",
      proofDigest: "a".repeat(64),
      verifiedAt: CAPTURED_AT,
      verifiedBy: "provider-auth",
    });

    const workerAClaim = await claimScope(
      transactions,
      raceKey,
      "scan-race",
      "lease-worker-a",
      leaseStartedAt
    );
    const publishedSource = source("page-1", raceKey.scope);
    await publications.publish({
      claim: workerAClaim,
      source: publishedSource,
      chunks: [
        {
          chunkId: `${publishedSource.sourceId}#content`,
          revision: publishedSource.revision,
          classification: ["internal"],
          digest: "b".repeat(64),
          content: "content before replacement worker",
        },
      ],
    });
    const staleScopeQuarantine: ScopeQuarantineInput = {
      claim: workerAClaim,
      businessId: BUSINESS_ID,
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: CONNECTION_ID,
      sourceKindId: raceKey.sourceKind,
      scope: raceKey.scope,
      quarantinedRevisionPrefix: "quarantine:worker-a",
      quarantinedAt: CAPTURED_AT,
    };

    const replacementStartedAt = new Date(leaseStartedAt.getTime() + 301_000);
    const workerBClaim = await claimScope(
      transactions,
      raceKey,
      "scan-race",
      "lease-worker-b",
      replacementStartedAt
    );
    await publications.publish({
      expectedRevision: publishedSource.revision,
      claim: workerBClaim,
      source: publishedSource,
      chunks: [
        {
          chunkId: `${publishedSource.sourceId}#content`,
          revision: publishedSource.revision,
          classification: ["internal"],
          digest: "c".repeat(64),
          content: "fresh content from replacement worker",
        },
      ],
    });
    const listed = await checkpoints.appendPage(
      raceKey,
      workerBClaim.leaseToken,
      workerBClaim.checkpointRevision,
      null,
      ["page-1"],
      replacementStartedAt
    );
    if (listed === null) throw new Error("expected replacement worker page");
    const completedByWorkerB = await checkpoints.complete(
      raceKey,
      workerBClaim.leaseToken,
      listed.revision,
      replacementStartedAt
    );
    if (completedByWorkerB === null) throw new Error("expected replacement worker completion");

    const sourceAfterWorkerB = await sources.get(BUSINESS_ID, publishedSource.sourceId);
    const chunksAfterWorkerB = await database.query<{
      content: string;
      digest: string;
      revision: string;
    }>(
      `SELECT content, digest, revision
         FROM knowledge_source_chunks
        WHERE business_id = $1 AND source_id = $2
        ORDER BY chunk_id`,
      [BUSINESS_ID, publishedSource.sourceId]
    );
    expect(completedByWorkerB).toMatchObject({
      baselineItemIds: ["page-1"],
      scanId: null,
      requiresFullRebuild: false,
      leaseToken: null,
    });
    expect(sourceAfterWorkerB).toMatchObject({
      revision: "provider-revision-1",
      verification: "verified",
      status: "active",
    });
    expect(chunksAfterWorkerB.rows).toEqual([
      {
        content: "fresh content from replacement worker",
        digest: "c".repeat(64),
        revision: "provider-revision-1",
      },
    ]);

    await publications.quarantineScope(staleScopeQuarantine);

    expect(await checkpoints.load(raceKey)).toEqual(completedByWorkerB);
    expect(await sources.get(BUSINESS_ID, publishedSource.sourceId)).toEqual(sourceAfterWorkerB);
    expect(
      await database.query<{ content: string; digest: string; revision: string }>(
        `SELECT content, digest, revision
           FROM knowledge_source_chunks
          WHERE business_id = $1 AND source_id = $2
          ORDER BY chunk_id`,
        [BUSINESS_ID, publishedSource.sourceId]
      )
    ).toEqual(chunksAfterWorkerB);

    const controlKey: OimKnowledgeCheckpointKey = {
      ...raceKey,
      scope: "space-control",
    };
    const currentClaim = await claimScope(
      transactions,
      controlKey,
      "scan-control",
      "lease-control",
      new Date()
    );
    const controlSource = source("page-control", controlKey.scope);
    await publications.publish({
      claim: currentClaim,
      source: controlSource,
      chunks: [
        {
          chunkId: `${controlSource.sourceId}#content`,
          revision: controlSource.revision,
          classification: ["internal"],
          digest: "d".repeat(64),
          content: "control content",
        },
      ],
    });
    const currentScopeQuarantine: ScopeQuarantineInput = {
      claim: currentClaim,
      businessId: BUSINESS_ID,
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: CONNECTION_ID,
      sourceKindId: controlKey.sourceKind,
      scope: controlKey.scope,
      quarantinedRevisionPrefix: "quarantine:control",
      quarantinedAt: CAPTURED_AT,
    };

    await publications.quarantineScope(currentScopeQuarantine);

    expect(await sources.get(BUSINESS_ID, controlSource.sourceId)).toMatchObject({
      verification: "unverifiable",
      status: "active",
    });
    await expect(
      database.query(
        `SELECT chunk_id
           FROM knowledge_source_chunks
          WHERE business_id = $1 AND source_id = $2`,
        [BUSINESS_ID, controlSource.sourceId]
      )
    ).resolves.toMatchObject({ rows: [] });
  });

  it("conditionally tombstones only a Connection that is still invalid", async () => {
    database = await makeMigratedPglite();
    const transactions = transactionPort(database);
    const connections = new ConnectionStore(transactions);
    const publications = new OimKnowledgePublicationStore(transactions);
    await connections.put(BUSINESS_ID, connection());
    await new ConnectionExternalIdentityStore(transactions).bindVerified({
      businessId: BUSINESS_ID,
      connectionId: CONNECTION_ID,
      integrationId: "wiki",
      integrationMajorVersion: 2,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofKind: "auth",
      proofDigest: "a".repeat(64),
      verifiedAt: CAPTURED_AT,
      verifiedBy: "provider-auth",
    });
    const key: OimKnowledgeCheckpointKey = {
      businessId: BUSINESS_ID,
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: CONNECTION_ID,
      sourceKind: "page",
      scope: "space-1",
    };
    const claim = await claimScope(transactions, key, "scan-1", "lease-1", new Date());
    const publishedSource = source("page-1", key.scope);
    await publications.publish({
      claim,
      source: publishedSource,
      chunks: [
        {
          chunkId: `${publishedSource.sourceId}#content`,
          revision: publishedSource.revision,
          classification: ["internal"],
          digest: "e".repeat(64),
          content: "current content",
        },
      ],
    });

    await expect(
      publications.quarantineInvalidConnection({
        businessId: BUSINESS_ID,
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: CONNECTION_ID,
        deletedRevisionPrefix: "invalid:stale-read",
        deletedAt: CAPTURED_AT,
      })
    ).resolves.toBeNull();
    await expect(publications.find(BUSINESS_ID, publishedSource.sourceId)).resolves.toMatchObject({
      status: "active",
      verification: "verified",
    });

    await connections.put(
      BUSINESS_ID,
      connection({ health: { status: "action_required", checkedAt: CAPTURED_AT } })
    );
    await expect(
      publications.quarantineInvalidConnection({
        businessId: BUSINESS_ID,
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: CONNECTION_ID,
        deletedRevisionPrefix: "invalid:current",
        deletedAt: CAPTURED_AT,
      })
    ).resolves.toEqual([publishedSource.sourceId]);
    await expect(publications.find(BUSINESS_ID, publishedSource.sourceId)).resolves.toMatchObject({
      status: "deleted",
      verification: "unverifiable",
    });
  });

  it("does not fence a future Connection when the observed Connection no longer exists", async () => {
    database = await makeMigratedPglite();
    const transactions = transactionPort(database);
    const publications = new OimKnowledgePublicationStore(transactions);

    await expect(
      publications.quarantineInvalidConnection({
        businessId: BUSINESS_ID,
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: CONNECTION_ID,
        deletedRevisionPrefix: "invalid:missing",
        deletedAt: CAPTURED_AT,
      })
    ).resolves.toBeNull();

    await new ConnectionStore(transactions).put(BUSINESS_ID, connection());
    await new ConnectionExternalIdentityStore(transactions).bindVerified({
      businessId: BUSINESS_ID,
      connectionId: CONNECTION_ID,
      integrationId: "wiki",
      integrationMajorVersion: 2,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofKind: "auth",
      proofDigest: "a".repeat(64),
      verifiedAt: CAPTURED_AT,
      verifiedBy: "provider-auth",
    });
    await expect(
      publications.claimConnection({
        businessId: BUSINESS_ID,
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: CONNECTION_ID,
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
      })
    ).resolves.toMatchObject({ connectionGeneration: 1 });
  });

  it("preserves a healthy publication when a stale invalid-Connection sync resumes", async () => {
    database = await makeMigratedPglite();
    const transactions = transactionPort(database);
    const connections = new ConnectionStore(transactions);
    const connectionIdentities = new ConnectionExternalIdentityStore(transactions);
    const publications = new OimKnowledgePublicationStore(transactions);
    const checkpoints = new OimKnowledgeCheckpointStore(transactions);
    await connections.put(
      BUSINESS_ID,
      connection({ health: { status: "action_required", checkedAt: CAPTURED_AT } })
    );
    await connectionIdentities.bindVerified({
      businessId: BUSINESS_ID,
      connectionId: CONNECTION_ID,
      integrationId: "wiki",
      integrationMajorVersion: 2,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofKind: "auth",
      proofDigest: "a".repeat(64),
      verifiedAt: CAPTURED_AT,
      verifiedBy: "provider-auth",
    });

    let markIdentityRead = () => {};
    let resumeIdentity = () => {};
    const identityRead = new Promise<void>((resolve) => {
      markIdentityRead = resolve;
    });
    const identityResume = new Promise<void>((resolve) => {
      resumeIdentity = resolve;
    });
    let id = 0;
    const baseDeps: OimKnowledgeSyncDeps = {
      api: {
        connection: {
          businessId: BUSINESS_ID,
          integrationId: "wiki",
          integrationMajorVersion: 2,
          connectionId: CONNECTION_ID,
          externalTenantId: "tenant-1",
          externalAccountId: "account-1",
        },
        async execute({ operationId }) {
          if (operationId === "acl") {
            return { body: { readers: [{ id: "provider-user-1" }] } };
          }
          if (operationId === "list") {
            return { body: { items: [{ id: "page-1", revision: "provider-revision-1" }] } };
          }
          return {
            body: { content: "healthy replacement content", revision: "provider-revision-1" },
          };
        },
      },
      checkpoints,
      publications,
      connections,
      connectionIdentities,
      identity: {
        async resolve() {
          return { principals: [{ kind: "user", id: "user-1" }], incomplete: false };
        },
      },
      now: () => new Date(),
      newId: () => {
        id += 1;
        return `sync-id-${id}`;
      },
    };
    const options = {
      businessId: BUSINESS_ID,
      integrationSlug: "wiki-install",
      connectionId: CONNECTION_ID,
      sourceKindId: "page",
      scopes: ["space-race"],
    };
    const staleSync = syncOimKnowledge(
      syncPlan(),
      {
        ...baseDeps,
        connectionIdentities: {
          async find(businessId, connectionId) {
            const identity = await connectionIdentities.find(businessId, connectionId);
            markIdentityRead();
            await identityResume;
            return identity;
          },
        },
      },
      options
    );
    await identityRead;

    await connections.put(BUSINESS_ID, connection());
    await expect(syncOimKnowledge(syncPlan(), baseDeps, options)).resolves.toMatchObject({
      published: 1,
      failures: [],
    });
    const completedByReplacement = await checkpoints.load({
      businessId: BUSINESS_ID,
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: CONNECTION_ID,
      sourceKind: "page",
      scope: "space-race",
    });
    const sourceAfterReplacement = await new PgKnowledgeSourceStore(database).get(
      BUSINESS_ID,
      `wiki:${CONNECTION_ID}/page-1`
    );
    const chunksAfterReplacement = await database.query(
      `SELECT chunk_id, content, revision
         FROM knowledge_source_chunks
        WHERE business_id = $1 AND source_id = $2
        ORDER BY chunk_id`,
      [BUSINESS_ID, `wiki:${CONNECTION_ID}/page-1`]
    );

    resumeIdentity();
    await expect(staleSync).resolves.toMatchObject({
      published: 0,
      quarantined: 0,
      failures: [{ code: "connection_conflict", scope: "space-race" }],
    });
    expect(
      await checkpoints.load({
        businessId: BUSINESS_ID,
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: CONNECTION_ID,
        sourceKind: "page",
        scope: "space-race",
      })
    ).toEqual(completedByReplacement);
    expect(
      await new PgKnowledgeSourceStore(database).get(BUSINESS_ID, `wiki:${CONNECTION_ID}/page-1`)
    ).toEqual(sourceAfterReplacement);
    expect(
      await database.query(
        `SELECT chunk_id, content, revision
           FROM knowledge_source_chunks
          WHERE business_id = $1 AND source_id = $2
          ORDER BY chunk_id`,
        [BUSINESS_ID, `wiki:${CONNECTION_ID}/page-1`]
      )
    ).toEqual(chunksAfterReplacement);
  });
});
