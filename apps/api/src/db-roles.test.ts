import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "./db";
import {
  describeSeparation,
  hasOperatorSeparation,
  migrationConnectionString,
  provisionRuntimeRole,
  RUNTIME_ROLE,
  runtimeConnectionOptions,
} from "./db-roles";

describe("db-roles", () => {
  let pg: PGlite;
  let db: Queryable;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    pg = new PGlite();
    db = { query: (text, params) => pg.query(text, params as never[]) as never };
    process.env.DATABASE_URL = "postgres://app@localhost/app";
    // `delete`, not `= undefined` — assignment would store the literal string "undefined".
    delete process.env.DATABASE_URL_MIGRATIONS;
  });

  afterEach(async () => {
    process.env = { ...savedEnv };
    await pg.close();
  });

  describe("connection selection", () => {
    it("uses DATABASE_URL for migrations when no override is set", () => {
      expect(migrationConnectionString()).toBe("postgres://app@localhost/app");
      expect(hasOperatorSeparation()).toBe(false);
    });

    it("prefers DATABASE_URL_MIGRATIONS and treats it as operator-owned separation", () => {
      process.env.DATABASE_URL_MIGRATIONS = "postgres://owner@localhost/app";
      expect(migrationConnectionString()).toBe("postgres://owner@localhost/app");
      expect(hasOperatorSeparation()).toBe(true);
    });

    it("does not claim separation when the two URLs are identical", () => {
      process.env.DATABASE_URL_MIGRATIONS = process.env.DATABASE_URL;
      expect(hasOperatorSeparation()).toBe(false);
    });
  });

  describe("provisioning", () => {
    it("creates the runtime role and reports managed mode", async () => {
      const separation = await provisionRuntimeRole(db);

      expect(separation).toEqual({ mode: "managed", role: RUNTIME_ROLE });
      const { rows } = await db.query(
        "SELECT rolsuper, rolcanlogin FROM pg_roles WHERE rolname=$1",
        [RUNTIME_ROLE]
      );
      expect(rows).toHaveLength(1);
      // A role that could log in, or that kept superuser, would defeat the entire point.
      expect(rows[0]).toMatchObject({ rolsuper: false, rolcanlogin: false });
    });

    it("falls back to single-role when the connecting role may create roles but not grant", async () => {
      // The gap this closes: `CREATEROLE` without *ownership* of the tables. Common on managed
      // Postgres, and the PG15+ default for `public`. Such a role passes the CREATEROLE check and
      // then fails partway through the grants — which, propagated, aborts boot *after* migrations
      // have already committed. Falling back keeps the deployment running.
      const failing: Queryable = {
        query: async (text: string, params?: unknown[]) => {
          if (text.startsWith("GRANT ALL PRIVILEGES")) {
            throw Object.assign(new Error("permission denied for table knowledge_chunks"), {
              code: "42501",
            });
          }
          return db.query(text, params);
        },
      };

      const separation = await provisionRuntimeRole(failing);

      expect(separation.mode).toBe("single");
      expect(describeSeparation(separation)).toContain("UNAVAILABLE");
    });

    it("still propagates failures that are not privilege errors", async () => {
      const failing: Queryable = {
        query: async (text: string, params?: unknown[]) => {
          if (text.startsWith("GRANT ALL PRIVILEGES")) throw new Error("connection terminated");
          return db.query(text, params);
        },
      };

      await expect(provisionRuntimeRole(failing)).rejects.toThrow("connection terminated");
    });

    it("grants read-only access to the pgboss schema, including tables added later", async () => {
      // `makeIndexQueueStats` reads the failed-job row from `pgboss` through the runtime pool.
      // Without this the read fails 42501, its own `catch` swallows it, and the diagnostic says
      // "no errors" forever. `ALL TABLES` alone is not enough: pg-boss adds a partition table per
      // queue, so default privileges must cover the ones that do not exist yet.
      await db.query("CREATE SCHEMA pgboss");
      await db.query("CREATE TABLE pgboss.job (id int)");

      await provisionRuntimeRole(db);
      await db.query("CREATE TABLE pgboss.j_added_later (id int)");

      for (const table of ["pgboss.job", "pgboss.j_added_later"]) {
        const { rows } = await db.query(
          "SELECT has_table_privilege($1, $2, 'SELECT') AS ok, has_table_privilege($1, $2, 'INSERT') AS writable",
          [RUNTIME_ROLE, table]
        );
        expect(rows[0]).toMatchObject({ ok: true, writable: false });
      }
    });

    it("is idempotent, because it re-runs on every boot to cover newly migrated tables", async () => {
      await provisionRuntimeRole(db);
      await expect(provisionRuntimeRole(db)).resolves.toEqual({
        mode: "managed",
        role: RUNTIME_ROLE,
      });
    });

    it("grants access to tables that already exist", async () => {
      await db.query("CREATE TABLE widgets (id int primary key)");
      await provisionRuntimeRole(db);

      const { rows } = await db.query("SELECT has_table_privilege($1, 'widgets', 'INSERT') AS ok", [
        RUNTIME_ROLE,
      ]);
      expect(rows[0]?.ok).toBe(true);
    });

    it("grants CREATE on the resources schema, which the app populates at runtime", async () => {
      await db.query("CREATE SCHEMA resources");
      await provisionRuntimeRole(db);

      const { rows } = await db.query(
        "SELECT has_schema_privilege($1, 'resources', 'CREATE') AS ok",
        [RUNTIME_ROLE]
      );
      expect(rows[0]?.ok).toBe(true);
    });

    it("skips schemas that do not exist yet rather than failing the boot", async () => {
      // `resources` is created by a migration; a database mid-history simply has fewer schemas.
      await expect(provisionRuntimeRole(db)).resolves.toMatchObject({ mode: "managed" });
    });

    it("defers to the operator instead of provisioning when they split the URLs", async () => {
      process.env.DATABASE_URL_MIGRATIONS = "postgres://owner@localhost/app";

      expect(await provisionRuntimeRole(db)).toEqual({ mode: "operator" });
      const { rows } = await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [RUNTIME_ROLE]);
      expect(rows).toHaveLength(0);
    });

    it("falls back to single-role when the connecting role cannot create roles", async () => {
      // Managed Postgres commonly withholds CREATEROLE. Booting must still succeed.
      const restricted: Queryable = {
        query: async (text, params) =>
          text.includes("rolcreaterole")
            ? { rows: [{ can_provision: false }] }
            : ((await pg.query(text, params as never[])) as never),
      };

      const separation = await provisionRuntimeRole(restricted);

      expect(separation).toMatchObject({ mode: "single" });
      expect(describeSeparation(separation)).toContain("UNAVAILABLE");
      const { rows } = await pg.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [RUNTIME_ROLE]);
      expect(rows).toHaveLength(0);
    });
  });

  describe("privilege enforcement", () => {
    it("blocks UPDATE and DELETE on a revoked table while leaving INSERT working", async () => {
      // The whole reason the role exists: proving REVOKE binds a session that assumed it, even
      // though the underlying login role is a superuser.
      await db.query("CREATE TABLE audit_events (id int primary key, payload text)");
      await db.query("INSERT INTO audit_events VALUES (1, 'original')");
      await provisionRuntimeRole(db);
      await db.query(`REVOKE UPDATE, DELETE ON audit_events FROM ${RUNTIME_ROLE}`);

      await db.query(`SET ROLE ${RUNTIME_ROLE}`);
      try {
        await expect(
          db.query("INSERT INTO audit_events VALUES (2, 'appended')")
        ).resolves.toBeDefined();
        await expect(db.query("UPDATE audit_events SET payload='tampered'")).rejects.toThrow(
          /permission denied/
        );
        await expect(db.query("DELETE FROM audit_events")).rejects.toThrow(/permission denied/);
      } finally {
        await db.query("RESET ROLE");
      }

      const { rows } = await db.query("SELECT payload FROM audit_events WHERE id=1");
      expect(rows[0]?.payload).toBe("original");
    });
  });

  describe("connection options", () => {
    it("pins the role as a startup parameter only in managed mode", () => {
      expect(runtimeConnectionOptions({ mode: "managed", role: RUNTIME_ROLE })).toBe(
        `-c role=${RUNTIME_ROLE}`
      );
      expect(runtimeConnectionOptions({ mode: "operator" })).toBeUndefined();
      expect(runtimeConnectionOptions({ mode: "single", reason: "no CREATEROLE" })).toBeUndefined();
    });
  });
});
