import type { Db } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import {
  type ConversationDoc,
  ConversationOwnerlessError,
  MongoConversationRepo,
} from "./conversations";

// Minimal hand-rolled Mongo stub: the repo only touches `db.collection(name)` in
// its constructor and `collection.insertOne(doc)` in create(). No live DB needed.
function makeFakeDb() {
  const insertOne = vi.fn(async () => ({ acknowledged: true, insertedId: "x" }));
  const db = {
    collection: () => ({ insertOne }),
  } as unknown as Db;
  return { db, insertOne };
}

function baseDoc(overrides: Partial<ConversationDoc>): ConversationDoc {
  return {
    _id: "conv1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("MongoConversationRepo.create — owner invariant", () => {
  it("rejects an ownerless doc and never calls insertOne", async () => {
    const { db, insertOne } = makeFakeDb();
    const repo = new MongoConversationRepo(db);

    await expect(repo.create(baseDoc({}))).rejects.toBeInstanceOf(ConversationOwnerlessError);
    expect(insertOne).not.toHaveBeenCalled();
  });

  it("reaches insertOne for a userId-only doc", async () => {
    const { db, insertOne } = makeFakeDb();
    const repo = new MongoConversationRepo(db);

    await expect(repo.create(baseDoc({ userId: "u1" }))).resolves.toBeUndefined();
    expect(insertOne).toHaveBeenCalledTimes(1);
  });

  it("reaches insertOne for an agentId-only doc", async () => {
    const { db, insertOne } = makeFakeDb();
    const repo = new MongoConversationRepo(db);

    await expect(repo.create(baseDoc({ agentId: "a1" }))).resolves.toBeUndefined();
    expect(insertOne).toHaveBeenCalledTimes(1);
  });

  it("reaches insertOne when both userId and agentId are present", async () => {
    const { db, insertOne } = makeFakeDb();
    const repo = new MongoConversationRepo(db);

    await expect(repo.create(baseDoc({ userId: "u1", agentId: "a1" }))).resolves.toBeUndefined();
    expect(insertOne).toHaveBeenCalledTimes(1);
  });
});
