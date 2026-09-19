import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MCP_SETUP_STORAGE_STATEMENTS } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makeMigratedPglite } from "../test/pglite";
import { PG_MIGRATIONS } from "./index";

const script = readFileSync(
  resolve(process.cwd(), "../../scripts/test/lib/runtime-foundation.sh"),
  "utf8"
);
const columns = `SELECT table_name, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
  ORDER BY table_name, column_name`;

describe("Compose legacy upgrade fixture", () => {
  it("preserves MCP setup data when an unmerged checkout used Knowledge's migration number", async () => {
    const db = await makeMigratedPglite(139);
    try {
      await db.exec("DROP TABLE file_knowledge_requests");
      for (const statement of MCP_SETUP_STORAGE_STATEMENTS) await db.exec(statement);
      await db.exec(`INSERT INTO mcp_setup_operations
        (business_id, id, principal_id, integration_key, document)
        VALUES ('business', 'setup', 'user', 'github', '{"marker":"preserved"}')`);
      const exit = vi.fn();
      await runPgMigrations(db, exit, () => {});
      expect(exit).not.toHaveBeenCalled();
      expect(
        (await db.query("SELECT to_regclass('file_knowledge_requests') IS NOT NULL AS present"))
          .rows
      ).toEqual([{ present: true }]);
      expect((await db.query("SELECT document FROM mcp_setup_operations")).rows).toEqual([
        { document: { marker: "preserved" } },
      ]);
      await runPgMigrations(db, exit, () => {});
      expect(exit).not.toHaveBeenCalled();
    } finally {
      await db.close();
    }
  });

  it("matches the real v133 schema before upgrading the current candidate", async () => {
    const version = Math.max(...PG_MIGRATIONS.map((migration) => migration.version));
    expect(script).toContain(`"SELECT version FROM schema_version")" = ${version} ]`);
    const sql = script.match(/<<'SQL'\n([\s\S]*?)\nSQL/)?.[1];
    if (!sql) throw new Error("Missing isolated Compose fixture SQL");
    const db = await makeMigratedPglite();
    const legacy = await makeMigratedPglite(133);
    try {
      // Shared principal DDL now includes v136's column even in the historical migration prefix.
      await legacy.exec("ALTER TABLE principals DROP COLUMN operational_scope");
      const currentColumns = (await db.query(columns)).rows;
      await db.exec(sql);
      expect((await db.query(columns)).rows).toEqual((await legacy.query(columns)).rows);
      expect((await db.query("SELECT version FROM schema_version")).rows).toEqual([
        { version: 133 },
      ]);
      const exit = vi.fn();
      await runPgMigrations(db, exit, () => {});
      expect(exit).not.toHaveBeenCalled();
      expect((await db.query(columns)).rows).toEqual(currentColumns);
      expect((await db.query("SELECT version FROM schema_version")).rows).toEqual([{ version }]);
    } finally {
      await db.close();
      await legacy.close();
    }
  });
});
