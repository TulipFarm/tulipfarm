import type { Queryable } from "@tulipfarm/storage";

/** Re-embeds rows missing vectors; provider failure leaves rows for the next sweep. */

export interface BackfillTarget {
  readonly table: string;
  /** Columns identifying one row; composite because most of these tables key on `business_id`. */
  readonly keys: readonly string[];
  /** SQL expression producing the text to embed. */
  readonly textSql: string;
  readonly embeddingColumn: string;
  readonly modelColumn: string;
  readonly dimColumn: string;
  /** Stores bare embedding model names; analytics infer the provider from Soul config. */
  readonly modelFormat: "bare" | "provider-qualified";
}

/** Mirrors `EMBEDDING_COLUMNS` in ../vector-search.ts — every indexed vector column. */
export const BACKFILL_TARGETS: readonly BackfillTarget[] = [
  {
    table: "knowledge_chunks",
    keys: ["id"],
    textSql: "content",
    embeddingColumn: "embedding",
    modelColumn: "model",
    dimColumn: "dim",
    modelFormat: "bare",
  },
  {
    table: "knowledge_source_chunks",
    keys: ["business_id", "chunk_id"],
    textSql: "content",
    embeddingColumn: "embedding",
    modelColumn: "model",
    dimColumn: "dim",
    modelFormat: "bare",
  },
];

export interface BackfillEmbedder {
  isAvailable(): boolean;
  embedMany(values: string[]): Promise<{ embeddings: number[][]; dimension: number }>;
  getActive(): { provider: string; model: string; dimension: number | null } | null;
}

export interface BackfillOptions {
  /** Rows per table per run. Bounded so a large corpus cannot become one enormous provider bill. */
  readonly batchSize?: number;
  readonly targets?: readonly BackfillTarget[];
  readonly log?: (msg: string) => void;
}

export interface BackfillResult {
  readonly embedded: number;
  readonly remaining: number;
  readonly byTable: Record<string, number>;
}

export const DEFAULT_BACKFILL_BATCH = 100;

/** pgvector's text input form. */
function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

