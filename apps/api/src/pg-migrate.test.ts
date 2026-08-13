import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "./db";
import { runPgMigrations } from "./pg-migrate";
import { PG_MIGRATIONS } from "./pg-migrations";
import { makePglite } from "./test/pglite";

/** Each embedding table and the migration that first creates it. */
const EMBEDDING_TABLE_ORIGINS = [
  { table: "knowledge_chunks", dimColumn: "dim", createdAt: 1 },
  { table: "knowledge_source_chunks", dimColumn: "dim", createdAt: 29 },
  { table: "memory_assertions", dimColumn: "embedding_dim", createdAt: 33 },
  { table: "memory_chunks", dimColumn: "embedding_dim", createdAt: 35 },
] as const;

/**
 * v45 indexes every embedding column, so a fixture that starts mid-history has to stand in for the
 * embedding tables that already existed at its cutoff. Only those: the later ones are created by
 * the sweep itself, and pre-creating them would shadow their real definitions behind
 * `CREATE TABLE IF NOT EXISTS` and quietly test the wrong schema.
 */
async function seedEmbeddingTablesAsOf(db: PGlite, version: number): Promise<void> {
  await db.query("CREATE EXTENSION IF NOT EXISTS vector");
  for (const origin of EMBEDDING_TABLE_ORIGINS.filter((o) => o.createdAt <= version)) {
    await db.query(`CREATE TABLE IF NOT EXISTS ${origin.table} (
      id        uuid PRIMARY KEY,
      embedding vector,
      ${origin.dimColumn} integer
    )`);
  }
}

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
    // v27's `knowledge_source_chunks.embedding` needs pgvector, normally created by baseline (v1).
    await db.query("CREATE EXTENSION IF NOT EXISTS vector");
    await db.query("CREATE TABLE conversations (id uuid PRIMARY KEY)");
    await seedEmbeddingTablesAsOf(db, 14);
    await db.query("CREATE TABLE messages (id uuid PRIMARY KEY)");
    await db.query("CREATE TABLE users (id uuid PRIMARY KEY, password_hash text NOT NULL)");
    await db.query("CREATE TABLE runs (id uuid PRIMARY KEY, bundle jsonb NOT NULL)");
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
    // Minimal stand-in for the real `integrations` table (created at v11, well before this
    // database's v14 cutoff) — v26's `soul_repositories` FK needs it to exist.
    await db.query(`CREATE TABLE integrations (
      business_id text NOT NULL,
      id          text NOT NULL,
      PRIMARY KEY (business_id, id)
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

    it("installs the publication and activation safety schema through migration 49", async () => {
      await runPgMigrations(db, undefined, () => {});

      const activationSequence = await db.query<{ reg: string | null }>(
        "SELECT to_regclass('soul_activation_sequence') AS reg"
      );
      expect(activationSequence.rows[0]?.reg).toBe("soul_activation_sequence");

      const publicationColumns = await db.query<{ column_name: string }>(`SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'soul_publications'
          AND column_name IN (
            'publication_sequence',
            'actor_principal_id',
            'attempts',
            'next_attempt_at',
            'failure_code',
            'dead_lettered_at',
            'dead_letter_reason'
          )
        ORDER BY column_name`);
      expect(publicationColumns.rows.map((row) => row.column_name)).toEqual([
        "actor_principal_id",
        "attempts",
        "dead_letter_reason",
        "dead_lettered_at",
        "failure_code",
        "next_attempt_at",
        "publication_sequence",
      ]);

      const activationColumns = await db.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN ('soul_active_bundles', 'soul_bundle_activations')
            AND column_name IN (
              'business_id',
              'activation_sequence',
              'digest',
              'changeset_id',
              'activated_at',
              'activated_by_principal_id'
            )
          ORDER BY table_name, column_name`
      );
      expect(activationColumns.rows).toEqual([
        { table_name: "soul_active_bundles", column_name: "activated_at" },
        { table_name: "soul_active_bundles", column_name: "activated_by_principal_id" },
        { table_name: "soul_active_bundles", column_name: "activation_sequence" },
        { table_name: "soul_active_bundles", column_name: "business_id" },
        { table_name: "soul_active_bundles", column_name: "digest" },
        { table_name: "soul_bundle_activations", column_name: "activated_at" },
        { table_name: "soul_bundle_activations", column_name: "activated_by_principal_id" },
        { table_name: "soul_bundle_activations", column_name: "activation_sequence" },
        { table_name: "soul_bundle_activations", column_name: "business_id" },
        { table_name: "soul_bundle_activations", column_name: "changeset_id" },
        { table_name: "soul_bundle_activations", column_name: "digest" },
      ]);

      const foreignKeys = await db.query<{ table_name: string; constraint_name: string }>(
        `SELECT table_name, constraint_name
          FROM information_schema.table_constraints
          WHERE table_schema = 'public'
            AND constraint_type = 'FOREIGN KEY'
            AND table_name IN (
              'soul_publication_outbox',
              'soul_active_bundles',
              'soul_bundle_activations'
            )
          ORDER BY table_name, constraint_name`
      );
      expect(foreignKeys.rows).toEqual(
        expect.arrayContaining([
          {
            table_name: "soul_active_bundles",
            constraint_name: "soul_active_bundles_bundle_fkey",
          },
          {
            table_name: "soul_bundle_activations",
            constraint_name: "soul_bundle_activations_bundle_fkey",
          },
          {
            table_name: "soul_bundle_activations",
            constraint_name: "soul_bundle_activations_changeset_id_fkey",
          },
          {
            table_name: "soul_publication_outbox",
            constraint_name: "soul_publication_outbox_changeset_id_fkey",
          },
        ])
      );

      const repeatDigestUnique = await db.query<{ constraint_name: string }>(
        `SELECT constraint_name
          FROM information_schema.table_constraints
          WHERE table_schema = 'public'
            AND table_name = 'soul_bundle_activations'
            AND constraint_type = 'UNIQUE'`
      );
      expect(repeatDigestUnique.rows).toEqual([]);
    });
  });

  describe("migration 49", () => {
    it("moves activation history off the publication sequence without losing repeat activations", async () => {
      await db.query(`CREATE SEQUENCE soul_publication_sequence`);
      await db.query(`CREATE TABLE soul_publications (
        changeset_id text PRIMARY KEY,
        business_id text NOT NULL,
        commit_sha text NOT NULL,
        digest text NOT NULL,
        stage text NOT NULL,
        publication_sequence bigint NOT NULL,
        actor_principal_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        failure_code text,
        dead_lettered_at timestamptz,
        dead_letter_reason text,
        UNIQUE (business_id, digest),
        UNIQUE (business_id, publication_sequence)
      )`);
      await db.query(`CREATE TABLE soul_execution_bundles (
        digest text PRIMARY KEY,
        business_id text NOT NULL,
        changeset_id text NOT NULL,
        commit_sha text NOT NULL,
        bundle jsonb NOT NULL,
        signature jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (business_id, digest)
      )`);
      await db.query(`CREATE TABLE soul_active_bundles (
        business_id text PRIMARY KEY,
        digest text NOT NULL,
        activation_sequence bigint NOT NULL,
        activated_at timestamptz NOT NULL DEFAULT now(),
        activated_by_principal_id text NOT NULL
      )`);
      await db.query(`CREATE TABLE soul_bundle_activations (
        business_id text NOT NULL,
        activation_sequence bigint NOT NULL,
        digest text NOT NULL,
        changeset_id text NOT NULL REFERENCES soul_publications(changeset_id),
        activated_at timestamptz NOT NULL DEFAULT now(),
        activated_by_principal_id text NOT NULL,
        PRIMARY KEY (business_id, activation_sequence),
        UNIQUE (business_id, digest)
      )`);
      await db.query(`CREATE TABLE schema_version (
        id boolean PRIMARY KEY DEFAULT true,
        version integer NOT NULL,
        CONSTRAINT schema_version_single_row CHECK (id)
      )`);
      await db.query("INSERT INTO schema_version (id, version) VALUES (true, 48)");
      await db.query(`INSERT INTO soul_execution_bundles (
        digest, business_id, changeset_id, commit_sha, bundle, signature
      ) VALUES (
        'digest-1',
        'biz-1',
        'changeset-1',
        'commit-1',
        '{}'::jsonb,
        '{"keyId":"key-1","value":"sig"}'::jsonb
      )`);
      await db.query(`INSERT INTO soul_publications (
        changeset_id, business_id, commit_sha, digest, stage, publication_sequence,
        actor_principal_id
      ) VALUES (
        'changeset-1',
        'biz-1',
        'commit-1',
        'digest-1',
        'active',
        1,
        'publisher-1'
      )`);
      await db.query(`INSERT INTO soul_active_bundles (
        business_id, digest, activation_sequence, activated_by_principal_id
      ) VALUES ('biz-1', 'digest-1', 1, 'publisher-1')`);
      await db.query(`INSERT INTO soul_bundle_activations (
        business_id, activation_sequence, digest, changeset_id, activated_by_principal_id
      ) VALUES ('biz-1', 1, 'digest-1', 'changeset-1', 'publisher-1')`);

      await runPgMigrations(db, undefined, () => {});

      const version = await db.query<{ version: number }>(
        "SELECT version FROM schema_version WHERE id = true"
      );
      expect(Number(version.rows[0]?.version)).toBe(
        Math.max(...PG_MIGRATIONS.map((migration) => migration.version))
      );

      const next = await db.query<{ activation_sequence: string | number }>(
        "SELECT nextval('soul_activation_sequence') AS activation_sequence"
      );
      expect(Number(next.rows[0]?.activation_sequence)).toBe(2);

      await db.query(`INSERT INTO soul_bundle_activations (
        business_id, activation_sequence, digest, changeset_id, activated_by_principal_id
      ) VALUES (
        'biz-1',
        nextval('soul_activation_sequence'),
        'digest-1',
        'changeset-1',
        'operator-1'
      )`);
      const rows = await db.query<{
        activation_sequence: string | number;
        activated_by_principal_id: string;
      }>(`SELECT activation_sequence, activated_by_principal_id
        FROM soul_bundle_activations
        ORDER BY activation_sequence`);
      expect(rows.rows.map((row) => Number(row.activation_sequence))).toEqual([1, 3]);
      expect(rows.rows.map((row) => row.activated_by_principal_id)).toEqual([
        "publisher-1",
        "operator-1",
      ]);
    });
  });

  describe("migration 21", () => {
    it("backfills the Run source from the formerly overloaded Routine id", async () => {
      // v27's `knowledge_source_chunks.embedding` needs pgvector, normally created by baseline (v1).
      await db.query("CREATE EXTENSION IF NOT EXISTS vector");
      await db.query(`CREATE TABLE runs (
        id uuid PRIMARY KEY,
        bundle jsonb NOT NULL
      )`);
      await db.query(`INSERT INTO runs (id, bundle)
        VALUES ('00000000-0000-4000-8000-000000000001', '{"routineId":"chat"}'::jsonb)`);
      await db.query(`CREATE TABLE schema_version (
        id boolean PRIMARY KEY DEFAULT true,
        version integer NOT NULL,
        CONSTRAINT schema_version_single_row CHECK (id)
      )`);
      await db.query("INSERT INTO schema_version (id, version) VALUES (true, 20)");
      await seedEmbeddingTablesAsOf(db, 20);
      // Minimal stand-in for the real `users` table (created well before v20): later migrations
      // past 21 run in the same sweep and need it to exist with the columns they touch (v25 adds
      // one, v27 relaxes `password_hash`), even though this test only exercises migration 21.
      await db.query(`CREATE TABLE users (
        id uuid PRIMARY KEY,
        password_hash text NOT NULL
      )`);
      // Minimal stand-in for the real `integrations` table (created at v11, well before this
      // database's v20 cutoff) — v26's `soul_repositories` FK needs it to exist.
      await db.query(`CREATE TABLE integrations (
        business_id text NOT NULL,
        id          text NOT NULL,
        PRIMARY KEY (business_id, id)
      )`);

      await runPgMigrations(db, undefined, () => {});

      const source = await db.query<{ source: string }>("SELECT source FROM runs");
      expect(source.rows[0]?.source).toBe("chat");
      await expect(
        db.query(
          `INSERT INTO runs (id, source, bundle)
           VALUES ('00000000-0000-4000-8000-000000000002', '', '{"routineId":"ignored"}'::jsonb)`
        )
      ).rejects.toThrow();
    });
  });

  describe("migration 32", () => {
    // Every migration from 32 up runs against these fixtures, so they hold a stand-in for each
    // baseline table a later migration touches — v42 adds a column to `users`.
    const seedUsers = () => db.query("CREATE TABLE users (id uuid PRIMARY KEY)");

    it("moves GitHub App credentials onto integration.github.* without touching ciphertext", async () => {
      await db.query("CREATE EXTENSION IF NOT EXISTS vector");
      await seedUsers();
      await db.query(`CREATE TABLE secrets (
        key             text PRIMARY KEY,
        type            text NOT NULL,
        encrypted_value text NOT NULL,
        iv              text NOT NULL,
        auth_tag        text NOT NULL,
        dek_id          uuid,
        created_at      timestamptz NOT NULL,
        updated_at      timestamptz NOT NULL
      )`);
      const seed = async (key: string, value: string) =>
        db.query(
          `INSERT INTO secrets (key, type, encrypted_value, iv, auth_tag, created_at, updated_at)
           VALUES ($1, 'generic', $2, 'iv', 'tag', now(), now())`,
          [key, value]
        );
      await seed("github-app-id", "cipher-app-id");
      await seed("github-app-private-key", "cipher-pem");
      // Already reconnected through the new flow: the newer value must survive the rename.
      await seed("github-app-slug", "cipher-old-slug");
      await seed("integration.github.GITHUB_APP_SLUG", "cipher-new-slug");
      await db.query(`CREATE TABLE schema_version (
        id boolean PRIMARY KEY DEFAULT true,
        version integer NOT NULL,
        CONSTRAINT schema_version_single_row CHECK (id)
      )`);
      await db.query("INSERT INTO schema_version (id, version) VALUES (true, 31)");
      await seedEmbeddingTablesAsOf(db, 31);

      await runPgMigrations(db, undefined, () => {});

      const rows = await db.query<{ key: string; encrypted_value: string }>(
        "SELECT key, encrypted_value FROM secrets ORDER BY key"
      );
      expect(rows.rows).toEqual([
        { key: "integration.github.GITHUB_APP_ID", encrypted_value: "cipher-app-id" },
        { key: "integration.github.GITHUB_APP_PRIVATE_KEY", encrypted_value: "cipher-pem" },
        { key: "integration.github.GITHUB_APP_SLUG", encrypted_value: "cipher-new-slug" },
      ]);
    });

    it("is a no-op on a database with no secrets table", async () => {
      await db.query("CREATE EXTENSION IF NOT EXISTS vector");
      await seedUsers();
      await db.query(`CREATE TABLE schema_version (
        id boolean PRIMARY KEY DEFAULT true,
        version integer NOT NULL,
        CONSTRAINT schema_version_single_row CHECK (id)
      )`);
      await db.query("INSERT INTO schema_version (id, version) VALUES (true, 31)");
      await seedEmbeddingTablesAsOf(db, 31);

      await expect(runPgMigrations(db, undefined, () => {})).resolves.not.toThrow();
    });
  });
});

