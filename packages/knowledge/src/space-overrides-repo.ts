import type { Queryable } from "@tulipfarm/storage";
import type { KnowledgeSpaceOverride } from "./types";

type OverrideFile = "index.md" | "log.md";
const OVERRIDE_COLS = "space_id, dir_path, file, content, updated_at";

function rowToOverride(row: Record<string, unknown>): KnowledgeSpaceOverride {
  return {
    spaceId: row.space_id as string,
    dirPath: row.dir_path as string,
    file: row.file as OverrideFile,
    content: row.content as string,
    updatedAt: row.updated_at as Date,
  };
}

export interface KnowledgeSpaceOverrideRepo {
  upsert(o: KnowledgeSpaceOverride): Promise<void>;
  get(spaceId: string, dirPath: string, file: OverrideFile): Promise<KnowledgeSpaceOverride | null>;
  delete(spaceId: string, dirPath: string, file: OverrideFile): Promise<boolean>;
  listForSpace(spaceId: string): Promise<KnowledgeSpaceOverride[]>;
}

export class PgKnowledgeSpaceOverrideRepo implements KnowledgeSpaceOverrideRepo {
  constructor(private readonly q: Queryable) {}

  async upsert(o: KnowledgeSpaceOverride): Promise<void> {
    await this.q.query(
      `INSERT INTO knowledge_space_overrides (${OVERRIDE_COLS})
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (space_id, dir_path, file)
       DO UPDATE SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at`,
      [o.spaceId, o.dirPath, o.file, o.content, o.updatedAt]
    );
  }

  async get(
    spaceId: string,
    dirPath: string,
    file: OverrideFile
  ): Promise<KnowledgeSpaceOverride | null> {
    const { rows } = await this.q.query(
      `SELECT ${OVERRIDE_COLS} FROM knowledge_space_overrides
       WHERE space_id = $1 AND dir_path = $2 AND file = $3`,
      [spaceId, dirPath, file]
    );
    return rows[0] ? rowToOverride(rows[0]) : null;
  }

  async delete(spaceId: string, dirPath: string, file: OverrideFile): Promise<boolean> {
    const { rows } = await this.q.query(
      `DELETE FROM knowledge_space_overrides
       WHERE space_id = $1 AND dir_path = $2 AND file = $3 RETURNING space_id`,
      [spaceId, dirPath, file]
    );
    return rows.length === 1;
  }

  async listForSpace(spaceId: string): Promise<KnowledgeSpaceOverride[]> {
    const { rows } = await this.q.query(
      `SELECT ${OVERRIDE_COLS} FROM knowledge_space_overrides WHERE space_id = $1`,
      [spaceId]
    );
    return rows.map(rowToOverride);
  }
}
