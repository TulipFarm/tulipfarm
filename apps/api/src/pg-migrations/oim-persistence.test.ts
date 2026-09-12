import type { PGlite } from "@electric-sql/pglite";
import type { OimConnection } from "@tulipfarm/schema";
import {
  ConnectionStore,
  OimKnowledgePublicationStore,
  type OimKnowledgeSourcePublication,
  PgIntegrationAuthRequestRepo,
  transactionPort,
  WebhookInboxStore,
} from "@tulipfarm/storage";
import { afterEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { PG_MIGRATIONS } from "./index";

const BUSINESS_ID = "business-1";

function connection(id: string, majorVersion: number): OimConnection {
  return {
    id,
    integration: { id: "calendar", majorVersion },
    label: id,
    owner: { scope: "organization" },
    status: "active",
    isDefault: false,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {},
    health: { status: "unknown", checkedAt: null },
    expiresAt: null,
  };
}

function knowledgeSource(
  overrides: Partial<OimKnowledgeSourcePublication> = {}
): OimKnowledgeSourcePublication {
  return {
    businessId: BUSINESS_ID,
    sourceId: "calendar:event-1",
    integrationId: "calendar",
    integrationMajorVersion: 2,
    provider: "calendar",
    externalId: "event-1",
    externalTenantId: "tenant-1",
    ownerExternalId: "account-1",
    sourceLocator: { kind: "events", scope: "primary" },
    revision: "1",
    classification: ["internal"],
    verification: "verified",
    accessControlMode: "snapshot",
    accessControlMaximumAgeSeconds: 300,
    aclRevision: "acl-1",
    aclCapturedAt: "2026-09-12T09:00:00.000Z",
    aclPrincipals: [{ kind: "user", id: "user-1" }],
    provenanceCapturedAt: "2026-09-12T09:00:00.000Z",
    provenanceContentHash: "source-hash",
    provenanceCheckpoint: "scan-1",
    provenanceConnectionId: "connection-1",
    lastSyncedAt: "2026-09-12T09:00:00.000Z",
    ...overrides,
  };
}

describe("OIM persistence migrations", () => {
  let database: PGlite | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("appends the persistence foundation after main migrations 110 and 111", () => {
    expect(
      PG_MIGRATIONS.filter(({ version }) => version >= 110).map(({ version }) => version)
    ).toEqual([110, 111, 112, 113, 114]);
  });

  it("builds every OIM persistence table on a fresh database", async () => {
    database = await makeMigratedPglite();

    const result = await database.query<{ table_name: string }>(`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           'connections',
           'connection_auth_steps',
           'connection_external_identities',
           'webhook_deliveries',
           'polling_ingress_state',
           'oim_rate_limits',
           'oim_release_trust_roots',
           'oim_release_revocation_state',
           'oim_installed_release_provenance',
           'oim_release_maintenance_config',
           'oim_knowledge_scan_checkpoints'
         )
       ORDER BY table_name
    `);

    expect(result.rows.map(({ table_name }) => table_name)).toHaveLength(11);
  });

  it("allows one provider key on separate Connections and majors, but not the same route", async () => {
    database = await makeMigratedPglite();
    const transactions = transactionPort(database);
    const connections = new ConnectionStore(transactions);
    const inbox = new WebhookInboxStore(transactions);
    await connections.put(BUSINESS_ID, connection("connection-1", 2));
    await connections.put(BUSINESS_ID, connection("connection-2", 2));
    await connections.put(BUSINESS_ID, connection("connection-3", 3));
    const input = {
      integrationId: "calendar",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      deduplicationKey: "event-1",
      bodySha256: "digest",
      safeHeaders: {},
      encryptedBody: "ciphertext",
      eventType: null,
      verification: "verified",
    };

    await expect(inbox.record(BUSINESS_ID, { ...input, id: "delivery-1" })).resolves.toMatchObject({
      accepted: true,
    });
    await expect(
      inbox.record(BUSINESS_ID, { ...input, id: "delivery-2", connectionId: "connection-2" })
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      inbox.record(BUSINESS_ID, {
        ...input,
        id: "delivery-3",
        integrationMajorVersion: 3,
        connectionId: "connection-3",
      })
    ).resolves.toMatchObject({ accepted: true });
    await expect(inbox.record(BUSINESS_ID, { ...input, id: "delivery-4" })).resolves.toMatchObject({
      accepted: false,
      delivery: { id: "delivery-1" },
    });
  });

  it("round-trips exact OIM callback identity in the one-use auth request", async () => {
    database = await makeMigratedPglite();
    const repo = new PgIntegrationAuthRequestRepo(database);
    await repo.create({
      state: "state-1",
      integrationSlug: "calendar",
      stepIndex: 1,
      codeVerifier: "verifier",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      principal: null,
      connectionId: "connection-1",
      oimStepId: "admin-consent",
      oimStepDigest: "step-digest",
      manifestDigest: "manifest-digest",
      packageDigest: "package-digest",
    });

    await expect(repo.findActive("state-1")).resolves.toMatchObject({
      connectionId: "connection-1",
      oimStepId: "admin-consent",
    });
    await expect(repo.consume("state-1")).resolves.toMatchObject({
      connectionId: "connection-1",
      oimStepId: "admin-consent",
      oimStepDigest: "step-digest",
      manifestDigest: "manifest-digest",
      packageDigest: "package-digest",
    });
    await expect(repo.findActive("state-1")).resolves.toBeNull();
    await expect(repo.consume("state-1")).resolves.toBeNull();
  });

  it("publishes one Knowledge revision atomically and tombstones deletion", async () => {
    database = await makeMigratedPglite();
    const transactions = transactionPort(database);
    const store = new OimKnowledgePublicationStore(transactions);
    await new ConnectionStore(transactions).put(BUSINESS_ID, connection("connection-1", 2));
    const source = knowledgeSource();
    await store.publish({
      source,
      chunks: [
        {
          chunkId: "chunk-old",
          revision: "1",
          classification: ["internal"],
          digest: "old-digest",
          content: "old text",
        },
      ],
    });
    await store.publish({
      source: {
        ...source,
        sourceId: "calendar:event-2",
        externalId: "event-2",
        revision: "1",
      },
      chunks: [
        {
          chunkId: "chunk-owned-elsewhere",
          revision: "1",
          classification: ["internal"],
          digest: "other-digest",
          content: "other text",
        },
      ],
    });
    await expect(
      store.publish({
        expectedRevision: "1",
        source: {
          ...source,
          revision: "2",
          aclRevision: "acl-2",
          aclPrincipals: [{ kind: "user", id: "user-2" }],
        },
        chunks: [
          {
            chunkId: "chunk-owned-elsewhere",
            revision: "2",
            classification: ["internal"],
            digest: "new-digest",
            content: "new text",
          },
        ],
      })
    ).rejects.toThrow("belongs to another source");
    const rolledBack = await database.query<{
      revision: string;
      acl_principals: unknown;
      chunk_id: string;
    }>(`
      SELECT source.revision, source.acl_principals, chunk.chunk_id
        FROM knowledge_source_records source
        JOIN knowledge_source_chunks chunk
          ON chunk.business_id = source.business_id AND chunk.source_id = source.source_id
       WHERE source.business_id = '${BUSINESS_ID}' AND source.source_id = 'calendar:event-1'
    `);
    expect(rolledBack.rows).toEqual([
      {
        revision: "1",
        acl_principals: [{ kind: "user", id: "user-1" }],
        chunk_id: "chunk-old",
      },
    ]);
    await expect(
      store.publish({
        expectedRevision: "stale",
        source: {
          ...source,
          revision: "2",
          aclRevision: "acl-2",
          aclPrincipals: [{ kind: "user", id: "user-2" }],
        },
        chunks: [
          {
            chunkId: "chunk-new",
            revision: "2",
            classification: ["internal"],
            digest: "new-digest",
            content: "new text",
          },
        ],
      })
    ).resolves.toBe(false);
    await expect(
      store.publish({
        expectedRevision: "1",
        source: {
          ...source,
          revision: "2",
          aclRevision: "acl-2",
          aclPrincipals: [{ kind: "user", id: "user-2" }],
        },
        chunks: [
          {
            chunkId: "chunk-new",
            revision: "2",
            classification: ["internal"],
            digest: "new-digest",
            content: "new text",
          },
        ],
      })
    ).resolves.toBe(true);

    const published = await database.query<{
      source_revision: string;
      chunk_id: string;
      chunk_revision: string;
      acl_principals: unknown;
    }>(`
      SELECT source.revision AS source_revision,
             chunk.chunk_id,
             chunk.revision AS chunk_revision,
             source.acl_principals
        FROM knowledge_source_records source
        JOIN knowledge_source_chunks chunk
          ON chunk.business_id = source.business_id AND chunk.source_id = source.source_id
       WHERE source.business_id = '${BUSINESS_ID}' AND source.source_id = 'calendar:event-1'
    `);
    expect(published.rows).toEqual([
      {
        source_revision: "2",
        chunk_id: "chunk-new",
        chunk_revision: "2",
        acl_principals: [{ kind: "user", id: "user-2" }],
      },
    ]);

    await expect(
      store.markDeleted({
        businessId: BUSINESS_ID,
        sourceId: "calendar:event-1",
        expectedRevision: "2",
        deletedRevision: "2",
        deletedAt: "2026-09-12T10:00:00.000Z",
      })
    ).rejects.toThrow("invalid_oim_knowledge_deletion");
    await expect(
      store.markDeleted({
        businessId: BUSINESS_ID,
        sourceId: "calendar:event-1",
        expectedRevision: "2",
        deletedRevision: "deleted:scan-2",
        deletedAt: "2026-09-12T10:00:00.000Z",
      })
    ).resolves.toBe(true);
    const deleted = await database.query<{
      status: string;
      revision: string;
      chunks: number;
    }>(`
      SELECT source.status,
             source.revision,
             count(chunk.chunk_id)::int AS chunks
        FROM knowledge_source_records source
        LEFT JOIN knowledge_source_chunks chunk
          ON chunk.business_id = source.business_id AND chunk.source_id = source.source_id
       WHERE source.business_id = '${BUSINESS_ID}' AND source.source_id = 'calendar:event-1'
       GROUP BY source.status, source.revision
    `);
    expect(deleted.rows).toEqual([{ status: "deleted", revision: "deleted:scan-2", chunks: 0 }]);
  });

  it("rejects invalid Knowledge provenance and keeps an existing Connection binding", async () => {
    database = await makeMigratedPglite();
    const transactions = transactionPort(database);
    const connections = new ConnectionStore(transactions);
    const store = new OimKnowledgePublicationStore(transactions);
    await connections.put(BUSINESS_ID, connection("connection-1", 2));
    await connections.put(BUSINESS_ID, connection("connection-2", 2));
    await connections.put(BUSINESS_ID, {
      ...connection("wrong-integration", 2),
      integration: { id: "mail", majorVersion: 2 },
    });
    await connections.put("other-business", connection("other-business-connection", 2));
    const chunk = {
      chunkId: "chunk-1",
      revision: "1",
      classification: ["internal"],
      digest: "digest-1",
      content: "content",
    };

    await expect(
      store.publish({
        source: knowledgeSource({ provenanceConnectionId: "missing" }),
        chunks: [chunk],
      })
    ).rejects.toThrow();
    await expect(
      store.publish({
        source: knowledgeSource({ provenanceConnectionId: "other-business-connection" }),
        chunks: [chunk],
      })
    ).rejects.toThrow();
    await expect(
      store.publish({
        source: knowledgeSource({ provenanceConnectionId: "wrong-integration" }),
        chunks: [chunk],
      })
    ).rejects.toThrow();

    await expect(store.publish({ source: knowledgeSource(), chunks: [chunk] })).resolves.toBe(true);
    await expect(
      store.publish({
        expectedRevision: "1",
        source: knowledgeSource({
          revision: "2",
          provenanceConnectionId: "connection-2",
        }),
        chunks: [{ ...chunk, revision: "2" }],
      })
    ).resolves.toBe(false);
  });
});
