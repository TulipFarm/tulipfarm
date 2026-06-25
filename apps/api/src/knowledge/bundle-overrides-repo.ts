import type { Queryable } from "../db";
import type { KnowledgeBundleOverride } from "./types";

type OverrideFile = "index.md" | "log.md";
const OVERRIDE_COLS = "bundle_id, dir_path, file, content, updated_at";

function rowToOverride(row: Record<string, unknown>): KnowledgeBundleOverride {
  return {
    bundleId: row.bundle_id as string,
    dirPath: row.dir_path as string,
    file: row.file as OverrideFile,
    content: row.content as string,
    updatedAt: row.updated_at as Date,
  };
}

export interface KnowledgeBundleOverrideRepo {
  upsert(o: KnowledgeBundleOverride): Promise<void>;
  get(
    bundleId: string,
    dirPath: string,
    file: OverrideFile
  ): Promise<KnowledgeBundleOverride | null>;
  delete(bundleId: string, dirPath: string, file: OverrideFile): Promise<boolean>;
  listForBundle(bundleId: string): Promise<KnowledgeBundleOverride[]>;
}

export class PgKnowledgeBundleOverrideRepo implements KnowledgeBundleOverrideRepo {
  constructor(private readonly q: Queryable) {}

  async upsert(o: KnowledgeBundleOverride): Promise<void> {
    await this.q.query(
      `INSERT INTO knowledge_bundle_overrides (${OVERRIDE_COLS})
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (bundle_id, dir_path, file)
       DO UPDATE SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at`,
      [o.bundleId, o.dirPath, o.file, o.content, o.updatedAt]
    );
  }

  async get(
    bundleId: string,
    dirPath: string,
    file: OverrideFile
  ): Promise<KnowledgeBundleOverride | null> {
    const { rows } = await this.q.query(
      `SELECT ${OVERRIDE_COLS} FROM knowledge_bundle_overrides
       WHERE bundle_id = $1 AND dir_path = $2 AND file = $3`,
      [bundleId, dirPath, file]
    );
    return rows[0] ? rowToOverride(rows[0]) : null;
  }

  async delete(bundleId: string, dirPath: string, file: OverrideFile): Promise<boolean> {
    const { rows } = await this.q.query(
      `DELETE FROM knowledge_bundle_overrides
       WHERE bundle_id = $1 AND dir_path = $2 AND file = $3 RETURNING bundle_id`,
      [bundleId, dirPath, file]
    );
    return rows.length === 1;
  }

  async listForBundle(bundleId: string): Promise<KnowledgeBundleOverride[]> {
    const { rows } = await this.q.query(
      `SELECT ${OVERRIDE_COLS} FROM knowledge_bundle_overrides WHERE bundle_id = $1`,
      [bundleId]
    );
    return rows.map(rowToOverride);
  }
}