/**
 * Wraps the test database so a test can watch the SQL a run issues, and stand in for events that
 * are otherwise unreachable from a single process — a peer holding the lock, a statement failing
 * mid-migration.
 */
function watch(db: PGlite, intercept?: Intercept) {
  const statements: string[] = [];
  const queryable: Queryable = {
    async query(text, params) {
      statements.push(text);
      const override = intercept?.(text, params);
      if (override) return await override;
      return (await db.query(text, params)) as { rows: Record<string, unknown>[] };
    },
  };
  return { queryable, statements };
}

type Intercept = (
  sql: string,
  params: unknown[] | undefined
) => Promise<{ rows: Record<string, unknown>[] }> | undefined;

const NOOP_LOG = () => {};

async function tableExists(db: PGlite, name: string): Promise<boolean> {
  const { rows } = await db.query<{ reg: string | null }>("SELECT to_regclass($1) AS reg", [name]);
  return rows[0]?.reg !== null;
}

async function schemaVersion(db: PGlite): Promise<number> {
  const { rows } = await db.query<{ version: number }>(
    "SELECT version FROM schema_version WHERE id = true"
  );
  return Number(rows[0]?.version);
}

describe("runPgMigrations concurrency and atomicity", () => {
  let db: PGlite;
  const latestVersion = Math.max(...PG_MIGRATIONS.map((m) => m.version));

  beforeEach(async () => {
    db = await makePglite();
  });

  afterEach(async () => {
    await db.close();
  });

  it("holds the advisory lock across the whole run", async () => {
    const { queryable, statements } = watch(db);

    await runPgMigrations(queryable, undefined, NOOP_LOG);

    // The lock must precede even `CREATE TABLE IF NOT EXISTS schema_version` — that statement is
    // itself racy between replicas — and outlive the last migration.
    expect(statements[0]).toContain("pg_try_advisory_lock");
    expect(statements.filter((s) => s.includes("pg_try_advisory_lock"))).toHaveLength(1);
    expect(statements.at(-1)).toContain("pg_advisory_unlock");
  });

  it("skips migrations a peer applied while this instance waited for the lock", async () => {
    let peerHasRun = false;
    // Stand in for the peer finishing its sweep in the instant before we win the lock.
    const intercept: Intercept = (sql) => {
      if (!sql.includes("pg_try_advisory_lock") || peerHasRun) return undefined;
      peerHasRun = true;
      return runPgMigrations(db, undefined, NOOP_LOG).then(() => ({ rows: [{ locked: true }] }));
    };
    const { queryable, statements } = watch(db, intercept);

    await runPgMigrations(queryable, undefined, NOOP_LOG);

    // Reading the version before the lock instead of after would replay all 44 migrations here.
    expect(statements.filter((s) => s === "BEGIN")).toHaveLength(0);
    expect(await schemaVersion(db)).toBe(latestVersion);
  });

  it("gives up loudly rather than hanging when a peer holds the lock indefinitely", async () => {
    const held: Intercept = (sql) =>
      sql.includes("pg_try_advisory_lock")
        ? Promise.resolve({ rows: [{ locked: false }] })
        : undefined;
    const { queryable } = watch(db, held);
    const exit = vi.fn();
    const sleep = vi.fn(async () => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await runPgMigrations(queryable, exit, NOOP_LOG, {
      lockAttempts: 3,
      lockDelayMs: 10,
      sleep,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(sleep).toHaveBeenCalledTimes(2); // waits between attempts, not after the last
    expect(errors.mock.calls[0]?.[0]).toContain("migration lock");
    expect(await tableExists(db, "schema_version")).toBe(false);
    errors.mockRestore();
  });

  it("rolls back every statement of a failed migration, and frees the lock for the retry", async () => {
    // Fails partway through the baseline, after `resource_sample` itself was created — so passing
    // this proves the whole migration was undone, not merely the statement that threw.
    const failing: Intercept = (sql) =>
      sql.includes("resource_sample_ts_idx") ? Promise.reject(new Error("disk full")) : undefined;
    const { queryable } = watch(db, failing);
    const exit = vi.fn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await runPgMigrations(queryable, exit, NOOP_LOG);

    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.mock.calls[0]?.[0]).toContain("disk full");
    expect(await tableExists(db, "resource_sample")).toBe(false);
    expect(await schemaVersion(db)).toBe(0);
    errors.mockRestore();

    // The retry must not be locked out by the corpse of the failed run.
    await runPgMigrations(db, undefined, NOOP_LOG);
    expect(await schemaVersion(db)).toBe(latestVersion);
    expect(await tableExists(db, "resource_sample")).toBe(true);
  });

  it("records what ran, when, and for how long", async () => {
    await runPgMigrations(db, undefined, NOOP_LOG);

    const { rows } = await db.query<{ version: number; description: string; duration_ms: number }>(
      "SELECT version, description, duration_ms FROM schema_migrations ORDER BY version"
    );
    expect(rows).toHaveLength(PG_MIGRATIONS.length);
    expect(rows.map((r) => r.version)).toEqual(
      PG_MIGRATIONS.map((m) => m.version).sort((a, b) => a - b)
    );
    expect(rows.every((r) => r.duration_ms !== null)).toBe(true);
    expect(rows.at(-1)?.description).toBe(
      PG_MIGRATIONS.find((m) => m.version === latestVersion)?.description
    );
  });

  describe("migration 50", () => {
    it("drops the single-admin index and revokes owner authority when admin is demoted", async () => {
      const adminId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      await db.query(`CREATE TABLE users (
        id            uuid PRIMARY KEY,
        email         text NOT NULL UNIQUE,
        password_hash text,
        role          text NOT NULL,
        status        text NOT NULL,
        created_at    timestamptz NOT NULL
      )`);
      await db.query(
        "CREATE UNIQUE INDEX users_single_admin_idx ON users (role) WHERE role = 'admin'"
      );
      await db.query(
        `INSERT INTO users (id, email, password_hash, role, status, created_at)
         VALUES ($1, 'owner@example.com', 'hash', 'admin', 'active', '2026-08-12T00:00:00Z')`,
        [adminId]
      );
      await db.query(`CREATE TABLE schema_version (
        id boolean PRIMARY KEY DEFAULT true,
        version integer NOT NULL,
        CONSTRAINT schema_version_single_row CHECK (id)
      )`);
      await db.query("INSERT INTO schema_version (id, version) VALUES (true, 49)");

      await runPgMigrations(db, undefined, NOOP_LOG);

      const version = await db.query<{ version: number }>(
        "SELECT version FROM schema_version WHERE id = true"
      );
      expect(Number(version.rows[0]?.version)).toBe(latestVersion);

      const indexes = await db.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE indexname = 'users_single_admin_idx'"
      );
      expect(indexes.rows).toEqual([]);
      const setupIndexes = await db.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE indexname = 'users_setup_bootstrap_admin_idx'"
      );
      expect(setupIndexes.rows).toEqual([{ indexname: "users_setup_bootstrap_admin_idx" }]);

      const setupBootstrap = await db.query<{ setup_bootstrap: boolean }>(
        "SELECT setup_bootstrap FROM users WHERE id = $1",
        [adminId]
      );
      expect(setupBootstrap.rows).toEqual([{ setup_bootstrap: true }]);

      const assignments = await db.query<{ role_id: string }>(
        `SELECT role_id FROM role_assignments
         WHERE business_id = $1 AND principal_id = $2
         ORDER BY role_id`,
        [DEPLOYMENT_BUSINESS_ID, adminId]
      );
      expect(assignments.rows.map((row) => row.role_id)).toEqual(["admin", "owner"]);

      const groupMembers = await db.query<{ group_id: string }>(
        `SELECT group_id FROM principal_group_members
         WHERE business_id = $1 AND principal_id = $2`,
        [DEPLOYMENT_BUSINESS_ID, adminId]
      );
      expect(groupMembers.rows).toEqual([{ group_id: "owners" }]);

      await expect(
        db.query(
          `INSERT INTO users (id, email, password_hash, role, status, created_at, setup_bootstrap)
           VALUES (
             'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
             'racer@example.com',
             'hash',
             'admin',
             'active',
             now(),
             true
           )`
        )
      ).rejects.toThrow();
      await expect(
        db.query(
          `INSERT INTO users (id, email, password_hash, role, status, created_at)
           VALUES (
             'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
             'admin2@example.com',
             'hash',
             'admin',
             'active',
             now()
           )`
        )
      ).resolves.toBeDefined();

      await db.query("UPDATE users SET status = 'disabled' WHERE id = $1", [adminId]);
      const disabledPrincipal = await db.query<{ status: string }>(
        `SELECT status FROM principals
         WHERE business_id = $1 AND id = $2`,
        [DEPLOYMENT_BUSINESS_ID, adminId]
      );
      expect(disabledPrincipal.rows).toEqual([{ status: "disabled" }]);
      const disabledAssignments = await db.query<{ role_id: string }>(
        `SELECT role_id FROM role_assignments
         WHERE business_id = $1 AND principal_id = $2
         ORDER BY role_id`,
        [DEPLOYMENT_BUSINESS_ID, adminId]
      );
      expect(disabledAssignments.rows.map((row) => row.role_id)).toEqual(["admin", "owner"]);
      const disabledGroupMembers = await db.query<{ group_id: string }>(
        `SELECT group_id FROM principal_group_members
         WHERE business_id = $1 AND principal_id = $2`,
        [DEPLOYMENT_BUSINESS_ID, adminId]
      );
      expect(disabledGroupMembers.rows).toEqual([{ group_id: "owners" }]);

      await db.query("UPDATE users SET status = 'active' WHERE id = $1", [adminId]);
      await db.query("UPDATE users SET role = 'member' WHERE id = $1", [adminId]);
      const demotedAssignments = await db.query<{ role_id: string }>(
        `SELECT role_id FROM role_assignments
         WHERE business_id = $1 AND principal_id = $2
         ORDER BY role_id`,
        [DEPLOYMENT_BUSINESS_ID, adminId]
      );
      expect(demotedAssignments.rows.map((row) => row.role_id)).toEqual(["member"]);
      const demotedGroupMembers = await db.query(
        `SELECT 1 FROM principal_group_members
         WHERE business_id = $1 AND group_id = 'owners' AND principal_id = $2`,
        [DEPLOYMENT_BUSINESS_ID, adminId]
      );
      expect(demotedGroupMembers.rows).toEqual([]);

      await db.query("DELETE FROM users WHERE id = $1", [adminId]);
      const remainingPrincipals = await db.query(
        "SELECT 1 FROM principals WHERE business_id = $1 AND id = $2",
        [DEPLOYMENT_BUSINESS_ID, adminId]
      );
      expect(remainingPrincipals.rows).toEqual([]);
      const remainingAssignments = await db.query(
        "SELECT 1 FROM role_assignments WHERE principal_id = $1",
        [adminId]
      );
      expect(remainingAssignments.rows).toEqual([]);
      const remainingGroupMembers = await db.query(
        "SELECT 1 FROM principal_group_members WHERE principal_id = $1",
        [adminId]
      );
      expect(remainingGroupMembers.rows).toEqual([]);
    });
  });

  it("is a no-op on an already-current database", async () => {
    await runPgMigrations(db, undefined, NOOP_LOG);
    const { queryable, statements } = watch(db);

    await runPgMigrations(queryable, undefined, NOOP_LOG);

    expect(statements.filter((s) => s === "BEGIN")).toHaveLength(0);
    const { rows } = await db.query("SELECT version FROM schema_migrations");
    expect(rows).toHaveLength(PG_MIGRATIONS.length);
  });

  it("seeds one baseline row for a database migrated before the ledger existed", async () => {
    await runPgMigrations(db, undefined, NOOP_LOG);
    await db.query("DROP TABLE schema_migrations");

    await runPgMigrations(db, undefined, NOOP_LOG);

    // 44 invented timestamps would be a lie; one honest marker is not.
    const { rows } = await db.query<{ version: number; description: string }>(
      "SELECT version, description FROM schema_migrations"
    );
    expect(rows).toEqual([{ version: latestVersion, description: "pre-ledger baseline" }]);
  });
});
