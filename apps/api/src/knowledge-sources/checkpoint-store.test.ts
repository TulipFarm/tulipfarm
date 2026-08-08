import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgSlackKnowledgeCheckpointStore } from "./checkpoint-store";

describe("PgSlackKnowledgeCheckpointStore", () => {
  let db: PGlite;
  let store: PgSlackKnowledgeCheckpointStore;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    store = new PgSlackKnowledgeCheckpointStore(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("load returns undefined for an unknown integration/channel pair", async () => {
    expect(await store.load("slack:app1:T1", "C1")).toBeUndefined();
  });

  it("round-trips a checkpoint with a cursor", async () => {
    await store.save({
      integrationId: "slack:app1:T1",
      channelId: "C1",
      cursor: "1700000000.000100",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const found = await store.load("slack:app1:T1", "C1");
    expect(found).toEqual({
      integrationId: "slack:app1:T1",
      channelId: "C1",
      cursor: "1700000000.000100",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("round-trips a checkpoint with no cursor (first sync)", async () => {
    await store.save({
      integrationId: "slack:app1:T1",
      channelId: "C1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const found = await store.load("slack:app1:T1", "C1");
    expect(found?.cursor).toBeUndefined();
  });

  it("save upserts on conflict rather than duplicating", async () => {
    await store.save({
      integrationId: "slack:app1:T1",
      channelId: "C1",
      cursor: "cursor-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.save({
      integrationId: "slack:app1:T1",
      channelId: "C1",
      cursor: "cursor-2",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const found = await store.load("slack:app1:T1", "C1");
    expect(found?.cursor).toBe("cursor-2");
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM slack_knowledge_checkpoints WHERE integration_id = $1 AND channel_id = $2",
      ["slack:app1:T1", "C1"]
    );
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it("keeps checkpoints for different channels of the same integration independent", async () => {
    await store.save({
      integrationId: "slack:app1:T1",
      channelId: "C1",
      cursor: "cursor-c1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.save({
      integrationId: "slack:app1:T1",
      channelId: "C2",
      cursor: "cursor-c2",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect((await store.load("slack:app1:T1", "C1"))?.cursor).toBe("cursor-c1");
    expect((await store.load("slack:app1:T1", "C2"))?.cursor).toBe("cursor-c2");
  });
});
