import type { PGlite } from "@electric-sql/pglite";
import {
  BACKFILL_TARGETS,
  type BackfillEmbedder,
  backfillEmbeddings,
  EMBEDDING_BACKFILL_CRON,
  EMBEDDING_BACKFILL_QUEUE,
  registerEmbeddingBackfill,
} from "@tulipfarm/knowledge";
import type { Queryable } from "@tulipfarm/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";

const DIM = 4;

function embedder(overrides: Partial<BackfillEmbedder> = {}): BackfillEmbedder {
  return {
    isAvailable: () => true,
    getActive: () => ({ provider: "test", model: "m1", dimension: DIM }),
    embedMany: async (values: string[]) => ({
      embeddings: values.map((_, i) => [i + 1, 0, 0, 0]),
      dimension: DIM,
    }),
    ...overrides,
  };
}

describe("embedding backfill", () => {
  let pg: PGlite;
  let db: Queryable;

  // The whole migration set is replayed once, not per test: PGlite runs Postgres in WASM and a
  // full schema build is ~1s, which at one per test made the suite outgrow the hook timeout.
  // Tests are isolated by truncating the tables they touch instead.
  beforeAll(async () => {
    pg = await makeMigratedPglite();
    db = { query: (text, params) => pg.query(text, params as never[]) as never };
  });

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await db.query(
      `TRUNCATE knowledge_chunks, knowledge_pages, knowledge_source_chunks,
                knowledge_source_records CASCADE`
    );
  });

  it("covers exactly the tables that have an indexed embedding column", async () => {
    // Drift here is silent: a new vector column with no backfill target simply never recovers.
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.columns
        WHERE column_name = 'embedding' AND udt_name = 'vector'
        ORDER BY table_name`
    );
    expect(BACKFILL_TARGETS.map((t) => t.table).sort()).toEqual(
      rows.map((r) => r.table_name as string)
    );
  });

  it("leaves the row NULL when its text changed while the provider was working", async () => {
    // `index-store` upserts `content = EXCLUDED.content, embedding = EXCLUDED.embedding` and
    // writes NULL when the provider is down -- so text can change while the embedding stays
    // NULL. Writing the snapshot's vector here would pair new content with an old vector, and
    // because the row would no longer be NULL nothing would ever revisit it.
    const page = await seedPage();
    await db.query(
      `INSERT INTO knowledge_chunks (id, page_id, chunk_index, content, tsv, embedding, created_at)
       VALUES (gen_random_uuid(), $1, 0, 'original text', to_tsvector('english','o'), NULL, now())`,
      [page]
    );

    const racing = embedder({
      embedMany: async (values: string[]) => {
        // The whole point: the row's text changes while the provider is "working".
        await db.query("UPDATE knowledge_chunks SET content = 'replaced text'");
        return { embeddings: values.map((_, i) => [i + 1, 0, 0, 0]), dimension: DIM };
      },
    });
    const result = await backfillEmbeddings(db, racing);

    expect(result.embedded).toBe(0);
    const { rows } = await db.query(
      "SELECT content, embedding IS NULL AS empty FROM knowledge_chunks"
    );
    expect(rows[0]).toMatchObject({ content: "replaced text", empty: true });
  });

  it("embeds rows that were stored without one, and reports them", async () => {
    const page = await seedPage();
    await db.query(
      `INSERT INTO knowledge_chunks (id, page_id, chunk_index, content, tsv, embedding, created_at)
       VALUES (gen_random_uuid(), $1, 0, 'lexical only', to_tsvector('english','lexical only'), NULL, now())`,
      [page]
    );

    const result = await backfillEmbeddings(db, embedder());

    expect(result.embedded).toBe(1);
    expect(result.byTable).toEqual({ knowledge_chunks: 1 });
    const { rows } = await db.query(
      "SELECT embedding IS NOT NULL AS has, model, dim FROM knowledge_chunks"
    );
    expect(rows[0]).toMatchObject({ has: true, model: "m1", dim: DIM });
  });

  it("does nothing when no provider is available, rather than failing", async () => {
    const page = await seedPage();
    await db.query(
      `INSERT INTO knowledge_chunks (id, page_id, chunk_index, content, tsv, created_at)
       VALUES (gen_random_uuid(), $1, 0, 'lexical only', to_tsvector('english','lexical only'), now())`,
      [page]
    );

    let called = false;
    const result = await backfillEmbeddings(
      db,
      embedder({
        isAvailable: () => false,
        embedMany: async () => {
          called = true;
          throw new Error("must not be called");
        },
      })
    );

    expect(result.embedded).toBe(0);
    expect(called).toBe(false);
  });

  it("leaves rows that already have an embedding untouched", async () => {
    const page = await seedPage();
    await db.query(
      `INSERT INTO knowledge_chunks (id, page_id, chunk_index, content, tsv, embedding, model, dim, created_at)
       VALUES (gen_random_uuid(), $1, 0, 'already done', to_tsvector('english','already done'),
               $2::vector, 'old-model', $3, now())`,
      [page, "[9,9,9,9]", DIM]
    );

    const result = await backfillEmbeddings(db, embedder());

    expect(result.embedded).toBe(0);
    // Specifically not re-embedded under the active model: that is a re-index concern, and doing
    // it here would silently re-embed the whole corpus on every model change.
    const { rows } = await db.query("SELECT model FROM knowledge_chunks");
    expect(rows[0]?.model).toBe("old-model");
  });

  it("skips rows whose text is empty, which can never produce a useful vector", async () => {
    const page = await seedPage();
    await db.query(
      `INSERT INTO knowledge_chunks (id, page_id, chunk_index, content, tsv, created_at)
       VALUES (gen_random_uuid(), $1, 0, '', to_tsvector('english',''), now())`,
      [page]
    );

    expect((await backfillEmbeddings(db, embedder())).embedded).toBe(0);
  });

  it("honours the batch size and reports what is still outstanding", async () => {
    const page = await seedPage();
    for (let i = 0; i < 5; i++) {
      await db.query(
        `INSERT INTO knowledge_chunks (id, page_id, chunk_index, content, tsv, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'chunk', to_tsvector('english','chunk'), now())`,
        [page, i]
      );
    }

    const result = await backfillEmbeddings(db, embedder(), { batchSize: 2 });

    expect(result.embedded).toBe(2);
    expect(result.remaining).toBe(3);
  });

  it("backfills a composite-keyed table without touching its siblings", async () => {
    await seedSourceRecord();
    await db.query(
      `INSERT INTO knowledge_source_chunks
         (business_id, source_id, chunk_id, revision, digest, content, tsv, created_at, updated_at)
       VALUES ('b1', 's1', 'c1', 'r1', 'd1', 'source text',
               to_tsvector('english', 'source text'), now(), now())`
    );

    const result = await backfillEmbeddings(db, embedder());

    expect(result.byTable).toEqual({ knowledge_source_chunks: 1 });
    const { rows } = await db.query(
      "SELECT embedding IS NOT NULL AS has, dim FROM knowledge_source_chunks WHERE chunk_id='c1'"
    );
    expect(rows[0]).toMatchObject({ has: true, dim: DIM });
  });

  it("keeps sweeping the remaining tables when one of them fails", async () => {
    const page = await seedPage();
    await db.query(
      `INSERT INTO knowledge_chunks (id, page_id, chunk_index, content, tsv, created_at)
       VALUES (gen_random_uuid(), $1, 0, 'still indexed', to_tsvector('english','still indexed'), now())`,
      [page]
    );
    const messages: string[] = [];
    const broken = { ...BACKFILL_TARGETS[0], table: "no_such_table" };

    const result = await backfillEmbeddings(db, embedder(), {
      targets: [broken, BACKFILL_TARGETS[0]],
      log: (m) => messages.push(m),
    });

    expect(result.embedded).toBe(1);
    expect(messages.some((m) => m.includes("no_such_table"))).toBe(true);
  });

  it("registers an exclusive queue on a cron schedule", async () => {
    // Exclusive because two replicas embedding the same rows doubles the provider spend to reach
    // an identical state.
    const created: { name: string; policy?: string }[] = [];
    const scheduled: { name: string; cron: string }[] = [];
    let handler: (() => Promise<unknown>) | undefined;

    await registerEmbeddingBackfill(
      {
        createQueue: async (name, options) => created.push({ name, policy: options?.policy }),
        work: async (_name, h) => {
          handler = h;
        },
        schedule: async (name, cron) => scheduled.push({ name, cron }),
      },
      { db, embeddings: embedder() }
    );

    expect(created).toEqual([{ name: EMBEDDING_BACKFILL_QUEUE, policy: "exclusive" }]);
    expect(scheduled).toEqual([{ name: EMBEDDING_BACKFILL_QUEUE, cron: EMBEDDING_BACKFILL_CRON }]);
    await expect(handler?.()).resolves.not.toThrow();
  });

  it("does not let a sweep failure escape into pg-boss", async () => {
    const errors: unknown[] = [];
    let handler: (() => Promise<unknown>) | undefined;

    await registerEmbeddingBackfill(
      {
        createQueue: async () => undefined,
        work: async (_name, h) => {
          handler = h;
        },
        schedule: async () => undefined,
      },
      {
        db,
        embeddings: embedder({
          isAvailable: () => {
            throw new Error("provider exploded");
          },
        }),
        log: { error: (obj) => errors.push(obj) },
      }
    );

    await expect(handler?.()).resolves.not.toThrow();
    expect(errors).toHaveLength(1);
  });

  /** Poison rows must not starve the whole table; failed batches fall back to per-row attempts. */
  it("isolates a row the provider refuses instead of stalling the whole table", async () => {
    const pageId = await seedPage();
    for (const [index, content] of ["good-1", "POISON", "good-2"].entries()) {
      await db.query(
        `INSERT INTO knowledge_chunks (id, page_id, chunk_index, content, tsv, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, to_tsvector('english',$3), now())`,
        [pageId, index, content]
      );
    }

    const calls: number[] = [];
    const result = await backfillEmbeddings(
      db,
      embedder({
        embedMany: async (values: string[]) => {
          calls.push(values.length);
          if (values.includes("POISON")) throw new Error("input too long");
          return {
            embeddings: values.map(() => Array.from({ length: DIM }, () => 0.1)),
            dimension: DIM,
          };
        },
      })
    );

    // One batch attempt, then one call per row.
    expect(calls).toEqual([3, 1, 1, 1]);
    expect(result.embedded).toBe(2);
    const left = await db.query("SELECT content FROM knowledge_chunks WHERE embedding IS NULL");
    expect(left.rows.map((r) => r.content)).toEqual(["POISON"]);
  });

  async function seedSourceRecord(): Promise<void> {
    await db.query(
      `INSERT INTO knowledge_source_records
         (source_id, business_id, integration_id, provider, external_id, external_tenant_id,
          owner_external_id, revision, status, verification, access_control_mode,
          access_control_max_age_seconds, provenance_captured_at, provenance_content_hash,
          last_synced_at, created_at, updated_at)
       VALUES ('s1', 'b1', 'i1', 'slack', 'e1', 't1', 'o1', 'r1', 'active', 'verified',
               'snapshot', 3600, now(), 'h1', now(), now(), now())`
    );
  }

  async function seedPage(): Promise<string> {
    const { rows } = await db.query(
      `INSERT INTO knowledge_pages
         (id, title, content, plain_text, source, source_id, created_at, updated_at)
       VALUES (gen_random_uuid(), 'p', 'body', 'body', 'manual', 's1', now(), now())
       RETURNING id`
    );
    return rows[0].id as string;
  }
});
