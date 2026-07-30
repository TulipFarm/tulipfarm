import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "./pg-migrate";
import { PG_MIGRATIONS } from "./pg-migrations";
import { makePglite } from "./test/pglite";

describe("runPgMigrations", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makePglite();
  });

  afterEach(async () => {
    await db.close();
  });

  it("repairs Surface storage for databases that already recorded schema version 14", async () => {
    await db.query("CREATE TABLE conversations (id uuid PRIMARY KEY)");
    await db.query("CREATE TABLE messages (id uuid PRIMARY KEY)");
    await db.query(`CREATE TABLE schema_version (
      id boolean PRIMARY KEY DEFAULT true,
      version integer NOT NULL,
      CONSTRAINT schema_version_single_row CHECK (id)
    )`);
    await db.query("INSERT INTO schema_version (id, version) VALUES (true, 14)");

    await runPgMigrations(db, undefined, () => {});

    const version = await db.query<{ version: number }>(
      "SELECT version FROM schema_version WHERE id = true"
    );
    const latest = Math.max(...PG_MIGRATIONS.map((migration) => migration.version));
    expect(Number(version.rows[0]?.version)).toBe(latest);

    const tables = await db.query<{ table_name: string }>(`SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('surface_actions', 'surface_deliveries')
      ORDER BY table_name`);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "surface_actions",
      "surface_deliveries",
    ]);
  });
});
