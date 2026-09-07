import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { PgOimKnowledgeCheckpointStore } from "./oim-checkpoint-store";

describe("PgOimKnowledgeCheckpointStore", () => {
  let db: PGlite;
  let store: PgOimKnowledgeCheckpointStore;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    store = new PgOimKnowledgeCheckpointStore(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("returns undefined for a scope never synced", async () => {
    expect(await store.load("wiki", "SPACE-1")).toBeUndefined();
  });

  it("round-trips a cursor and the ids the last full walk saw", async () => {
    await store.save({
      integrationId: "wiki",
      scopeKey: "SPACE-1",
      cursor: "page-2",
      seenItemIds: ["1", "2"],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await store.load("wiki", "SPACE-1")).toEqual({
      integrationId: "wiki",
      scopeKey: "SPACE-1",
      cursor: "page-2",
      seenItemIds: ["1", "2"],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("round-trips a first sync that has neither cursor nor seen ids", async () => {
    await store.save({
      integrationId: "wiki",
      scopeKey: "SPACE-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await store.load("wiki", "SPACE-1")).toEqual({
      integrationId: "wiki",
      scopeKey: "SPACE-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("overwrites an existing checkpoint for the same scope", async () => {
    await store.save({
      integrationId: "wiki",
      scopeKey: "SPACE-1",
      cursor: "page-1",
      seenItemIds: ["1"],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.save({
      integrationId: "wiki",
      scopeKey: "SPACE-1",
      cursor: "page-9",
      seenItemIds: ["1", "2", "3"],
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const found = await store.load("wiki", "SPACE-1");
    expect(found?.cursor).toBe("page-9");
    expect(found?.seenItemIds).toEqual(["1", "2", "3"]);
  });

  it("keeps scopes of one Integration independent", async () => {
    await store.save({
      integrationId: "wiki",
      scopeKey: "SPACE-1",
      cursor: "a",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.save({
      integrationId: "wiki",
      scopeKey: "SPACE-2",
      cursor: "b",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect((await store.load("wiki", "SPACE-1"))?.cursor).toBe("a");
    expect((await store.load("wiki", "SPACE-2"))?.cursor).toBe("b");
  });
});
