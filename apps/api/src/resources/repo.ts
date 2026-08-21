import type { CounterFn } from "@tulipfarm/schema";
import { PgResourceRepo, PgResourceRepoFactory, type ResourceDoc } from "@tulipfarm/storage";
import type { Queryable } from "../db";

export type {
  HistoryOp,
  ListOpts,
  ResourceDoc,
  ResourceHistoryDoc,
  ResourceRepo,
  ResourceRepoFactory,
  SearchOpts,
} from "@tulipfarm/storage";
export { PgResourceRepo, PgResourceRepoFactory };

/** Display-id counter source (yields a `@tulipfarm/schema` `CounterFn`). */
export interface CounterStore {
  makeCounterFn(): CounterFn;
}

/** Resource repo: typed system columns plus schema-driven `data jsonb`; tables pre-exist. */

export class PgCounterStore implements CounterStore {
  constructor(private readonly q: Queryable) {}

  private async increment(type: string): Promise<number> {
    const { rows } = await this.q.query(
      `INSERT INTO counters (type, seq) VALUES ($1, 1)
       ON CONFLICT (type) DO UPDATE SET seq = counters.seq + 1
       RETURNING seq`,
      [type]
    );
    return Number((rows[0] as { seq: number | string }).seq);
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
