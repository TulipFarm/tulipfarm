import { randomUUID } from "node:crypto";
import type { CounterFn } from "@tulipfarm/validation";
import type { Collection, Db } from "mongodb";
import { type PaginatedResult, paginateCollection } from "../pagination";

export interface ResourceDoc {
  _id: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  [key: string]: unknown;
}

export interface ResourceHistoryDoc {
  _id: string;
  resourceId: string;
  operation: "create" | "update" | "delete";
  snapshot: ResourceDoc;
  at: Date;
}

export interface ListOpts {
  limit: number;
  after?: { createdAt: Date; _id: string };
  includeDeleted?: boolean;
}

export interface ResourceRepo {
  insert(doc: ResourceDoc): Promise<void>;
  findById(id: string): Promise<ResourceDoc | null>;
  list(opts: ListOpts): Promise<PaginatedResult<ResourceDoc>>;
  replaceOne(id: string, expectedVersion: number, doc: ResourceDoc): Promise<boolean>;
  appendHistory(entry: ResourceHistoryDoc): Promise<void>;
}

export class MongoResourceRepo implements ResourceRepo {
  private readonly col: Collection<ResourceDoc>;
  private readonly historyCol: Collection<ResourceHistoryDoc>;

  constructor(db: Db, type: string) {
    this.col = db.collection<ResourceDoc>(type);
    this.historyCol = db.collection<ResourceHistoryDoc>(`${type}_history`);
  }

  async insert(doc: ResourceDoc): Promise<void> {
    await this.col.insertOne(doc as ResourceDoc & { _id: string });
  }

  async findById(id: string): Promise<ResourceDoc | null> {
    return this.col.findOne({ _id: id } as Parameters<
      typeof this.col.findOne
    >[0]) as Promise<ResourceDoc | null>;
  }

  async list(opts: ListOpts): Promise<PaginatedResult<ResourceDoc>> {
    type PageDoc = { createdAt: Date; _id: string };
    const filter = opts.includeDeleted ? {} : { deletedAt: { $exists: false } };
    const result = await paginateCollection(
      this.col as unknown as Collection<PageDoc>,
      filter as import("mongodb").Filter<PageDoc>,
      opts.limit,
      opts.after
    );
    return result as unknown as PaginatedResult<ResourceDoc>;
  }

  async replaceOne(id: string, expectedVersion: number, doc: ResourceDoc): Promise<boolean> {
    const result = await this.col.replaceOne(
      { _id: id, version: expectedVersion } as Parameters<typeof this.col.replaceOne>[0],
      doc as ResourceDoc & { _id: string }
    );
    return result.matchedCount === 1;
  }

  async appendHistory(entry: ResourceHistoryDoc): Promise<void> {
    await this.historyCol.insertOne(entry as ResourceHistoryDoc & { _id: string });
  }
}

export class MongoCounterStore {
  private readonly col: Collection<{ _id: string; seq: number }>;

  constructor(db: Db) {
    this.col = db.collection<{ _id: string; seq: number }>("counters");
  }

  private async increment(resourceType: string): Promise<number> {
    const result = await this.col.findOneAndUpdate(
      { _id: resourceType },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" }
    );
    return (result as { seq: number }).seq;
  }

  makeCounterFn(): CounterFn {
    return (type: string) => this.increment(type);
  }
}

export function toApiRecord(doc: ResourceDoc): Record<string, unknown> {
  const { _id, ...rest } = doc;
  return {
    id: _id,
    ...rest,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : doc.updatedAt,
    ...(doc.deletedAt != null
      ? { deletedAt: doc.deletedAt instanceof Date ? doc.deletedAt.toISOString() : doc.deletedAt }
      : {}),
  };
}

export function makeHistoryEntry(
  resourceId: string,
  operation: ResourceHistoryDoc["operation"],
  snapshot: ResourceDoc
): ResourceHistoryDoc {
  return { _id: randomUUID(), resourceId, operation, snapshot, at: new Date() };
}
