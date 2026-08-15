import type { PGlite } from "@electric-sql/pglite";
import { EngineMemoryRepo } from "@tulipfarm/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { PG_MIGRATIONS } from "../pg-migrations/index";
import { makePglite } from "../test/pglite";

/** Simulate v33 upgrade by seeding legacy rows before the irreversible backfill. */

/** The Memory cutover migration, and the version a database sits at just before it. */
const MEMORY_MIGRATION = 33;
const PRE_CUTOVER = MEMORY_MIGRATION - 1;

const NOOP = (): void => {};
const FAIL_ON_EXIT = (code: number): never => {
  throw new Error(`migration runner exited with ${code}`);
};

const USER_A = "44444444-4444-4444-4444-444444444444";
const USER_B = "55555555-5555-5555-5555-555555555555";

/** Apply every migration below the Memory cutover, leaving the pre-cutover schema in place. */
async function migrateToPreCutover(db: PGlite): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_version (
    id boolean PRIMARY KEY DEFAULT true,
    version integer NOT NULL,
    CONSTRAINT schema_version_single_row CHECK (id)
  )`);
  await db.query(
    "INSERT INTO schema_version (id, version) VALUES (true, 0) ON CONFLICT (id) DO NOTHING"
  );
  for (const migration of [...PG_MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (migration.version >= MEMORY_MIGRATION) break;
    await migration.up(db);
  }
  await db.query("UPDATE schema_version SET version = $1 WHERE id = true", [PRE_CUTOVER]);
}

describe("migration v33 working_memory backfill", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makePglite();
    await migrateToPreCutover(db);
  });

  afterEach(async () => {
    await db.close();
  });

  async function seed(
    userId: string,
    key: string,
    value: string,
    agentId: string | null = null
  ): Promise<void> {
    await db.query(
      `INSERT INTO working_memory (user_id, key, value, written_by_agent_id, created_at, last_written_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        key,
        value,
        agentId,
        new Date("2024-01-01T00:00:00.000Z"),
        new Date("2024-02-01T00:00:00.000Z"),
      ]
    );
  }

  it("carries every legacy entry across as a confirmed user_private preference", async () => {
    await seed(USER_A, "fav-color", "blue", "agent-x");
    await seed(USER_A, "timezone", "Asia/Kolkata");
    await seed(USER_B, "fav-color", "green");

    await runPgMigrations(db, FAIL_ON_EXIT, NOOP);

    const { rows } = await db.query<{
      subject_principal_id: string;
      subject: string;
      statement: string;
      scope: string;
      memory_type: string;
      trust_tier: string;
      confirmation: string;
      status: string;
      version: number;
      author_agent_id: string | null;
      created_at: Date;
      updated_at: Date;
      valid_from: Date;
    }>("SELECT * FROM memory_assertions ORDER BY subject_principal_id, subject");

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.subject_principal_id, r.subject, r.statement])).toEqual([
      [USER_A, "fav-color", "blue"],
      [USER_A, "timezone", "Asia/Kolkata"],
      [USER_B, "fav-color", "green"],
    ]);
    for (const row of rows) {
      expect(row.scope).toBe("user_private");
      expect(row.memory_type).toBe("preference");
      expect(row.trust_tier).toBe("user_stated");
      expect(row.confirmation).toBe("confirmed");
      expect(row.status).toBe("active");
      expect(row.version).toBe(1);
      // Timestamps carry over, so nothing looks newly written after the upgrade.
      expect(row.created_at.toISOString()).toBe("2024-01-01T00:00:00.000Z");
      expect(row.updated_at.toISOString()).toBe("2024-02-01T00:00:00.000Z");
      expect(row.valid_from.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    }
    // Attribution survives — a fact the assistant saved must not read as user-authored.
    expect(rows[0].author_agent_id).toBe("agent-x");
    expect(rows[1].author_agent_id).toBeNull();
  });

  it("leaves the legacy table intact so the cutover stays recoverable", async () => {
    await seed(USER_A, "k", "v");
    await runPgMigrations(db, FAIL_ON_EXIT, NOOP);
    const { rows } = await db.query("SELECT * FROM working_memory");
    expect(rows).toHaveLength(1);
  });

  it("is replay-safe: re-running the backfill does not duplicate entries", async () => {
    await seed(USER_A, "k", "v");
    await runPgMigrations(db, FAIL_ON_EXIT, NOOP);

    // Force the migration to run a second time, as a partially-failed upgrade would.
    await db.query("UPDATE schema_version SET version = $1 WHERE id = true", [PRE_CUTOVER]);
    await runPgMigrations(db, FAIL_ON_EXIT, NOOP);

    const { rows } = await db.query("SELECT * FROM memory_assertions");
    expect(rows).toHaveLength(1);
  });

  it("does not resurrect an entry the user deleted after the upgrade", async () => {
    await seed(USER_A, "k", "v");
    await runPgMigrations(db, FAIL_ON_EXIT, NOOP);

    const repo = new EngineMemoryRepo(db);
    expect(await repo.deleteByKey(USER_A, "k")).toBe(true);

    // The legacy row still exists, so a replayed backfill must not bring the entry back.
    await db.query("UPDATE schema_version SET version = $1 WHERE id = true", [PRE_CUTOVER]);
    await runPgMigrations(db, FAIL_ON_EXIT, NOOP);

    expect(await repo.listByUser(USER_A)).toHaveLength(0);
  });

  it("hands the backfilled entries straight to the KV surface", async () => {
    await seed(USER_A, "fav-color", "blue", "agent-x");
    await runPgMigrations(db, FAIL_ON_EXIT, NOOP);

    const entries = await new EngineMemoryRepo(db).listByUser(USER_A);
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe("fav-color");
    expect(entries[0].value).toBe("blue");
    expect(entries[0].writtenByAgentId).toBe("agent-x");
    expect(entries[0].createdAt.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(entries[0].lastWrittenAt.toISOString()).toBe("2024-02-01T00:00:00.000Z");
  });
});