/** Batch-embeds first, then falls back per row so one bad row does not block the rest. */
async function embedBatchOrPerRow(
  embeddings: BackfillEmbedder,
  rows: Record<string, unknown>[],
  target: BackfillTarget,
  onSkip?: (msg: string) => void
): Promise<{ embeddings: (number[] | undefined)[]; dimension: number }> {
  const texts = rows.map((r) => r.backfill_text as string);
  try {
    const out = await embeddings.embedMany(texts);
    return { embeddings: out.embeddings, dimension: out.dimension };
  } catch (error) {
    onSkip?.(
      `embedding backfill: batch of ${texts.length} failed for ${target.table}, retrying per row: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const embedded: (number[] | undefined)[] = [];
  let dimension = 0;
  let skipped = 0;
  for (const text of texts) {
    try {
      const one = await embeddings.embedMany([text]);
      embedded.push(one.embeddings[0]);
      if (one.dimension > 0) dimension = one.dimension;
    } catch {
      // Left NULL. The row stays a candidate, but the rest of the batch is no longer blocked by it.
      embedded.push(undefined);
      skipped += 1;
    }
  }
  if (skipped > 0) onSkip?.(`embedding backfill: skipped ${skipped} unembeddable row(s)`);
  return { embeddings: embedded, dimension };
}

/** Bounded integer batch size; this protects provider calls, not SQL injection. */
function safeBatchSize(batchSize: number): number {
  if (!Number.isFinite(batchSize)) return DEFAULT_BACKFILL_BATCH;
  return Math.min(Math.max(Math.trunc(batchSize), 1), MAX_BACKFILL_BATCH);
}

/** Ceiling on rows per table per run, whatever the caller asks for. */
export const MAX_BACKFILL_BATCH = 1000;

async function backfillTable(
  q: Queryable,
  embeddings: BackfillEmbedder,
  target: BackfillTarget,
  batchSize: number,
  model: string,
  onSkip?: (msg: string) => void
): Promise<{ embedded: number; remaining: number }> {
  const keyList = target.keys.join(", ");
  const { rows } = await q.query(
    `SELECT ${keyList}, ${target.textSql} AS backfill_text
       FROM ${target.table}
      WHERE ${target.embeddingColumn} IS NULL
        AND coalesce(${target.textSql}, '') <> ''
      LIMIT $1`,
    [safeBatchSize(batchSize)]
  );
  if (rows.length === 0) return { embedded: 0, remaining: 0 };

  const out = await embedBatchOrPerRow(embeddings, rows, target, onSkip);

  let embedded = 0;
  for (const [i, row] of rows.entries()) {
    const vector = out.embeddings[i];
    if (vector === undefined) continue;
    // Two race guards: skip if a concurrent writer filled the vector, or if text changed while
    // the provider was working. Otherwise stale vectors can become permanent corruption.
    const where = target.keys.map((k, j) => `${k} = $${j + 4}`).join(" AND ");
    const textParam = `$${target.keys.length + 4}`;
    const { rows: updated } = await q.query(
      `UPDATE ${target.table}
          SET ${target.embeddingColumn} = $1::vector,
              ${target.modelColumn} = $2,
              ${target.dimColumn} = $3
        WHERE ${where}
          AND ${target.embeddingColumn} IS NULL
          AND ${target.textSql} IS NOT DISTINCT FROM ${textParam}
        RETURNING 1 AS ok`,
      [
        toVectorLiteral(vector),
        model,
        out.dimension,
        ...target.keys.map((k) => row[k]),
        row.backfill_text,
      ]
    );
    embedded += updated.length;
  }

  const { rows: left } = await q.query(
    `SELECT count(*)::int AS remaining
       FROM ${target.table}
      WHERE ${target.embeddingColumn} IS NULL
        AND coalesce(${target.textSql}, '') <> ''`
  );
  return { embedded, remaining: (left[0]?.remaining as number) ?? 0 };
}

/** Embeds one bounded batch per table and returns counts for logs/tests. */
export async function backfillEmbeddings(
  q: Queryable,
  embeddings: BackfillEmbedder,
  options: BackfillOptions = {}
): Promise<BackfillResult> {
  const byTable: Record<string, number> = {};
  if (!embeddings.isAvailable()) return { embedded: 0, remaining: 0, byTable };
  const active = embeddings.getActive();
  const model = active?.model;
  if (model === undefined || model === null) return { embedded: 0, remaining: 0, byTable };

  const batchSize = options.batchSize ?? DEFAULT_BACKFILL_BATCH;
  const targets = options.targets ?? BACKFILL_TARGETS;
  let embedded = 0;
  let remaining = 0;

  for (const target of targets) {
    try {
      const result = await backfillTable(
        q,
        embeddings,
        target,
        batchSize,
        {
          bare: model,
          "provider-qualified": active?.provider ? `${active.provider}:${model}` : model,
        }[target.modelFormat],
        options.log
      );
      if (result.embedded > 0) byTable[target.table] = result.embedded;
      embedded += result.embedded;
      remaining += result.remaining;
    } catch (error) {
      // One failing table must not stop the remaining tables from being swept.
      options.log?.(
        `embedding backfill failed for ${target.table}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  if (embedded > 0) {
    options.log?.(`embedding backfill: embedded ${embedded} row(s), ${remaining} remaining`);
  }
  return { embedded, remaining, byTable };
}

export const EMBEDDING_BACKFILL_QUEUE = "embedding-backfill";

/** Five-minute cadence limits provider-outage recall gaps without constant polling. */
export const EMBEDDING_BACKFILL_CRON = "*/5 * * * *";

export interface RegisterEmbeddingBackfillDeps {
  readonly db: Queryable;
  readonly embeddings: BackfillEmbedder;
  readonly log?: {
    error(obj: unknown, msg?: string): void;
    info?(obj: unknown, msg?: string): void;
  };
  readonly batchSize?: number;
}

/** Registers one exclusive periodic sweep, so slow backfills do not overlap. */
export async function registerEmbeddingBackfill(
  boss: {
    createQueue(name: string, options?: { policy?: string }): Promise<unknown>;
    work(name: string, handler: () => Promise<unknown>): Promise<unknown>;
    schedule(name: string, cron: string): Promise<unknown>;
  },
  deps: RegisterEmbeddingBackfillDeps
): Promise<void> {
  await boss.createQueue(EMBEDDING_BACKFILL_QUEUE, { policy: "exclusive" });
  await boss.work(EMBEDDING_BACKFILL_QUEUE, async () => {
    try {
      const result = await backfillEmbeddings(deps.db, deps.embeddings, {
        batchSize: deps.batchSize,
        log: (msg) => deps.log?.info?.({}, msg),
      });
      if (result.embedded > 0) {
        deps.log?.info?.(
          { embedded: result.embedded, remaining: result.remaining, byTable: result.byTable },
          "embedding backfill"
        );
      }
    } catch (error) {
      // The next scheduled run rereads the same NULL rows, so pg-boss retry adds no value.
      deps.log?.error({ error }, "embedding backfill failed");
    }
  });
  await boss.schedule(EMBEDDING_BACKFILL_QUEUE, EMBEDDING_BACKFILL_CRON);
}
