import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type PgTestClient,
  type PgTestPool,
  withTestSchema,
  withTestTransaction,
} from "./postgres";

class PGlitePool implements PgTestPool {
  constructor(private readonly database: PGlite) {}

  async connect(): Promise<PgTestClient> {
    return {
      query: (text, params) => this.database.query<Record<string, unknown>>(text, params),
      release: () => undefined,
    };
  }
}

describe("PostgreSQL test isolation helpers", () => {
  let database: PGlite;
  let pool: PGlitePool;

  beforeEach(async () => {
    database = await PGlite.create();
    pool = new PGlitePool(database);
  }, 30_000);

  afterEach(async () => {
    await database.close();
  }, 30_000);

  it("rolls back data written by a successful test", async () => {
    await database.exec("CREATE TABLE records (id integer PRIMARY KEY)");

    await withTestTransaction(pool, async (client) => {
      await client.query("INSERT INTO records (id) VALUES (1)");
    });

    const result = await database.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM records"
    );
    expect(result.rows).toEqual([{ count: 0 }]);
  });

  it("sets the test search path and removes the schema after use", async () => {
    await withTestSchema(pool, "worker_1_postgres", async (client) => {
      await client.query("CREATE TABLE marker (id integer PRIMARY KEY)");
      await client.query("INSERT INTO marker (id) VALUES (1)");
      const result = await client.query("SELECT current_schema() AS schema");
      expect(result.rows).toEqual([{ schema: "worker_1_postgres" }]);
    });

    const result = await database.query<{ schema_name: string }>(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1",
      ["worker_1_postgres"]
    );
    expect(result.rows).toEqual([]);
  });
});
