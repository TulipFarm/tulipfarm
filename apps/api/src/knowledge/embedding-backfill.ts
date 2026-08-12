import type { Queryable } from "../db";

/**
 * Re-embeds rows that were stored without an embedding.
 *
 * Every write path here degrades the same way: if the embedding provider is unavailable, or fails
 * mid-flight, the row is still written — with a NULL embedding — so ingestion never blocks on the
 * LLM. That is the right call, and `knowledge-index` already retries the *job*. But the job did not
 * fail: it completed and reported success, having stored lexical-only rows. pg-boss therefore has
 * nothing to retry, and those rows stay invisible to every vector query until something unrelated
 * happens to rewrite them. The code comments promised "picked up by a later resync"; no resync
 * existed.
 *
 * This is that resync. It is deliberately a sweep over `embedding IS NULL` rather than a queue of
 * remembered failures, because the failures are not the only source of such rows — a corpus
 * ingested while no provider was configured at all produces them too, and no queue would hold a
 * record of it.
 */

export interface BackfillTarget {
  readonly table: string;
  /** Columns identifying one row; composite because most of these tables key on `business_id`. */
  readonly keys: readonly string[];
  /** SQL expression producing the text to embed. */
  readonly textSql: string;
  readonly embeddingColumn: string;
  readonly modelColumn: string;
  readonly dimColumn: string;
  /**
   * How this table records which model produced the vector. The knowledge tables store the bare
   * model name (`index-service.ts` compares `prior.model === activeModel`); both memory stores
   * write `` `${provider}:${model}` `` (`assertion-store.ts`, `episode-store.ts`). Writing the
   * wrong form makes a backfilled row look like a foreign-model row to every such comparison.
   */
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
  {
    // Matches `embeddableText()` in ../memory/embedder.ts: subject and statement are joined because
    // either alone loses meaning. A different join here would embed memory differently on the
    // backfill path than on the write path, and the two vectors would not be comparable.
    table: "memory_assertions",
    keys: ["business_id", "assertion_id"],
    textSql: "subject || ': ' || statement",
    embeddingColumn: "embedding",
    modelColumn: "embedding_model",
    dimColumn: "embedding_dim",
    modelFormat: "provider-qualified",
  },
  {
    // `episode-store.ts` embeds `embeddableText("episode", text)`, not the bare column — the
    // wrapper is applied inside `embedChunk`, one call deeper than the visible `embedChunk(text)`.
    // Embedding the bare column here would put two incomparable vector populations in one column,
    // and `recall-index.ts` ranks by `min(distance)` across both.
    table: "memory_chunks",
    keys: ["business_id", "chunk_id"],
    textSql: "'episode: ' || text",
    embeddingColumn: "embedding",
    modelColumn: "embedding_model",
    dimColumn: "embedding_dim",
    modelFormat: "provider-qualified",
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

/**
 * Embeds the batch in one call, falling back to one call per row if that fails.
 *
 * Without the fallback a single row the provider refuses — an over-length input is the realistic
 * case, and none of these text columns has a length bound — fails `embedMany` for the whole batch.
 * Since the sweep re-selects the same unembedded rows every run, that means: no progress, ever, on
 * that table, the same rejected (and possibly billed) request every five minutes, and every other
 * row behind it starved indefinitely. Retrying per row costs one extra round of calls only on the
 * failure path, and isolates the poison row so the other 99 make progress.
 */
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

/**
 * A bounded, whole-number batch size.
 *
 * `LIMIT` takes a bind parameter, so this is not an injection guard — it stops a mis-set config
 * value (a float, a negative, or something enormous) from either erroring at the database or
 * pulling an unbounded number of rows into one provider call.
 */
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
    // Two guards, against two different races, both of which end in a vector that does not
    // describe the row it sits on:
    //
    //   `embedding IS NULL`  -- a concurrent writer filled the row while the provider was
    //                           working. Its vector came from the current text, this one from a
    //                           snapshot, so the concurrent writer wins.
    //   text unchanged       -- the row's *text* was replaced while the embedding stayed NULL.
    //                           `index-store` upserts `content = EXCLUDED.content, embedding =
    //                           EXCLUDED.embedding` and writes NULL when the provider is down,
    //                           which is exactly that shape. Without this guard the new content
    //                           gets the old content's vector, and because the row is no longer
    //                           NULL nothing ever revisits it -- the corruption is permanent and
    //                           silent. The row simply stays NULL and the next sweep retries it.
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

/**
 * Embeds one bounded batch per table. Returns what it did, so the caller can log it and a test can
 * assert on it.
 *
 * Does nothing when no provider is available — the rows are already stored and lexical search still
 * finds them, so there is no value in failing here. The next run picks them up.
 */
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
      // One table must not stop the others: a missing table (a deployment mid-migration) or a
      // provider that dropped out partway is not a reason to leave the remaining tables unswept.
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

/**
 * Every 5 minutes. Frequent enough that a provider outage costs minutes of missing recall rather
 * than hours; infrequent enough that a permanently-unconfigured deployment is doing one cheap
 * `count(*)`-shaped scan per table, and no LLM calls at all.
 */
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

/**
 * Registers the periodic backfill on pg-boss.
 *
 * `exclusive`, so a slow sweep on a large corpus delays the next one instead of stacking, and — the
 * reason it is on pg-boss at all rather than a timer — exactly one replica runs it. Two replicas
 * embedding the same rows would double the provider spend to reach the same state.
 */
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
      // Swallowed rather than rethrown, as with the schedule dispatcher: pg-boss would retry, but
      // the next run is five minutes away and re-reads the same `embedding IS NULL` rows anyway.
      deps.log?.error({ error }, "embedding backfill failed");
    }
  });
  await boss.schedule(EMBEDDING_BACKFILL_QUEUE, EMBEDDING_BACKFILL_CRON);
}
