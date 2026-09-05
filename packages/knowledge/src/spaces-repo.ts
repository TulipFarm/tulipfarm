import type { Queryable } from "@tulipfarm/storage";
import { type PaginatedResult, toPage } from "@tulipfarm/storage";
import { isKnowledgeId } from "./ids";
import type { KnowledgeSpace, SpaceWithActivity } from "./types";

const SPACE_COLS = "id, name, description, created_at, updated_at";

function rowToSpace(row: Record<string, unknown>): KnowledgeSpace {
  return {
    _id: row.id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export interface SpacePatch {
  name?: string;
  description?: string | null;
}

export interface KnowledgeSpaceRepo {
  insert(s: KnowledgeSpace): Promise<void>;
  getById(id: string): Promise<KnowledgeSpace | null>;
  getManyById(ids: readonly string[]): Promise<KnowledgeSpace[]>;
  getByName(name: string): Promise<KnowledgeSpace | null>;
  list(opts: {
    limit: number;
    after?: { createdAt: Date; _id: string };
  }): Promise<PaginatedResult<KnowledgeSpace>>;
  /** Every space with its active page count + last activity, most-recently-active first (home grid). */
  listWithActivity(): Promise<SpaceWithActivity[]>;
  /** Partial metadata update (COALESCE-keep: a null patch field preserves the existing value). */
  update(id: string, patch: SpacePatch, updatedAt: Date): Promise<KnowledgeSpace | null>;
  /**
   * Deletes the Space and every Page in it.
   *
   * `knowledge_pages.space_id` is NO ACTION, not CASCADE, so an accidental `DELETE FROM
   * knowledge_spaces` cannot silently take a corpus with it — which makes removing the Pages this
   * method's job. Chunks, revisions, links and the ACL entries naming each Page follow from the
   * Page rows going, via their own cascades and the `knowledge_*_prune_acl` triggers.
   */
  delete(id: string): Promise<boolean>;
}

export class PgKnowledgeSpaceRepo implements KnowledgeSpaceRepo {
  constructor(private readonly q: Queryable) {}

  async insert(s: KnowledgeSpace): Promise<void> {
    await this.q.query(`INSERT INTO knowledge_spaces (${SPACE_COLS}) VALUES ($1,$2,$3,$4,$5)`, [
      s._id,
      s.name,
      s.description,
      s.createdAt,
      s.updatedAt,
    ]);
  }

  async getById(id: string): Promise<KnowledgeSpace | null> {
    // `id` is a `uuid` column, so a malformed id must read as absent rather than raise.
    if (!isKnowledgeId(id)) return null;
    const { rows } = await this.q.query(
      `SELECT ${SPACE_COLS} FROM knowledge_spaces WHERE id = $1`,
      [id]
    );
    return rows[0] ? rowToSpace(rows[0]) : null;
  }

  async getManyById(ids: readonly string[]): Promise<KnowledgeSpace[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.q.query(
      `SELECT ${SPACE_COLS} FROM knowledge_spaces WHERE id::text = ANY($1::text[])`,
      [[...ids]]
    );
    const byId = new Map(rows.map((row) => [String(row.id), rowToSpace(row)]));
    return ids.flatMap((id) => {
      const space = byId.get(id);
      return space === undefined ? [] : [space];
    });
  }

  async getByName(name: string): Promise<KnowledgeSpace | null> {
    const { rows } = await this.q.query(
      `SELECT ${SPACE_COLS} FROM knowledge_spaces WHERE name = $1`,
      [name]
    );
    return rows[0] ? rowToSpace(rows[0]) : null;
  }

  async list(opts: {
    limit: number;
    after?: { createdAt: Date; _id: string };
  }): Promise<PaginatedResult<KnowledgeSpace>> {
    const params: unknown[] = [];
    let where = "";
    if (opts.after) {
      params.push(opts.after.createdAt, opts.after._id);
      where = "WHERE (created_at, id) > ($1, $2)";
    }
    params.push(opts.limit + 1);
    const { rows } = await this.q.query(
      `SELECT ${SPACE_COLS} FROM knowledge_spaces ${where}
       ORDER BY created_at, id LIMIT $${params.length}`,
      params
    );
    return toPage(rows.map(rowToSpace), opts.limit);
  }

  async listWithActivity(): Promise<SpaceWithActivity[]> {
    const { rows } = await this.q.query(
      `SELECT s.id, s.name, s.description, s.created_at, s.updated_at,
              COUNT(p.id) FILTER (WHERE p.active AND p.path IS NOT NULL) AS page_count,
              GREATEST(s.updated_at, COALESCE(MAX(p.updated_at) FILTER (WHERE p.active), s.updated_at))
                AS last_activity
       FROM knowledge_spaces s
       LEFT JOIN knowledge_pages p ON p.space_id = s.id
       GROUP BY s.id
       ORDER BY last_activity DESC, s.name`
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        space: rowToSpace(row),
        pageCount: Number(row.page_count),
        lastActivity: row.last_activity as Date,
      };
    });
  }

  async update(id: string, patch: SpacePatch, updatedAt: Date): Promise<KnowledgeSpace | null> {
    if (!isKnowledgeId(id)) return null;
    const { rows } = await this.q.query(
      `UPDATE knowledge_spaces
       SET name = COALESCE($2, name), description = COALESCE($3, description), updated_at = $4
       WHERE id = $1 RETURNING ${SPACE_COLS}`,
      [id, patch.name ?? null, patch.description ?? null, updatedAt]
    );
    return rows[0] ? rowToSpace(rows[0]) : null;
  }

  async delete(id: string): Promise<boolean> {
    if (!isKnowledgeId(id)) return false;
    // One statement, not two: a pool-backed Queryable cannot hold a transaction across calls, and
    // a Space deleted while its Pages survive would leave a corpus no screen can reach. A
    // data-modifying CTE always runs to completion, and the NO ACTION check on space_id is made at
    // end of statement — by which point the Pages are gone.
    const { rows } = await this.q.query(
      `WITH deleted_pages AS (DELETE FROM knowledge_pages WHERE space_id = $1 RETURNING id)
       DELETE FROM knowledge_spaces WHERE id = $1 RETURNING id`,
      [id]
    );
    return rows.length === 1;
  }
}
