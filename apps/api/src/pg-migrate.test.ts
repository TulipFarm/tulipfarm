import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "./pg-migrate";
import { makePglite } from "./test/pglite";

describe("runPgMigrations — 001_init + 002_knowledge + 003_stream_resume + 004_approvals + 005_conversation_title + 006_message_feedback + 007_conversation_starred on PGlite", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makePglite();
  });

  afterEach(async () => {
    await db.close();
  });

  it("advances schema_version to the latest (7)", async () => {
    await runPgMigrations(db);
    const res = await db.query<{ version: number }>("SELECT version FROM schema_version");
    expect(res.rows.map((r) => Number(r.version))).toEqual([7]);
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
      "api_tokens",
      "approvals",
      "conversations",
      "counters",
      "knowledge_chunks",
      "knowledge_collections",
      "knowledge_documents",
      "knowledge_documents_collections",
      "knowledge_revisions",
      "message_feedback",
      "messages",
      "rate_limits",
      "schema_version",
      "secrets",
      "sessions",
      "stream_resume",
      "users",
      "working_memory",
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

  it("is idempotent — a second run does not throw and leaves version at 7", async () => {
    await runPgMigrations(db);
    await runPgMigrations(db);
    const res = await db.query<{ version: number }>("SELECT version FROM schema_version");
    expect(res.rows.map((r) => Number(r.version))).toEqual([7]);
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
});
