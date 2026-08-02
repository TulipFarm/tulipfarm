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
    // A stand-in for a database that stopped at 14, holding only what the later migrations touch.
    await db.query("CREATE TABLE conversations (id uuid PRIMARY KEY)");
    await db.query("CREATE TABLE messages (id uuid PRIMARY KEY)");
    await db.query("CREATE TABLE users (id uuid PRIMARY KEY)");
    await db.query("CREATE TABLE run_events (run_id uuid NOT NULL, sequence bigint NOT NULL)");
    await db.query(`CREATE TABLE api_clients (
      id            uuid PRIMARY KEY,
      owner_user_id uuid NOT NULL REFERENCES users(id)
    )`);
    await db.query(`CREATE TABLE external_identity_mappings (
      provider         text NOT NULL,
      external_subject text NOT NULL,
      user_id          uuid NOT NULL REFERENCES users(id),
      PRIMARY KEY (provider, external_subject)
    )`);
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

  describe("migration 17", () => {
    beforeEach(async () => {
      await runPgMigrations(db, undefined, () => {});
    });

    it("keys a Turn completion by attempt, not by Turn", async () => {
      // A Worker killed mid-turn is retried under a new attempt. Keyed by Turn alone, that retry
      // would collide with the dead attempt's row and the turn could never complete.
      const key = await db.query<{ column_name: string }>(`SELECT key_column.column_name
        FROM information_schema.table_constraints AS constraints
        JOIN information_schema.key_column_usage AS key_column
          ON key_column.constraint_name = constraints.constraint_name
        WHERE constraints.table_name = 'turn_completions'
          AND constraints.constraint_type = 'PRIMARY KEY'
        ORDER BY key_column.ordinal_position`);
      expect(key.rows.map((row) => row.column_name)).toEqual(["turn_id", "attempt"]);
    });

    it("refuses to bind one channel sender to two accounts", async () => {
      const insertUser = (id: string, email: string) =>
        db.query(
          `INSERT INTO users (id, email, password_hash, role, created_at)
           VALUES ($1, $2, 'hash', 'member', now())`,
          [id, email]
        );
      const first = "11111111-1111-4111-8111-111111111111";
      const second = "22222222-2222-4222-8222-222222222222";
      await insertUser(first, "first@example.com");
      await insertUser(second, "second@example.com");

      // Channels bind through `external_identity_mappings` like every other external subject, with
      // the integration slug as the provider — `verified_via` is what migration 17 adds.
      const link = (userId: string) =>
        db.query(
          `INSERT INTO external_identity_mappings
             (provider, external_subject, user_id, verified_at, verified_via)
           VALUES ('slack', 'U1', $1, now(), 'manifest_email')`,
          [userId]
        );
      await link(first);
      // An inbound Slack message resolves to exactly one person or to nobody — never to whichever
      // row a query happened to return first.
      await expect(link(second)).rejects.toThrow();
    });

    it("registers the Run event notification trigger", async () => {
      const triggers = await db.query<{ trigger_name: string }>(
        `SELECT trigger_name FROM information_schema.triggers
          WHERE event_object_table = 'run_events' AND trigger_name = 'run_events_notify'`
      );
      expect(triggers.rows).toHaveLength(1);
    });
  });

  describe("migration 19", () => {
    it("lets a client be owned by the deployment rather than a person", async () => {
      // The `run-executor` client is minted on first boot, before the wizard has made a user.
      await runPgMigrations(db, undefined, () => {});

      const column = await db.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'api_clients' AND column_name = 'owner_user_id'`
      );
      expect(column.rows[0]?.is_nullable).toBe("YES");
    });
  });

  describe("migration 20", () => {
    it("installs durable Soul publication and immutable bundle storage", async () => {
      await runPgMigrations(db, undefined, () => {});

      const tables = await db.query<{ table_name: string }>(`SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (
            'soul_publications',
            'soul_publication_outbox',
            'soul_definition_projections',
            'soul_active_bundles',
            'soul_execution_bundles'
          )
        ORDER BY table_name`);
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "soul_active_bundles",
        "soul_definition_projections",
        "soul_execution_bundles",
        "soul_publication_outbox",
        "soul_publications",
      ]);
    });
  });
});
