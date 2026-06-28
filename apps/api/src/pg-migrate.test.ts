import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "./pg-migrate";
import { makePglite } from "./test/pglite";

describe("runPgMigrations — 001_init + 002_knowledge + 003_stream_resume + 004_approvals + 005_conversation_title + 006_message_feedback + 007_conversation_starred + 008_hitl + 009_kv_store + 010_wrapped_deks + 011_okf + 012_okf_crosslinks + 013_drop_bundle_domain + 014_drop_okf_type + 015_title_tsv + 016_doc_type + 017_pg_trgm + 018_terminology_rename + 019_chunk_content_hash + 020_knowledge_connectors + 021_activity_log + 022_obs_event on PGlite", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makePglite();
  });

  afterEach(async () => {
    await db.close();
  });

  it("advances schema_version to the latest (22)", async () => {
    await runPgMigrations(db);
    const res = await db.query<{ version: number }>("SELECT version FROM schema_version");
    expect(res.rows.map((r) => Number(r.version))).toEqual([22]);
  });

  it("creates the vector and citext extensions", async () => {
    await runPgMigrations(db);
    const res = await db.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector', 'citext') ORDER BY extname"
    );
    expect(res.rows.map((r) => r.extname)).toEqual(["citext", "vector"]);
  });

  it("creates the public tables for both migrations (no pgboss)", async () => {
    await runPgMigrations(db);
    const res = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );
    expect(res.rows.map((r) => r.table_name)).toEqual([
      "a2ui_surfaces",
      "activity_log",
      "api_tokens",
      "approvals",
      "conversations",
      "counters",
      "knowledge_chunks",
      "knowledge_connectors",
      "knowledge_links",
      "knowledge_pages",
      "knowledge_revisions",
      "knowledge_space_overrides",
      "knowledge_spaces",
      "kv_store",
      "message_feedback",
      "messages",
      "obs_event",
      "pending_interactions",
      "rate_limits",
      "schema_version",
      "secrets",
      "sessions",
      "stream_resume",
      "users",
      "working_memory",
      "wrapped_deks",
    ]);
  });

  it("creates the resources schema", async () => {
    await runPgMigrations(db);
    const res = await db.query<{ schema_name: string }>(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'resources'"
    );
    expect(res.rows.map((r) => r.schema_name)).toEqual(["resources"]);
  });

  it("creates the keyset + LRU indexes", async () => {
    await runPgMigrations(db);
    const res = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('messages_conversation_created_idx', 'working_memory_lru_idx') ORDER BY indexname"
    );
    expect(res.rows.map((r) => r.indexname)).toEqual([
      "messages_conversation_created_idx",
      "working_memory_lru_idx",
    ]);
  });

  it("is idempotent — a second run does not throw and leaves version at 22", async () => {
    await runPgMigrations(db);
    await runPgMigrations(db);
    const res = await db.query<{ version: number }>("SELECT version FROM schema_version");
    expect(res.rows.map((r) => Number(r.version))).toEqual([22]);
  });

  it("adds knowledge_pages.title_tsv (generated tsvector) + its GIN index (015, renamed by 018)", async () => {
    await runPgMigrations(db);
    const col = await db.query<{ column_name: string; is_generated: string }>(
      "SELECT column_name, is_generated FROM information_schema.columns WHERE table_name = 'knowledge_pages' AND column_name = 'title_tsv'"
    );
    expect(col.rows.map((r) => r.column_name)).toEqual(["title_tsv"]);
    expect(col.rows[0]?.is_generated).toBe("ALWAYS");
    const idx = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'knowledge_pages_title_tsv_gin'"
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual(["knowledge_pages_title_tsv_gin"]);
  });

  it("re-adds knowledge_pages.type + its index, backfilled from frontmatter_extra (016, renamed by 018)", async () => {
    await runPgMigrations(db);
    const col = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'knowledge_pages' AND column_name = 'type'"
    );
    expect(col.rows.map((r) => r.column_name)).toEqual(["type"]);
    const idx = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'knowledge_pages_type_idx'"
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual(["knowledge_pages_type_idx"]);
  });

  it("creates the pg_trgm extension + title trigram index (017, renamed by 018)", async () => {
    await runPgMigrations(db);
    const ext = await db.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'"
    );
    expect(ext.rows.map((r) => r.extname)).toEqual(["pg_trgm"]);
    const idx = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'knowledge_pages_title_trgm'"
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual(["knowledge_pages_title_trgm"]);
  });

  it("retires the legacy collections tables (018)", async () => {
    await runPgMigrations(db);
    const res = await db.query<{ t: string | null }>(
      "SELECT to_regclass('knowledge_collections') AS a, to_regclass('knowledge_documents_collections') AS b"
    );
    expect(res.rows[0]).toEqual({ a: null, b: null });
  });

  it("adds the conversations.title column and the user/updated_at index (005)", async () => {
    await runPgMigrations(db);
    const col = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'conversations' AND column_name = 'title'"
    );
    expect(col.rows.map((r) => r.column_name)).toEqual(["title"]);
    const idx = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'conversations_user_updated_idx'"
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual(["conversations_user_updated_idx"]);
  });

  it("adds the conversations.starred column defaulting to false (007)", async () => {
    await runPgMigrations(db);
    const col = await db.query<{ column_name: string; column_default: string }>(
      "SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'conversations' AND column_name = 'starred'"
    );
    expect(col.rows.map((r) => r.column_name)).toEqual(["starred"]);
    expect(col.rows[0]?.column_default).toContain("false");
  });

  it("enforces the conversations owner CHECK", async () => {
    await runPgMigrations(db);
    // No user_id and no agent_id → CHECK violation.
    await expect(
      db.query(
        "INSERT INTO conversations (id, created_at, updated_at) VALUES (gen_random_uuid(), now(), now())"
      )
    ).rejects.toThrow();
    // With an owner → accepted.
    await expect(
      db.query(
        "INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES (gen_random_uuid(), gen_random_uuid(), now(), now())"
      )
    ).resolves.toBeDefined();
  });

  it("creates kv_store and its namespace index (009)", async () => {
    await runPgMigrations(db);
    const tbl = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'kv_store'"
    );
    expect(tbl.rows.map((r) => r.table_name)).toEqual(["kv_store"]);
    const idx = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'kv_store_owner_ns_idx'"
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual(["kv_store_owner_ns_idx"]);
  });

  it("system rows upsert in place via the '' owner sentinel (ON CONFLICT fires)", async () => {
    await runPgMigrations(db);
    const insert = (val: string) =>
      db.query(
        `INSERT INTO kv_store (scope, owner_id, namespace, key, value, created_at, updated_at)
         VALUES ('system', '', 'cfg', 'flag', $1::jsonb, now(), now())
         ON CONFLICT (scope, owner_id, namespace, key) DO UPDATE SET value = EXCLUDED.value`,
        [val]
      );
    await insert('"a"');
    await insert('"b"'); // would duplicate (not update) if NULL/sentinel handling were wrong
    const res = await db.query<{ n: number; value: unknown }>(
      "SELECT count(*)::int AS n, max(value::text) AS value FROM kv_store WHERE scope = 'system'"
    );
    expect(Number(res.rows[0]?.n)).toBe(1);
    expect(res.rows[0]?.value).toBe('"b"');
  });

  it("enforces the kv_store scope CHECK", async () => {
    await runPgMigrations(db);
    await expect(
      db.query(
        "INSERT INTO kv_store (scope, owner_id, namespace, key, value, created_at, updated_at) VALUES ('bogus', 'o', 'n', 'k', '1'::jsonb, now(), now())"
      )
    ).rejects.toThrow();
  });

  it("enforces the kv_store system<=>'' owner CHECK both ways", async () => {
    await runPgMigrations(db);
    // system scope must have an empty owner.
    await expect(
      db.query(
        "INSERT INTO kv_store (scope, owner_id, namespace, key, value, created_at, updated_at) VALUES ('system', 'someone', 'n', 'k', '1'::jsonb, now(), now())"
      )
    ).rejects.toThrow();
    // non-system scope must have a non-empty owner.
    await expect(
      db.query(
        "INSERT INTO kv_store (scope, owner_id, namespace, key, value, created_at, updated_at) VALUES ('user', '', 'n', 'k', '1'::jsonb, now(), now())"
      )
    ).rejects.toThrow();
  });

  it("creates activity_log and its keyset + category indexes (021)", async () => {
    await runPgMigrations(db);
    const tbl = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'activity_log'"
    );
    expect(tbl.rows.map((r) => r.table_name)).toEqual(["activity_log"]);
    const idx = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE indexname IN ('activity_log_created_idx', 'activity_log_category_created_idx') ORDER BY indexname"
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual([
      "activity_log_category_created_idx",
      "activity_log_created_idx",
    ]);
  });

  it("creates wrapped_deks, its active-label index, and the secrets.dek_id column (010)", async () => {
    await runPgMigrations(db);
    const tbl = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'wrapped_deks'"
    );
    expect(tbl.rows.map((r) => r.table_name)).toEqual(["wrapped_deks"]);
    const idx = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'wrapped_deks_active_label_idx'"
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual(["wrapped_deks_active_label_idx"]);
    const col = await db.query<{ column_name: string; is_nullable: string }>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'secrets' AND column_name = 'dek_id'"
    );
    expect(col.rows.map((r) => r.column_name)).toEqual(["dek_id"]);
    expect(col.rows[0]?.is_nullable).toBe("YES");
  });

  it("enforces the wrapped_deks kek_label CHECK", async () => {
    await runPgMigrations(db);
    await expect(
      db.query(
        `INSERT INTO wrapped_deks (dek_id, kek_label, encrypted_value, iv, auth_tag, created_at)
         VALUES (gen_random_uuid(), 'bogus', 'c', 'i', 't', now())`
      )
    ).rejects.toThrow();
  });

  it("forbids two active wraps with the same kek_label (partial unique index)", async () => {
    await runPgMigrations(db);
    const insertEnv = (dek: string) =>
      db.query(
        `INSERT INTO wrapped_deks (dek_id, kek_label, encrypted_value, iv, auth_tag, created_at)
         VALUES ($1, 'env', 'c', 'i', 't', now())`,
        [dek]
      );
    await insertEnv("11111111-1111-1111-1111-111111111111");
    await expect(insertEnv("22222222-2222-2222-2222-222222222222")).rejects.toThrow();
  });
});
