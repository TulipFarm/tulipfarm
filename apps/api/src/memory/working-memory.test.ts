import type { Db } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import {
  InvalidMemoryEntryError,
  MongoWorkingMemoryRepo,
  type WorkingMemoryDoc,
  assertValidEntry,
} from "./working-memory";

// Hand-rolled Mongo stub: the repo only touches collection.replaceOne / deleteOne / find().sort().toArray().
function makeFakeDb(findResult: WorkingMemoryDoc[] = [], deletedCount = 1) {
  const replaceOne = vi.fn(async () => ({ acknowledged: true }));
  const deleteOne = vi.fn(async () => ({ deletedCount }));
  const toArray = vi.fn(async () => findResult);
  const sort = vi.fn(() => ({ toArray }));
  const find = vi.fn(() => ({ sort }));
  const db = { collection: () => ({ replaceOne, deleteOne, find }) } as unknown as Db;
  return { db, replaceOne, deleteOne, find, sort, toArray };
}

function baseDoc(overrides: Partial<WorkingMemoryDoc> = {}): WorkingMemoryDoc {
  const now = new Date();
  return {
    _id: "m1",
    userId: "u1",
    key: "reply_style",
    value: "terse",
    createdAt: now,
    lastWrittenAt: now,
    ...overrides,
  };
}

describe("assertValidEntry", () => {
  it("accepts a valid entry", () => {
    expect(() => assertValidEntry(baseDoc())).not.toThrow();
  });

  it("rejects an empty userId", () => {
    expect(() => assertValidEntry(baseDoc({ userId: "" }))).toThrow(InvalidMemoryEntryError);
  });

  it("rejects an empty key", () => {
    expect(() => assertValidEntry(baseDoc({ key: "" }))).toThrow(InvalidMemoryEntryError);
  });

  it("rejects a key over the length cap", () => {
    expect(() => assertValidEntry(baseDoc({ key: "k".repeat(129) }))).toThrow(
      InvalidMemoryEntryError
    );
  });

  it("rejects a value over the length cap", () => {
    expect(() => assertValidEntry(baseDoc({ value: "v".repeat(1025) }))).toThrow(
      InvalidMemoryEntryError
    );
  });
});

describe("MongoWorkingMemoryRepo", () => {
  it("upsert validates then replaceOne with a {userId,key} filter and upsert:true", async () => {
    const { db, replaceOne } = makeFakeDb();
    const repo = new MongoWorkingMemoryRepo(db);
    const doc = baseDoc();

    await expect(repo.upsert(doc)).resolves.toBeUndefined();
    expect(replaceOne).toHaveBeenCalledTimes(1);
    expect(replaceOne).toHaveBeenCalledWith({ userId: "u1", key: "reply_style" }, doc, {
      upsert: true,
    });
  });

  it("upsert rejects an invalid doc and never calls replaceOne", async () => {
    const { db, replaceOne } = makeFakeDb();
    const repo = new MongoWorkingMemoryRepo(db);

    await expect(repo.upsert(baseDoc({ key: "" }))).rejects.toBeInstanceOf(InvalidMemoryEntryError);
    expect(replaceOne).not.toHaveBeenCalled();
  });

  it("deleteByKey returns true when a doc was removed", async () => {
    const { db } = makeFakeDb([], 1);
    const repo = new MongoWorkingMemoryRepo(db);
    await expect(repo.deleteByKey("u1", "reply_style")).resolves.toBe(true);
  });

  it("deleteByKey returns false when nothing matched", async () => {
    const { db } = makeFakeDb([], 0);
    const repo = new MongoWorkingMemoryRepo(db);
    await expect(repo.deleteByKey("u1", "absent")).resolves.toBe(false);
  });

  it("listByUser queries by userId, sorts by lastWrittenAt asc, returns the docs", async () => {
    const docs = [baseDoc({ _id: "a", key: "a" }), baseDoc({ _id: "b", key: "b" })];
    const { db, find, sort } = makeFakeDb(docs);
    const repo = new MongoWorkingMemoryRepo(db);

    await expect(repo.listByUser("u1")).resolves.toEqual(docs);
    expect(find).toHaveBeenCalledWith({ userId: "u1" });
    expect(sort).toHaveBeenCalledWith({ lastWrittenAt: 1 });
  });
});
