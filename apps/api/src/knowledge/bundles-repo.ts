import type { Queryable } from "../db";
import { type PaginatedResult, toPage } from "../pagination";
import type { BundleWithActivity, KnowledgeBundle } from "./types";

const BUNDLE_COLS = "id, name, description, created_at, updated_at";

function rowToBundle(row: Record<string, unknown>): KnowledgeBundle {
  return {
    _id: row.id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export interface BundlePatch {
  name?: string;
  description?: string | null;
}

export interface KnowledgeBundleRepo {
  insert(b: KnowledgeBundle): Promise<void>;
  getById(id: string): Promise<KnowledgeBundle | null>;
  getByName(name: string): Promise<KnowledgeBundle | null>;
  list(opts: {
    limit: number;
    after?: { createdAt: Date; _id: string };
  }): Promise<PaginatedResult<KnowledgeBundle>>;
  /** Every bundle with its active page count + last activity, most-recently-active first (home grid). */
  listWithActivity(): Promise<BundleWithActivity[]>;
  /** Partial metadata update (COALESCE-keep: a null patch field preserves the existing value). */
  update(id: string, patch: BundlePatch, updatedAt: Date): Promise<KnowledgeBundle | null>;
  /** Cascades to documents, links, and overrides via FK ON DELETE CASCADE. */
  delete(id: string): Promise<boolean>;
}

export class PgKnowledgeBundleRepo implements KnowledgeBundleRepo {
  constructor(private readonly q: Queryable) {}

  async insert(b: KnowledgeBundle): Promise<void> {
    await this.q.query(`INSERT INTO knowledge_bundles (${BUNDLE_COLS}) VALUES ($1,$2,$3,$4,$5)`, [
      b._id,
      b.name,
      b.description,
      b.createdAt,
      b.updatedAt,
    ]);
  }

  async getById(id: string): Promise<KnowledgeBundle | null> {
    const { rows } = await this.q.query(
      `SELECT ${BUNDLE_COLS} FROM knowledge_bundles WHERE id = $1`,
      [id]
    );
    return rows[0] ? rowToBundle(rows[0]) : null;
  }

  async getByName(name: string): Promise<KnowledgeBundle | null> {
    const { rows } = await this.q.query(
      `SELECT ${BUNDLE_COLS} FROM knowledge_bundles WHERE name = $1`,
      [name]
    );
    return rows[0] ? rowToBundle(rows[0]) : null;
  }

  async list(opts: {
    limit: number;
    after?: { createdAt: Date; _id: string };
  }): Promise<PaginatedResult<KnowledgeBundle>> {
    const params: unknown[] = [];
    let where = "";
    if (opts.after) {
      params.push(opts.after.createdAt, opts.after._id);
      where = "WHERE (created_at, id) > ($1, $2)";
    }
    params.push(opts.limit + 1);
    const { rows } = await this.q.query(
      `SELECT ${BUNDLE_COLS} FROM knowledge_bundles ${where}
       ORDER BY created_at, id LIMIT $${params.length}`,
      params
    );
    return toPage(rows.map(rowToBundle), opts.limit);
  }

  async listWithActivity(): Promise<BundleWithActivity[]> {
    const { rows } = await this.q.query(
      `SELECT b.id, b.name, b.description, b.created_at, b.updated_at,
              COUNT(d.id) FILTER (WHERE d.active AND d.path IS NOT NULL) AS page_count,
              GREATEST(b.updated_at, COALESCE(MAX(d.updated_at) FILTER (WHERE d.active), b.updated_at))
                AS last_activity
       FROM knowledge_bundles b
       LEFT JOIN knowledge_documents d ON d.bundle_id = b.id
       GROUP BY b.id
       ORDER BY last_activity DESC, b.name`
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        bundle: rowToBundle(row),
        pageCount: Number(row.page_count),
        lastActivity: row.last_activity as Date,
      };
    });
  }

  async update(id: string, patch: BundlePatch, updatedAt: Date): Promise<KnowledgeBundle | null> {
    const { rows } = await this.q.query(
      `UPDATE knowledge_bundles
       SET name = COALESCE($2, name), description = COALESCE($3, description), updated_at = $4
       WHERE id = $1 RETURNING ${BUNDLE_COLS}`,
      [id, patch.name ?? null, patch.description ?? null, updatedAt]
    );
    return rows[0] ? rowToBundle(rows[0]) : null;
  }

  async delete(id: string): Promise<boolean> {
    const { rows } = await this.q.query(
      "DELETE FROM knowledge_bundles WHERE id = $1 RETURNING id",
      [id]
    );
    return rows.length === 1;
  }
}
