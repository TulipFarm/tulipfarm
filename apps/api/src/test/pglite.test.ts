import type { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { PG_MIGRATIONS } from "../pg-migrations";
import { makeMigratedPglite } from "./pglite";

const databases: PGlite[] = [];

async function database(version: number): Promise<PGlite> {
  const db = await makeMigratedPglite(version);
  databases.push(db);
  return db;
}

afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
  vi.restoreAllMocks();
});

describe("historical PGlite snapshots", () => {
  it("shares a concurrent snapshot build but restores independent databases", async () => {
    const migration = PG_MIGRATIONS.find(({ version }) => version === 2);
    if (!migration) throw new Error("migration 2 missing");
    const apply = vi.spyOn(migration, "up");
    const [first, second] = await Promise.all([database(2), database(2)]);
    expect(apply).toHaveBeenCalledTimes(1);
    await first.query("CREATE TABLE snapshot_isolation (id integer)");
    expect(
      (await second.query("SELECT to_regclass('snapshot_isolation') AS isolated")).rows
    ).toEqual([{ isolated: null }]);
    const third = await database(2);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(
      (await third.query("SELECT to_regclass('snapshot_isolation') AS isolated")).rows
    ).toEqual([{ isolated: null }]);
  });

  it("restores real prerequisites, upgrades strictly, and leaves the historical cache unchanged", async () => {
    const db = await database(111);
    const historicalShape = `
      SELECT
        (SELECT version FROM schema_version WHERE id = true) AS version,
        to_regclass('api_clients') IS NOT NULL AS api_clients,
        to_regclass('deployment_runtime_identity') IS NOT NULL AS runtime_identity,
        to_regclass('schema_migrations') IS NOT NULL AS ledger,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'api_clients' AND column_name = 'operational_scope'
        ) AS operational_scope
    `;
    const expected = [
      {
        version: 111,
        api_clients: true,
        runtime_identity: false,
        ledger: false,
        operational_scope: false,
      },
    ];
    expect((await db.query(historicalShape)).rows).toEqual(expected);

    await runPgMigrations(
      db,
      (code) => {
        throw new Error(`migration exited with ${code}`);
      },
      () => {}
    );
    expect(
      (
        await db.query(
          "SELECT version, description, duration_ms FROM schema_migrations WHERE version = 111"
        )
      ).rows
    ).toEqual([{ version: 111, description: "pre-ledger baseline", duration_ms: null }]);
    expect((await db.query(historicalShape)).rows).toEqual([
      {
        version: Math.max(...PG_MIGRATIONS.map(({ version }) => version)),
        api_clients: true,
        runtime_identity: true,
        ledger: true,
        operational_scope: true,
      },
    ]);
    expect((await (await database(111)).query(historicalShape)).rows).toEqual(expected);
  });

  it("keeps neighboring versions in separate snapshots", async () => {
    const before = await database(133);
    const after = await database(134);
    const query = "SELECT to_regclass('deployment_runtime_identity') IS NOT NULL AS present";
    expect((await before.query(query)).rows).toEqual([{ present: false }]);
    expect((await after.query(query)).rows).toEqual([{ present: true }]);
  });

  it("does not retain a failed snapshot build", async () => {
    const migration = PG_MIGRATIONS.find(({ version }) => version === 3);
    if (!migration) throw new Error("migration 3 missing");
    const apply = vi.spyOn(migration, "up").mockRejectedValueOnce(new Error("snapshot failure"));
    await expect(database(3)).rejects.toThrow("snapshot failure");
    const restored = await database(3);
    expect(apply).toHaveBeenCalledTimes(2);
    expect((await restored.query("SELECT version FROM schema_version")).rows).toEqual([
      { version: 3 },
    ]);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])(
    "rejects invalid migration version %s",
    async (version) => {
      await expect(makeMigratedPglite(version)).rejects.toThrow(RangeError);
    }
  );
});
