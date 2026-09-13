import type { PGlite } from "@electric-sql/pglite";
import { authorizeSynthesis, type RetrievalRequest, retrieve } from "@tulipfarm/knowledge";
import type { OimConnection } from "@tulipfarm/schema";
import {
  type CachePort,
  ConnectionExternalIdentityStore,
  ConnectionStore,
  OimKnowledgeCheckpointStore,
  type OimKnowledgePublicationClaim,
  OimKnowledgePublicationStore,
  type OimKnowledgeSourcePublication,
  transactionPort,
} from "@tulipfarm/storage";
import { afterEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { PgKnowledgeIndexStore } from "./index-store";
import { PgKnowledgeSourceStore } from "./source-store";

const NOW = new Date("2026-09-13T10:00:00.000Z");

function connection(id: string, overrides: Partial<OimConnection> = {}): OimConnection {
  return {
    id,
    integration: { id: "wiki", majorVersion: 2 },
    label: id,
    owner: { scope: "organization" },
    status: "active",
    isDefault: false,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {},
    health: { status: "healthy", checkedAt: NOW.toISOString() },
    expiresAt: null,
    ...overrides,
  };
}

function source(
  connectionId: string,
  itemId: string,
  overrides: Partial<OimKnowledgeSourcePublication> = {}
): OimKnowledgeSourcePublication {
  return {
    businessId: "business-1",
    sourceId: `wiki:${connectionId}/${itemId}`,
    integrationId: "wiki",
    integrationMajorVersion: 2,
    provider: "wiki",
    externalId: itemId,
    externalTenantId: connectionId === "connection-1" ? "tenant-1" : "tenant-2",
    ownerExternalId: connectionId === "connection-1" ? "account-1" : "account-2",
    sourceLocator: {
      kind: "oim",
      integrationSlug: "wiki-install",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId,
      externalTenantId: connectionId === "connection-1" ? "tenant-1" : "tenant-2",
      externalAccountId: connectionId === "connection-1" ? "account-1" : "account-2",
      sourceKindId: "page",
      scope: "space-1",
      itemId,
    },
    revision: "1",
    classification: ["internal"],
    verification: "verified",
    accessControlMode: "snapshot",
    accessControlMaximumAgeSeconds: 300,
    aclRevision: "acl-1",
    aclCapturedAt: NOW.toISOString(),
    aclPrincipals: [{ kind: "user", id: "user-1" }],
    provenanceCapturedAt: NOW.toISOString(),
    provenanceContentHash: "a".repeat(64),
    provenanceCheckpoint: "scan-1",
    provenanceConnectionId: connectionId,
    lastSyncedAt: NOW.toISOString(),
    ...overrides,
  };
}

class MemoryCache implements CachePort {
  readonly entries = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.entries.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.entries.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

const request: RetrievalRequest = {
  businessId: "business-1",
  principalId: "user-1",
  principals: [{ kind: "user", id: "user-1" }],
  query: "secret",
  limit: 5,
  guardrailEpoch: "g1",
  contextEpoch: "c1",
  correlationId: "corr-1",
};

async function claimPublication(
  transactions: ReturnType<typeof transactionPort>,
  connectionId: string,
  scanId = `scan-${connectionId}`
): Promise<OimKnowledgePublicationClaim> {
  const externalTenantId = connectionId === "connection-1" ? "tenant-1" : "tenant-2";
  const externalAccountId = connectionId === "connection-1" ? "account-1" : "account-2";
  await new ConnectionExternalIdentityStore(transactions).bindVerified({
    businessId: "business-1",
    connectionId,
    integrationId: "wiki",
    integrationMajorVersion: 2,
    externalTenantId,
    externalAccountId,
    proofKind: "auth",
    proofDigest: "a".repeat(64),
    verifiedAt: NOW.toISOString(),
    verifiedBy: "provider-auth",
  });
  const checkpoint = await new OimKnowledgeCheckpointStore(transactions).claim(
    {
      businessId: "business-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId,
      sourceKind: "page",
      scope: "space-1",
    },
    scanId,
    `lease-${scanId}`,
    300,
    new Date(Date.now() + 60_000)
  );
  if (checkpoint === null || checkpoint.scanId === null || checkpoint.leaseToken === null) {
    throw new Error("expected publication checkpoint claim");
  }
  const connectionClaim = await new OimKnowledgePublicationStore(transactions).claimConnection({
    businessId: "business-1",
    integrationId: "wiki",
    integrationMajorVersion: 2,
    connectionId,
    externalTenantId,
    externalAccountId,
  });
  if (connectionClaim === null) throw new Error("expected Connection publication claim");
  return {
    ...connectionClaim,
    sourceKindId: "page",
    scope: "space-1",
    scanId: checkpoint.scanId,
    leaseToken: checkpoint.leaseToken,
    checkpointRevision: checkpoint.revision,
  };
}

function chunks(itemId: string, revision = "1", content = "secret handbook") {
  return [
    {
      chunkId: `wiki:connection-1/${itemId}#content`,
      revision,
      classification: ["internal"],
      digest: "a".repeat(64),
      content,
    },
  ];
}

describe("OIM Knowledge publication persistence", () => {
  let database: PGlite | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("quarantines only the exact Connection scope and removes its chunks atomically", async () => {
    database = await makeMigratedPglite();
    const transactions = transactionPort(database);
    const connections = new ConnectionStore(transactions);
    const publications = new OimKnowledgePublicationStore(transactions);
    await connections.put("business-1", connection("connection-1"));
    await connections.put("business-1", connection("connection-2"));
    const claim1 = await claimPublication(transactions, "connection-1");
    const claim2 = await claimPublication(transactions, "connection-2");
    await expect(
      publications.publish({
        claim: undefined as never,
        source: source("connection-1", "missing-claim"),
        chunks: [],
      })
    ).rejects.toThrow("invalid_oim_knowledge_publication");
    await expect(
      publications.publish({
        claim: claim1,
        source: source("connection-1", "invalid", { sourceLocator: { kind: "legacy" } }),
        chunks: [],
      })
    ).rejects.toThrow("invalid_oim_knowledge_publication");
    await publications.publish({
      claim: claim1,
      source: source("connection-1", "page-1"),
      chunks: [
        {
          chunkId: "wiki:connection-1/page-1#content",
          revision: "1",
          classification: ["internal"],
          digest: "a".repeat(64),
          content: "tenant one secret",
        },
      ],
    });
    await publications.publish({
      claim: claim2,
      source: source("connection-2", "page-1"),
      chunks: [
        {
          chunkId: "wiki:connection-2/page-1#content",
          revision: "1",
          classification: ["internal"],
          digest: "b".repeat(64),
          content: "tenant two secret",
        },
      ],
    });
    const sourceStore = new PgKnowledgeSourceStore(database);
    const loaded = await sourceStore.get("business-1", "wiki:connection-1/page-1");
    if (loaded === undefined) throw new Error("expected published OIM source");
    expect(loaded.sourceLocator).toEqual(source("connection-1", "page-1").sourceLocator);
    const { sourceLocator, ...withoutLocator } = loaded;
    expect(sourceLocator?.kind).toBe("oim");
    await expect(
      sourceStore.put({ ...withoutLocator, revision: "unsafe-non-atomic-revision" })
    ).rejects.toThrow("oim_knowledge_requires_atomic_publication");

    await expect(
      publications.quarantineScope({
        claim: claim1,
        businessId: "business-1",
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
        sourceKindId: "page",
        scope: "space-1",
        quarantinedRevisionPrefix: "quarantine:scan-2",
        quarantinedAt: NOW.toISOString(),
      })
    ).resolves.toEqual(["wiki:connection-1/page-1"]);

    const rows = await database.query<{
      source_id: string;
      verification: string;
      chunks: number;
    }>(`
      SELECT source.source_id, source.verification, count(chunk.chunk_id)::int AS chunks
        FROM knowledge_source_records source
        LEFT JOIN knowledge_source_chunks chunk
          ON chunk.business_id = source.business_id AND chunk.source_id = source.source_id
       WHERE source.business_id = 'business-1'
       GROUP BY source.source_id, source.verification
       ORDER BY source.source_id
    `);
    expect(rows.rows).toEqual([
      { source_id: "wiki:connection-1/page-1", verification: "unverifiable", chunks: 0 },
      { source_id: "wiki:connection-2/page-1", verification: "verified", chunks: 1 },
    ]);
  });

  it("denies cached retrieval and citation immediately after an atomic tombstone", async () => {
    database = await makeMigratedPglite();
    const transactions = transactionPort(database);
    await new ConnectionStore(transactions).put("business-1", connection("connection-1"));
    const publications = new OimKnowledgePublicationStore(transactions);
    const claim = await claimPublication(transactions, "connection-1");
    const published = source("connection-1", "page-1");
    await publications.publish({
      claim,
      source: published,
      chunks: [
        {
          chunkId: "wiki:connection-1/page-1#content",
          revision: "1",
          classification: ["internal"],
          digest: "a".repeat(64),
          content: "secret handbook",
        },
      ],
    });
    const sources = new PgKnowledgeSourceStore(database);
    const index = new PgKnowledgeIndexStore(database, {
      isAvailable: () => false,
      embedMany: async () => ({ embeddings: [], dimension: 0 }),
      getActive: () => null,
      getDimension: () => null,
      pendingReindex: () => false,
      clearPendingReindex: () => {},
    });
    const cache = new MemoryCache();
    const first = await retrieve({ sources, index, cache, now: () => NOW }, request);
    expect(first.candidates).toHaveLength(1);
    expect(
      await authorizeSynthesis(
        { sources },
        {
          businessId: "business-1",
          principals: request.principals,
          citations: first.candidates.map(({ citation }) => citation),
        },
        NOW
      )
    ).toMatchObject({ allowed: true });

    await expect(
      publications.markDeleted({
        claim,
        businessId: "business-1",
        sourceId: published.sourceId,
        expectedRevision: "1",
        deletedRevision: "deleted:scan-2",
        deletedAt: NOW.toISOString(),
      })
    ).resolves.toBe(true);

    const after = await retrieve({ sources, index, cache, now: () => NOW }, request);
    expect(after).toMatchObject({ candidates: [], fromCache: false });
    expect(cache.entries.size).toBe(1);
    expect(
      await authorizeSynthesis(
        { sources },
        {
          businessId: "business-1",
          principals: request.principals,
          citations: first.candidates.map(({ citation }) => citation),
        },
        NOW
      )
    ).toEqual({ allowed: false, reason: "source_deleted" });
  });

  it("tombstones an exact Connection and clears its durable checkpoints", async () => {
    database = await makeMigratedPglite();
    const transactions = transactionPort(database);
    const connections = new ConnectionStore(transactions);
    const publications = new OimKnowledgePublicationStore(transactions);
    const checkpoints = new OimKnowledgeCheckpointStore(transactions);
    await connections.put("business-1", connection("connection-1"));
    await connections.put("business-1", connection("connection-2"));
    const claim1 = await claimPublication(transactions, "connection-1");
    const claim2 = await claimPublication(transactions, "connection-2");
    await publications.publish({
      claim: claim1,
      source: source("connection-1", "page-1"),
      chunks: [
        {
          chunkId: "wiki:connection-1/page-1#content",
          revision: "1",
          classification: ["internal"],
          digest: "a".repeat(64),
          content: "tenant one secret",
        },
      ],
    });
    await publications.publish({
      claim: claim2,
      source: source("connection-2", "page-1"),
      chunks: [
        {
          chunkId: "wiki:connection-2/page-1#content",
          revision: "1",
          classification: ["internal"],
          digest: "b".repeat(64),
          content: "tenant two secret",
        },
      ],
    });
    const key = {
      businessId: "business-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      sourceKind: "page",
      scope: "space-1",
    };
    await expect(
      publications.tombstoneConnection({
        businessId: "business-1",
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
        deletedRevisionPrefix: "deleted:uninstall-1",
        deletedAt: NOW.toISOString(),
      })
    ).resolves.toEqual(["wiki:connection-1/page-1"]);
    await expect(
      checkpoints.clearConnection({
        businessId: "business-1",
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
      })
    ).resolves.toBe(1);

    await expect(checkpoints.load(key)).resolves.toMatchObject({
      baselineItemIds: [],
      scanId: null,
      leaseToken: null,
    });
    const rows = await database.query<{
      source_id: string;
      status: string;
      chunks: number;
    }>(`
      SELECT source.source_id, source.status, count(chunk.chunk_id)::int AS chunks
        FROM knowledge_source_records source
        LEFT JOIN knowledge_source_chunks chunk
          ON chunk.business_id = source.business_id AND chunk.source_id = source.source_id
       WHERE source.business_id = 'business-1'
       GROUP BY source.source_id, source.status
       ORDER BY source.source_id
    `);
    expect(rows.rows).toEqual([
      { source_id: "wiki:connection-1/page-1", status: "deleted", chunks: 0 },
      { source_id: "wiki:connection-2/page-1", status: "active", chunks: 1 },
    ]);
  });

  it("rejects paused new and existing publication after Connection revocation", async () => {
    database = await makeMigratedPglite();
    const transactions = transactionPort(database);
    const connections = new ConnectionStore(transactions);
    const publications = new OimKnowledgePublicationStore(transactions);
    await connections.put("business-1", connection("connection-1"));
    const initialClaim = await claimPublication(transactions, "connection-1");
    const checkpointKey = {
      businessId: "business-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      sourceKind: "page",
      scope: "space-1",
    };
    const staged = await new OimKnowledgeCheckpointStore(transactions).appendPage(
      checkpointKey,
      initialClaim.leaseToken,
      initialClaim.checkpointRevision,
      "page-2",
      ["page-1"],
      new Date(Date.now() + 60_000),
      "watermark-old"
    );
    if (staged === null) throw new Error("expected staged scope checkpoint");
    const pausedClaim = {
      ...initialClaim,
      checkpointRevision: staged.revision,
    };
    const published = source("connection-1", "page-1");
    await expect(
      publications.publish({ claim: pausedClaim, source: published, chunks: chunks("page-1") })
    ).resolves.toBe(true);

    const sources = new PgKnowledgeSourceStore(database);
    const index = new PgKnowledgeIndexStore(database, {
      isAvailable: () => false,
      embedMany: async () => ({ embeddings: [], dimension: 0 }),
      getActive: () => null,
      getDimension: () => null,
      pendingReindex: () => false,
      clearPendingReindex: () => {},
    });
    const cache = new MemoryCache();
    const before = await retrieve({ sources, index, cache, now: () => NOW }, request);
    expect(before.candidates).toHaveLength(1);

    await connections.put("business-1", connection("connection-1", { status: "revoked" }));

    await expect(
      publications.publish({
        claim: pausedClaim,
        source: source("connection-1", "never-seen"),
        chunks: chunks("never-seen"),
      })
    ).resolves.toBe(false);
    await expect(
      new OimKnowledgeCheckpointStore(transactions).load(checkpointKey)
    ).resolves.toMatchObject({
      scanId: null,
      continuation: null,
      accumulatedSeenItemIds: [],
      pendingDeletionItemIds: [],
      cursorWatermark: null,
      pendingCursorWatermark: null,
      leaseToken: null,
    });
    await expect(
      publications.publish({
        expectedRevision: "1",
        claim: pausedClaim,
        source: source("connection-1", "page-1", { revision: "2" }),
        chunks: chunks("page-1", "2", "resurrected secret"),
      })
    ).resolves.toBe(false);

    await expect(
      retrieve({ sources, index, cache, now: () => NOW }, request)
    ).resolves.toMatchObject({ candidates: [], fromCache: false });
    await expect(
      authorizeSynthesis(
        { sources },
        {
          businessId: "business-1",
          principals: request.principals,
          citations: before.candidates.map(({ citation }) => citation),
        },
        NOW
      )
    ).resolves.toEqual({ allowed: false, reason: "source_deleted" });
    await expect(
      database.query(
        `SELECT 1 FROM knowledge_source_chunks
          WHERE business_id = 'business-1'
            AND source_id IN ('wiki:connection-1/page-1', 'wiki:connection-1/never-seen')`
      )
    ).resolves.toMatchObject({ rows: [] });
  });

  it("rejects paused publication after teardown and allows only explicit next-generation recovery", async () => {
    database = await makeMigratedPglite();
    const transactions = transactionPort(database);
    const connections = new ConnectionStore(transactions);
    const publications = new OimKnowledgePublicationStore(transactions);
    await connections.put("business-1", connection("connection-1"));
    const initialClaim = await claimPublication(transactions, "connection-1");
    const checkpointKey = {
      businessId: "business-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      sourceKind: "page",
      scope: "space-1",
    };
    const staged = await new OimKnowledgeCheckpointStore(transactions).appendPage(
      checkpointKey,
      initialClaim.leaseToken,
      initialClaim.checkpointRevision,
      "page-2",
      ["page-1"],
      new Date(Date.now() + 60_000),
      "watermark-old"
    );
    if (staged === null) throw new Error("expected staged scope checkpoint");
    const pausedClaim = { ...initialClaim, checkpointRevision: staged.revision };

    await publications.tombstoneConnection({
      businessId: "business-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      deletedRevisionPrefix: "deleted:teardown-1",
      deletedAt: NOW.toISOString(),
    });
    await expect(
      publications.publish({
        claim: pausedClaim,
        source: source("connection-1", "never-seen"),
        chunks: chunks("never-seen"),
      })
    ).resolves.toBe(false);
    await expect(
      new OimKnowledgeCheckpointStore(transactions).load(checkpointKey)
    ).resolves.toMatchObject({
      scanId: null,
      continuation: null,
      accumulatedSeenItemIds: [],
      pendingDeletionItemIds: [],
      cursorWatermark: null,
      pendingCursorWatermark: null,
      leaseToken: null,
    });
    await expect(
      publications.claimConnection({
        businessId: "business-1",
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
      })
    ).resolves.toBeNull();

    const recoveredConnection = await publications.activateConnection({
      businessId: "business-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
    });
    expect(recoveredConnection?.connectionGeneration).toBeGreaterThan(
      pausedClaim.connectionGeneration
    );
    const recoveredCheckpoint = await new OimKnowledgeCheckpointStore(transactions).claim(
      {
        businessId: "business-1",
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
        sourceKind: "page",
        scope: "space-1",
      },
      "scan-connection-1",
      "lease-recovered",
      300,
      new Date(Date.now() + 60_000)
    );
    if (
      recoveredConnection === null ||
      recoveredCheckpoint === null ||
      recoveredCheckpoint.scanId === null ||
      recoveredCheckpoint.leaseToken === null
    ) {
      throw new Error("expected explicit publication recovery");
    }
    await expect(
      publications.publish({
        claim: {
          ...recoveredConnection,
          sourceKindId: "page",
          scope: "space-1",
          scanId: recoveredCheckpoint.scanId,
          leaseToken: recoveredCheckpoint.leaseToken,
          checkpointRevision: recoveredCheckpoint.revision,
        },
        source: source("connection-1", "recovered"),
        chunks: chunks("recovered"),
      })
    ).resolves.toBe(true);
  });

  it("does not let a recreated Connection cross the durable tenant and account fence", async () => {
    database = await makeMigratedPglite();
    const transactions = transactionPort(database);
    const connections = new ConnectionStore(transactions);
    const publications = new OimKnowledgePublicationStore(transactions);
    await connections.put("business-1", connection("connection-1"));
    const staleClaim = await claimPublication(transactions, "connection-1");
    await publications.tombstoneConnection({
      businessId: "business-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      deletedRevisionPrefix: "deleted:teardown-1",
      deletedAt: NOW.toISOString(),
    });

    await database.query("DELETE FROM connections WHERE business_id = $1 AND id = $2", [
      "business-1",
      "connection-1",
    ]);
    await connections.put("business-1", connection("connection-1"));
    await new ConnectionExternalIdentityStore(transactions).bindVerified({
      businessId: "business-1",
      connectionId: "connection-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      externalTenantId: "tenant-other",
      externalAccountId: "account-other",
      proofKind: "auth",
      proofDigest: "b".repeat(64),
      verifiedAt: NOW.toISOString(),
      verifiedBy: "provider-auth",
    });

    await expect(
      publications.activateConnection({
        businessId: "business-1",
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
        externalTenantId: "tenant-other",
        externalAccountId: "account-other",
      })
    ).resolves.toBeNull();
    await expect(
      publications.quarantineInvalidConnection({
        businessId: "business-1",
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
        deletedRevisionPrefix: "invalid:stale-identity",
        deletedAt: NOW.toISOString(),
      })
    ).resolves.toBeNull();
    await expect(
      publications.quarantineScope({
        claim: staleClaim,
        businessId: "business-1",
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
        sourceKindId: "page",
        scope: "space-1",
        quarantinedRevisionPrefix: "quarantine:recreated-connection",
        quarantinedAt: NOW.toISOString(),
      })
    ).resolves.toBeNull();
  });

  it("rejects a paused scope claim, stale lifecycle generation, and mismatched identity", async () => {
    database = await makeMigratedPglite();
    const transactions = transactionPort(database);
    const connections = new ConnectionStore(transactions);
    const publications = new OimKnowledgePublicationStore(transactions);
    await connections.put("business-1", connection("connection-1"));
    const initialClaim = await claimPublication(transactions, "connection-1");
    const checkpointKey = {
      businessId: "business-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      sourceKind: "page",
      scope: "space-1",
    };
    const staged = await new OimKnowledgeCheckpointStore(transactions).appendPage(
      checkpointKey,
      initialClaim.leaseToken,
      initialClaim.checkpointRevision,
      "page-2",
      ["page-1"],
      new Date(Date.now() + 60_000),
      "watermark-old"
    );
    if (staged === null) throw new Error("expected staged scope checkpoint");
    const deletionStaged = await new OimKnowledgeCheckpointStore(transactions).stageCompletion(
      checkpointKey,
      initialClaim.leaseToken,
      staged.revision,
      ["removed"],
      new Date(Date.now() + 60_000)
    );
    if (deletionStaged === null) throw new Error("expected pending deletion obligation");
    const pausedClaim = { ...initialClaim, checkpointRevision: deletionStaged.revision };

    await publications.quarantineScope({
      claim: pausedClaim,
      businessId: "business-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      sourceKindId: "page",
      scope: "space-1",
      quarantinedRevisionPrefix: "quarantine:scope-1",
      quarantinedAt: NOW.toISOString(),
    });
    await expect(
      publications.publish({
        claim: pausedClaim,
        source: source("connection-1", "after-quarantine"),
        chunks: chunks("after-quarantine"),
      })
    ).resolves.toBe(false);
    const rebuildCheckpoint = await new OimKnowledgeCheckpointStore(transactions).load(
      checkpointKey
    );
    expect(rebuildCheckpoint).toMatchObject({
      scanId: "scan-connection-1",
      continuation: null,
      accumulatedSeenItemIds: [],
      pendingDeletionItemIds: ["removed"],
      cursorWatermark: null,
      pendingCursorWatermark: null,
      requiresFullRebuild: true,
      leaseToken: null,
    });
    if (rebuildCheckpoint === null || rebuildCheckpoint.scanId === null) {
      throw new Error("expected durable scope rebuild");
    }

    const recoveredScopeClaim = await claimPublication(
      transactions,
      "connection-1",
      rebuildCheckpoint.scanId
    );
    await expect(
      publications.publish({
        claim: recoveredScopeClaim,
        source: source("connection-1", "after-quarantine"),
        chunks: chunks("after-quarantine"),
      })
    ).resolves.toBe(true);
    await expect(
      publications.markDeleted({
        claim: pausedClaim,
        businessId: "business-1",
        sourceId: "wiki:connection-1/after-quarantine",
        expectedRevision: "1",
        deletedRevision: "deleted:stale-worker",
        deletedAt: NOW.toISOString(),
      })
    ).resolves.toBe(false);
    await expect(
      publications.quarantineSource({
        claim: pausedClaim,
        businessId: "business-1",
        sourceId: "wiki:connection-1/after-quarantine",
        expectedRevision: "1",
        quarantinedRevision: "quarantine:stale-worker",
        quarantinedAt: NOW.toISOString(),
      })
    ).resolves.toBe(false);
    await expect(
      publications.find("business-1", "wiki:connection-1/after-quarantine")
    ).resolves.toMatchObject({ status: "active", verification: "verified", revision: "1" });
    await expect(
      database.query(
        `SELECT chunk_id FROM knowledge_source_chunks
          WHERE business_id = 'business-1'
            AND source_id = 'wiki:connection-1/after-quarantine'`
      )
    ).resolves.toMatchObject({
      rows: [{ chunk_id: "wiki:connection-1/after-quarantine#content" }],
    });

    await connections.put(
      "business-1",
      connection("connection-1", {
        health: { status: "unknown", checkedAt: NOW.toISOString() },
      })
    );
    await expect(
      publications.publish({
        claim: recoveredScopeClaim,
        source: source("connection-1", "stale-generation"),
        chunks: chunks("stale-generation"),
      })
    ).resolves.toBe(false);

    const freshConnection = await publications.claimConnection({
      businessId: "business-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
    });
    if (freshConnection === null) throw new Error("expected fresh Connection generation");
    expect(freshConnection.connectionGeneration).toBeGreaterThan(
      recoveredScopeClaim.connectionGeneration
    );
    await expect(
      publications.publish({
        claim: {
          ...recoveredScopeClaim,
          ...freshConnection,
          externalTenantId: "tenant-other",
          externalAccountId: "account-other",
        },
        source: source("connection-1", "wrong-identity", {
          externalTenantId: "tenant-other",
          ownerExternalId: "account-other",
          sourceLocator: {
            ...source("connection-1", "wrong-identity").sourceLocator,
            externalTenantId: "tenant-other",
            externalAccountId: "account-other",
          },
        }),
        chunks: chunks("wrong-identity"),
      })
    ).resolves.toBe(false);
  });

  it("fences a stale pending-deletion worker after lease loss and provider revision reuse", async () => {
    database = await makeMigratedPglite();
    const transactions = transactionPort(database);
    const connections = new ConnectionStore(transactions);
    const publications = new OimKnowledgePublicationStore(transactions);
    const checkpoints = new OimKnowledgeCheckpointStore(transactions);
    await connections.put("business-1", connection("connection-1"));
    const firstClaim = await claimPublication(transactions, "connection-1");
    const published = source("connection-1", "page-1");
    await publications.publish({
      claim: firstClaim,
      source: published,
      chunks: chunks("page-1", "1", "old content"),
    });
    const key = {
      businessId: "business-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      sourceKind: "page",
      scope: "space-1",
    };
    const staged = await checkpoints.stageCompletion(
      key,
      firstClaim.leaseToken,
      firstClaim.checkpointRevision,
      ["page-1"],
      new Date(Date.now() + 60_000)
    );
    if (staged === null) throw new Error("expected staged deletion");
    const staleDeletionClaim = { ...firstClaim, checkpointRevision: staged.revision };
    const replacementCheckpoint = await checkpoints.claim(
      key,
      staged.scanId ?? "scan-connection-1",
      "lease-replacement",
      300,
      new Date(Date.now() + 400_000)
    );
    const replacementConnection = await publications.claimConnection({
      businessId: "business-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
    });
    if (
      replacementCheckpoint === null ||
      replacementCheckpoint.scanId === null ||
      replacementCheckpoint.leaseToken === null ||
      replacementConnection === null
    ) {
      throw new Error("expected replacement worker claim");
    }
    const replacementClaim: OimKnowledgePublicationClaim = {
      ...replacementConnection,
      sourceKindId: "page",
      scope: "space-1",
      scanId: replacementCheckpoint.scanId,
      leaseToken: replacementCheckpoint.leaseToken,
      checkpointRevision: replacementCheckpoint.revision,
    };
    await expect(
      publications.publish({
        expectedRevision: "1",
        claim: replacementClaim,
        source: published,
        chunks: chunks("page-1", "1", "fresh content with reused provider revision"),
      })
    ).resolves.toBe(true);

    await expect(
      publications.markDeleted({
        claim: staleDeletionClaim,
        businessId: "business-1",
        sourceId: published.sourceId,
        expectedRevision: "1",
        deletedRevision: "deleted:stale-worker",
        deletedAt: NOW.toISOString(),
      })
    ).resolves.toBe(false);
    await expect(
      publications.quarantineSource({
        claim: staleDeletionClaim,
        businessId: "business-1",
        sourceId: published.sourceId,
        expectedRevision: "1",
        quarantinedRevision: "quarantine:stale-worker",
        quarantinedAt: NOW.toISOString(),
      })
    ).resolves.toBe(false);
    await expect(checkpoints.load(key)).resolves.toMatchObject({
      pendingDeletionItemIds: ["page-1"],
      leaseToken: "lease-replacement",
    });
    await expect(
      database.query<{ content: string }>(
        `SELECT content FROM knowledge_source_chunks
          WHERE business_id = $1 AND source_id = $2`,
        ["business-1", published.sourceId]
      )
    ).resolves.toMatchObject({
      rows: [{ content: "fresh content with reused provider revision" }],
    });
  });

  it("fences late scope ACL quarantine after a replacement worker completes", async () => {
    database = await makeMigratedPglite();
    const transactions = transactionPort(database);
    const connections = new ConnectionStore(transactions);
    const publications = new OimKnowledgePublicationStore(transactions);
    const checkpoints = new OimKnowledgeCheckpointStore(transactions);
    await connections.put("business-1", connection("connection-1"));
    const staleClaim = await claimPublication(transactions, "connection-1");
    await publications.publish({
      claim: staleClaim,
      source: source("connection-1", "page-1"),
      chunks: chunks("page-1", "1", "old content"),
    });
    const key = {
      businessId: "business-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      sourceKind: "page",
      scope: "space-1",
    };
    const replacementCheckpoint = await checkpoints.claim(
      key,
      staleClaim.scanId,
      "lease-replacement",
      300,
      new Date(Date.now() + 400_000)
    );
    const replacementConnection = await publications.claimConnection({
      businessId: "business-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
    });
    if (
      replacementCheckpoint === null ||
      replacementCheckpoint.scanId === null ||
      replacementCheckpoint.leaseToken === null ||
      replacementConnection === null
    ) {
      throw new Error("expected replacement scope claim");
    }
    const replacementClaim: OimKnowledgePublicationClaim = {
      ...replacementConnection,
      sourceKindId: "page",
      scope: "space-1",
      scanId: replacementCheckpoint.scanId,
      leaseToken: replacementCheckpoint.leaseToken,
      checkpointRevision: replacementCheckpoint.revision,
    };
    await publications.publish({
      expectedRevision: "1",
      claim: replacementClaim,
      source: source("connection-1", "page-1", { revision: "2" }),
      chunks: chunks("page-1", "2", "fresh content"),
    });
    const replacementPage = await checkpoints.appendPage(
      key,
      replacementClaim.leaseToken,
      replacementClaim.checkpointRevision,
      null,
      ["page-1"],
      new Date(Date.now() + 400_000)
    );
    if (replacementPage === null) throw new Error("expected replacement page");
    const completed = await checkpoints.complete(
      key,
      replacementClaim.leaseToken,
      replacementPage.revision,
      new Date(Date.now() + 400_000),
      "full"
    );
    if (completed === null) throw new Error("expected replacement completion");

    const staleQuarantine = {
      claim: staleClaim,
      businessId: "business-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      sourceKindId: "page",
      scope: "space-1",
      quarantinedRevisionPrefix: "quarantine:stale-worker",
      quarantinedAt: NOW.toISOString(),
    };
    await expect(publications.quarantineScope(staleQuarantine)).resolves.toBeNull();
    await expect(
      publications.quarantineScope({
        ...staleQuarantine,
        claim: {
          ...replacementClaim,
          externalTenantId: "tenant-other",
          externalAccountId: "account-other",
        },
      })
    ).resolves.toBeNull();
    await expect(
      publications.find("business-1", "wiki:connection-1/page-1")
    ).resolves.toMatchObject({
      status: "active",
      verification: "verified",
      revision: "2",
    });
    await expect(checkpoints.load(key)).resolves.toMatchObject({
      revision: completed.revision,
      baselineItemIds: ["page-1"],
      scanId: null,
      leaseToken: null,
      requiresFullRebuild: false,
    });
    await expect(
      database.query<{ content: string }>(
        `SELECT content FROM knowledge_source_chunks
          WHERE business_id = $1 AND source_id = $2`,
        ["business-1", "wiki:connection-1/page-1"]
      )
    ).resolves.toMatchObject({ rows: [{ content: "fresh content" }] });

    const currentCheckpoint = await checkpoints.claim(
      key,
      "scan-current",
      "lease-current",
      300,
      new Date(Date.now() + 500_000)
    );
    if (
      currentCheckpoint === null ||
      currentCheckpoint.scanId === null ||
      currentCheckpoint.leaseToken === null
    ) {
      throw new Error("expected current scope claim");
    }
    const currentClaim: OimKnowledgePublicationClaim = {
      ...replacementConnection,
      sourceKindId: "page",
      scope: "space-1",
      scanId: currentCheckpoint.scanId,
      leaseToken: currentCheckpoint.leaseToken,
      checkpointRevision: currentCheckpoint.revision,
    };
    await expect(
      publications.quarantineScope({
        ...staleQuarantine,
        claim: currentClaim,
        quarantinedRevisionPrefix: "quarantine:current-acl-failure",
      })
    ).resolves.toEqual(["wiki:connection-1/page-1"]);
    await expect(
      publications.find("business-1", "wiki:connection-1/page-1")
    ).resolves.toMatchObject({
      verification: "unverifiable",
      revision: "quarantine:current-acl-failure:wiki:connection-1/page-1",
    });
  });

  it("retains failed deletions through quarantine and promotes only after rebuilding", async () => {
    database = await makeMigratedPglite();
    const transactions = transactionPort(database);
    const connections = new ConnectionStore(transactions);
    const publications = new OimKnowledgePublicationStore(transactions);
    const checkpoints = new OimKnowledgeCheckpointStore(transactions);
    await connections.put("business-1", connection("connection-1"));
    const initialClaim = await claimPublication(transactions, "connection-1");
    await publications.publish({
      claim: initialClaim,
      source: source("connection-1", "removed"),
      chunks: chunks("removed"),
    });
    await publications.publish({
      claim: initialClaim,
      source: source("connection-1", "unchanged"),
      chunks: chunks("unchanged"),
    });
    const key = {
      businessId: "business-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      sourceKind: "page",
      scope: "space-1",
    };
    const staged = await checkpoints.stageCompletion(
      key,
      initialClaim.leaseToken,
      initialClaim.checkpointRevision,
      ["removed"],
      new Date(Date.now() + 60_000)
    );
    if (staged === null) throw new Error("expected pending deletion");
    const pendingClaim = { ...initialClaim, checkpointRevision: staged.revision };
    await expect(
      publications.markDeleted({
        claim: pendingClaim,
        businessId: "business-1",
        sourceId: "wiki:connection-1/removed",
        expectedRevision: "stale-revision",
        deletedRevision: "deleted:first-attempt",
        deletedAt: NOW.toISOString(),
      })
    ).resolves.toBe(false);

    await expect(
      publications.quarantineScope({
        claim: pendingClaim,
        businessId: "business-1",
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
        sourceKindId: "page",
        scope: "space-1",
        quarantinedRevisionPrefix: "quarantine:scope-reset",
        quarantinedAt: NOW.toISOString(),
      })
    ).resolves.toEqual(["wiki:connection-1/removed", "wiki:connection-1/unchanged"]);
    await expect(checkpoints.load(key)).resolves.toMatchObject({
      pendingDeletionItemIds: ["removed"],
      cursorWatermark: null,
      pendingCursorWatermark: null,
      requiresFullRebuild: true,
      leaseToken: null,
    });

    const rebuildCheckpoint = await checkpoints.claim(
      key,
      staged.scanId ?? initialClaim.scanId,
      "lease-rebuild",
      300,
      new Date(Date.now() + 120_000)
    );
    const connectionClaim = await publications.claimConnection({
      businessId: "business-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
    });
    if (
      rebuildCheckpoint === null ||
      rebuildCheckpoint.scanId === null ||
      rebuildCheckpoint.leaseToken === null ||
      connectionClaim === null
    ) {
      throw new Error("expected rebuild claim");
    }
    const rebuildClaim: OimKnowledgePublicationClaim = {
      ...connectionClaim,
      sourceKindId: "page",
      scope: "space-1",
      scanId: rebuildCheckpoint.scanId,
      leaseToken: rebuildCheckpoint.leaseToken,
      checkpointRevision: rebuildCheckpoint.revision,
    };
    await expect(
      publications.markDeleted({
        claim: rebuildClaim,
        businessId: "business-1",
        sourceId: "wiki:connection-1/removed",
        expectedRevision: "quarantine:scope-reset:wiki:connection-1/removed",
        deletedRevision: "deleted:retry",
        deletedAt: NOW.toISOString(),
      })
    ).resolves.toBe(true);
    const acknowledged = await checkpoints.acknowledgeDeletions(
      key,
      rebuildClaim.leaseToken,
      rebuildClaim.checkpointRevision,
      ["removed"],
      new Date(Date.now() + 120_000)
    );
    if (acknowledged === null) throw new Error("expected deletion acknowledgement");
    const rebuildPublicationClaim = {
      ...rebuildClaim,
      checkpointRevision: acknowledged.revision,
    };
    await expect(
      publications.publish({
        expectedRevision: "quarantine:scope-reset:wiki:connection-1/unchanged",
        claim: rebuildPublicationClaim,
        source: source("connection-1", "unchanged", { revision: "2" }),
        chunks: chunks("unchanged", "2", "rebuilt content"),
      })
    ).resolves.toBe(true);
    const page = await checkpoints.appendPage(
      key,
      rebuildPublicationClaim.leaseToken,
      rebuildPublicationClaim.checkpointRevision,
      null,
      ["unchanged"],
      new Date(Date.now() + 120_000),
      "watermark-rebuilt"
    );
    if (page === null) throw new Error("expected rebuilt page");
    await expect(
      checkpoints.complete(
        key,
        rebuildPublicationClaim.leaseToken,
        page.revision,
        new Date(Date.now() + 120_000),
        "incremental",
        true
      )
    ).resolves.toMatchObject({
      baselineItemIds: ["unchanged"],
      pendingDeletionItemIds: [],
      cursorWatermark: "watermark-rebuilt",
      pendingCursorWatermark: null,
      requiresFullRebuild: false,
      scanId: null,
    });
  });

  it("does not claim a legacy Knowledge source that happens to share an OIM source id", async () => {
    database = await makeMigratedPglite();
    const transactions = transactionPort(database);
    await new ConnectionStore(transactions).put("business-1", connection("connection-1"));
    const claim = await claimPublication(transactions, "connection-1");
    const sources = new PgKnowledgeSourceStore(database);
    await sources.put({
      sourceId: "wiki:connection-1/page-1",
      businessId: "business-1",
      integrationId: "legacy",
      provider: "legacy",
      externalId: "legacy-page",
      externalTenantId: "legacy-tenant",
      ownerExternalId: "legacy-owner",
      revision: "legacy-1",
      classification: ["internal"],
      status: "active",
      verification: "verified",
      accessControl: {
        mode: "snapshot",
        aclRevision: "legacy-acl",
        maximumAgeSeconds: 300,
      },
      acl: {
        aclRevision: "legacy-acl",
        capturedAt: NOW.toISOString(),
        principals: [{ kind: "user", id: "user-1" }],
      },
      provenance: {
        capturedAt: NOW.toISOString(),
        contentHash: "c".repeat(64),
      },
      lastSyncedAt: NOW.toISOString(),
    });

    await expect(
      new OimKnowledgePublicationStore(transactions).publish({
        expectedRevision: "legacy-1",
        claim,
        source: source("connection-1", "page-1"),
        chunks: [
          {
            chunkId: "wiki:connection-1/page-1#content",
            revision: "1",
            classification: ["internal"],
            digest: "a".repeat(64),
            content: "must not replace legacy",
          },
        ],
      })
    ).resolves.toBe(false);
    const publications = new OimKnowledgePublicationStore(transactions);
    await expect(
      publications.quarantineSource({
        claim,
        businessId: "business-1",
        sourceId: "wiki:connection-1/page-1",
        expectedRevision: "legacy-1",
        quarantinedRevision: "quarantine:legacy",
        quarantinedAt: NOW.toISOString(),
      })
    ).resolves.toBe(false);
    await expect(
      publications.markDeleted({
        claim,
        businessId: "business-1",
        sourceId: "wiki:connection-1/page-1",
        expectedRevision: "legacy-1",
        deletedRevision: "deleted:legacy",
        deletedAt: NOW.toISOString(),
      })
    ).resolves.toBe(false);
    await expect(sources.get("business-1", "wiki:connection-1/page-1")).resolves.toMatchObject({
      integrationId: "legacy",
      revision: "legacy-1",
    });
  });
});
