import type { PGlite } from "@electric-sql/pglite";
import type { KnowledgeSourceRecord } from "@tulipfarm/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgKnowledgeSourceStore } from "./source-store";

const BUSINESS = "11111111-1111-1111-1111-111111111111";
const OTHER_BUSINESS = "22222222-2222-2222-2222-222222222222";

function record(overrides: Partial<KnowledgeSourceRecord> = {}): KnowledgeSourceRecord {
  return {
    sourceId: "slack:T1:C1",
    businessId: BUSINESS,
    integrationId: "slack",
    provider: "slack",
    externalId: "C1",
    externalTenantId: "T1",
    ownerExternalId: "U1",
    revision: "1.0",
    classification: ["internal"],
    status: "active",
    verification: "verified",
    accessControl: { mode: "snapshot", aclRevision: "acl-1", maximumAgeSeconds: 3600 },
    acl: {
      aclRevision: "acl-1",
      capturedAt: "2026-01-01T00:00:00.000Z",
      principals: [{ kind: "user", id: "u-1" }],
    },
    provenance: {
      capturedAt: "2026-01-01T00:00:00.000Z",
      contentHash: "hash-1",
      checkpoint: "1.0",
    },
    lastSyncedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("PgKnowledgeSourceStore", () => {
  let db: PGlite;
  let store: PgKnowledgeSourceStore;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    store = new PgKnowledgeSourceStore(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("round-trips a snapshot-mode record including acl and provenance checkpoint", async () => {
    await store.put(record());
    const found = await store.get(BUSINESS, "slack:T1:C1");
    expect(found).toEqual(record());
  });

  it("round-trips a live-mode record with no acl", async () => {
    const liveRecord = record({
      sourceId: "slack:T1:C2",
      accessControl: { mode: "live", maximumAgeSeconds: 60 },
      acl: undefined,
      provenance: { capturedAt: "2026-01-01T00:00:00.000Z", contentHash: "hash-2" },
    });
    await store.put(liveRecord);
    const found = await store.get(BUSINESS, "slack:T1:C2");
    expect(found).toEqual(liveRecord);
    expect(found?.acl).toBeUndefined();
    expect(found?.provenance.checkpoint).toBeUndefined();
  });

  it("upsert on conflict replaces the record", async () => {
    await store.put(record());
    await store.put(record({ revision: "2.0", classification: ["internal", "sensitive"] }));
    const found = await store.get(BUSINESS, "slack:T1:C1");
    expect(found?.revision).toBe("2.0");
    expect(found?.classification).toEqual(["internal", "sensitive"]);
  });

  it("get returns undefined for a missing source", async () => {
    expect(await store.get(BUSINESS, "slack:T1:missing")).toBeUndefined();
  });

  it("list scopes to businessId and never returns another business's sources", async () => {
    await store.put(record());
    await store.put(record({ sourceId: "slack:T1:C2", businessId: OTHER_BUSINESS }));
    const list = await store.list(BUSINESS);
    expect(list).toHaveLength(1);
    expect(list[0]?.sourceId).toBe("slack:T1:C1");
  });
});
