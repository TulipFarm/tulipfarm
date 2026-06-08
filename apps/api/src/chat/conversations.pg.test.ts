import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import {
  type ConversationDoc,
  ConversationOwnerlessError,
  PgConversationRepo,
} from "./conversations";

function makeConv(overrides: Partial<ConversationDoc> = {}): ConversationDoc {
  const now = new Date();
  return { _id: randomUUID(), userId: randomUUID(), createdAt: now, updatedAt: now, ...overrides };
}

describe("PgConversationRepo", () => {
  let db: PGlite;
  let repo: PgConversationRepo;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    repo = new PgConversationRepo(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("creates a user-owned conversation and reads it back", async () => {
    const conv = makeConv({ model: "quick" });
    await repo.create(conv);
    const found = await repo.findById(conv._id);
    expect(found?.userId).toBe(conv.userId);
    expect(found?.agentId).toBeUndefined();
    expect(found?.model).toBe("quick");
  });

  it("creates an agent-owned conversation (no userId)", async () => {
    const conv = makeConv({ userId: undefined, agentId: "agent-1" });
    await repo.create(conv);
    const found = await repo.findById(conv._id);
    expect(found?.agentId).toBe("agent-1");
    expect(found?.userId).toBeUndefined();
  });

  it("rejects an ownerless conversation", async () => {
    const conv = makeConv({ userId: undefined, agentId: undefined });
    await expect(repo.create(conv)).rejects.toBeInstanceOf(ConversationOwnerlessError);
  });

  it("touch advances updated_at", async () => {
    const old = new Date("2020-01-01T00:00:00.000Z");
    const conv = makeConv({ createdAt: old, updatedAt: old });
    await repo.create(conv);
    await repo.touch(conv._id);
    const found = await repo.findById(conv._id);
    expect(found?.updatedAt.getTime()).toBeGreaterThan(old.getTime());
  });

  it("returns null for an unknown id", async () => {
    expect(await repo.findById(randomUUID())).toBeNull();
  });
});
