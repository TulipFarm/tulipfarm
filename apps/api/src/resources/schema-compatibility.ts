import { ajv } from "@tulipfarm/schema";
import { withTransaction } from "@tulipfarm/storage";
import type { Queryable } from "../db";
import { tableName } from "./schema";

export type SchemaPublicationResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly affectedRecordIds: readonly string[];
      readonly affectedRecordCount: number;
    };

export interface ResourceSchemaCompatibility {
  publishIfCompatible<T>(
    type: string,
    schema: Record<string, unknown>,
    publish: () => Promise<T>
  ): Promise<SchemaPublicationResult<T>>;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_REPORTED_IDS = 100;

export class ResourceSchemaCompatibilityService implements ResourceSchemaCompatibility {
  constructor(
    private readonly database: Queryable,
    private readonly pageSize = DEFAULT_PAGE_SIZE
  ) {}

  async publishIfCompatible<T>(
    type: string,
    schema: Record<string, unknown>,
    publish: () => Promise<T>
  ): Promise<SchemaPublicationResult<T>> {
    const validate = ajv.compile(schema);
    const table = tableName(type);

    return withTransaction(this.database, async (transaction) => {
      await transaction.query(`LOCK TABLE ${table} IN SHARE MODE`);

      const affectedRecordIds: string[] = [];
      let affectedRecordCount = 0;
      let afterId: string | undefined;

      do {
        const page = afterId
          ? await transaction.query<{ id: string; data: Record<string, unknown> }>(
              `SELECT id, data FROM ${table}
               WHERE deleted_at IS NULL AND id > $1
               ORDER BY id LIMIT $2`,
              [afterId, this.pageSize]
            )
          : await transaction.query<{ id: string; data: Record<string, unknown> }>(
              `SELECT id, data FROM ${table}
               WHERE deleted_at IS NULL
               ORDER BY id LIMIT $1`,
              [this.pageSize]
            );

        for (const row of page.rows) {
          if (validate(row.data)) continue;
          affectedRecordCount += 1;
          if (affectedRecordIds.length < MAX_REPORTED_IDS) affectedRecordIds.push(row.id);
        }

        afterId = page.rows.length === this.pageSize ? page.rows.at(-1)?.id : undefined;
      } while (afterId !== undefined);

      if (affectedRecordCount > 0) {
        return { ok: false, affectedRecordIds, affectedRecordCount };
      }

      return { ok: true, value: await publish() };
    });
  }
}
