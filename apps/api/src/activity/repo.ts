import type { Queryable } from "../db";
import { type PaginatedResult, toPage } from "../pagination";

export type ActivityActorType = "user" | "system";
export type ActivityStatus = "ok" | "error";

/** Append-only activity row; `targetId` may be a non-UUID name and `metadata` is jsonb. */
export interface ActivityRow {
  _id: string;
  category: string;
  action: string;
  actorType: ActivityActorType;
  actorId: string | null;
  targetType: string | null;
  targetId: string | null;
  summary: string;
  status: ActivityStatus;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface ActivityListOpts {
  category?: string;
  limit: number;
  after?: { createdAt: Date; _id: string };
}

export interface ActivityRepo {
  insert(row: ActivityRow): Promise<void>;
  /** Newest-first keyset page, optionally filtered by category. */
  list(opts: ActivityListOpts): Promise<PaginatedResult<ActivityRow>>;
}

/** pg + PGlite return jsonb already parsed and timestamptz as a Date. */
function rowToActivity(row: Record<string, unknown>): ActivityRow {
  return {
    _id: row.id as string,
    category: row.category as string,
    action: row.action as string,
    actorType: row.actor_type as ActivityActorType,
    actorId: (row.actor_id as string | null) ?? null,
    targetType: (row.target_type as string | null) ?? null,
    targetId: (row.target_id as string | null) ?? null,
    summary: row.summary as string,
    status: row.status as ActivityStatus,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    createdAt: row.created_at as Date,
  };
}

export class PgActivityRepo implements ActivityRepo {
  constructor(private readonly q: Queryable) {}

  async insert(row: ActivityRow): Promise<void> {
    await this.q.query(
      `INSERT INTO activity_log
         (id, category, action, actor_type, actor_id, target_type, target_id, summary, status, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
      [
        row._id,
        row.category,
        row.action,
        row.actorType,
        row.actorId,
        row.targetType,
        row.targetId,
        row.summary,
        row.status,
        JSON.stringify(row.metadata),
        row.createdAt,
      ]
    );
  }

  async list(opts: ActivityListOpts): Promise<PaginatedResult<ActivityRow>> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.category) {
      params.push(opts.category);
      conds.push(`category = $${params.length}`);
    }
    if (opts.after) {
      // Expanded keyset comparison keeps pg and PGlite param inference aligned.
      params.push(opts.after.createdAt);
      const at = params.length;
      params.push(opts.after._id);
      const id = params.length;
      conds.push(`(created_at < $${at} OR (created_at = $${at} AND id < $${id}))`);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    params.push(opts.limit + 1); // over-fetch one to detect a next page (see toPage)
    const limitParam = params.length;
    const { rows } = await this.q.query(
      `SELECT * FROM activity_log ${where} ORDER BY created_at DESC, id DESC LIMIT $${limitParam}`,
      params
    );
    return toPage(rows.map(rowToActivity), opts.limit);
  }
}
