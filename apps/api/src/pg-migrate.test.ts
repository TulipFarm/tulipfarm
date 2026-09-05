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
] as const;

/** Mid-history fixtures need embedding tables before v45 adds their indexes. */
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

/**
 * The `runs` FK target that migration v54 (`agent_loop_checkpoints`) references. Fixtures whose
 * floor is above v4 — where the real `runs` table is created — must stand it in, matching the real
 * `UNIQUE (business_id, id)` the foreign key points at.
 */
async function seedRunsFkTarget(db: PGlite): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS runs (
    id          uuid PRIMARY KEY,
    business_id text NOT NULL DEFAULT '${DEPLOYMENT_BUSINESS_ID}',
    bundle      jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (business_id, id)
  )`);
}

/**
 * The `approvals` table that migration v59 (one-use decision columns) alters. Fixtures whose
 * floor is above the baseline that creates it must stand it in.
 */
async function seedApprovalsAlterTarget(db: PGlite): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS approvals (
    id      uuid PRIMARY KEY,
    kind    text NOT NULL,
    status  text NOT NULL DEFAULT 'pending',
    payload jsonb NOT NULL
  )`);
}

/**
 * The `channel_bind_tokens` table that migration v17 creates and v83 later alters. Fixtures
 * whose floor is above v17 must stand it in.
 */
async function seedChannelBindTokensAlterTarget(db: PGlite): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS channel_bind_tokens (
    nonce_hash         text PRIMARY KEY,
    integration_slug   text NOT NULL,
    external_sender_id text NOT NULL,
    issued_at          timestamptz NOT NULL,
    expires_at         timestamptz NOT NULL,
    consumed_at        timestamptz,
    consumed_by        uuid
  )`);
}

/**
 * The `conversation_turns` (v16) and `turn_completions` (v17) tables that v84 later alters.
 * Fixtures whose floor is above v17 must stand both in.
 */
async function seedTurnCompletionsAlterTarget(db: PGlite): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS conversation_turns (
    id uuid PRIMARY KEY
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS turn_completions (
    turn_id    uuid NOT NULL REFERENCES conversation_turns(id),
    attempt    integer NOT NULL CHECK (attempt >= 0),
    status     text NOT NULL,
    message_id uuid,
    cursor     bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (turn_id, attempt)
  )`);
}

describe("the migration ledger is append-only", () => {
  it("assigns every migration a distinct version", () => {
    const seen = new Map<number, string[]>();
    for (const migration of PG_MIGRATIONS) {
      const descriptions = seen.get(migration.version) ?? [];
      descriptions.push(migration.description);
      seen.set(migration.version, descriptions);
    }
    const collisions = [...seen]
      .filter(([, descriptions]) => descriptions.length > 1)
      .map(([version, descriptions]) => `${version}: ${descriptions.join(" | ")}`);
    expect(
      collisions,
      "two branches appended the same version — renumber the unreleased one last"
    ).toEqual([]);
  });

  it("declares versions in ascending order", () => {
    const versions = PG_MIGRATIONS.map((migration) => migration.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });
});

describe("runPgMigrations", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makePglite();
  });

  afterEach(async () => {
    await db.close();
  });

  it("repairs Surface storage for databases that already recorded schema version 14", async () => {
    // Stand-in for a database stopped at v14; v27 needs pgvector.
    await db.query("CREATE EXTENSION IF NOT EXISTS vector");
    await db.query("CREATE TABLE conversations (id uuid PRIMARY KEY)");
    await seedEmbeddingTablesAsOf(db, 14);
    await db.query("CREATE TABLE messages (id uuid PRIMARY KEY)");
    await db.query("CREATE TABLE users (id uuid PRIMARY KEY, password_hash text NOT NULL)");
    await seedRunsFkTarget(db);
    await seedApprovalsAlterTarget(db);
    await seedChannelBindTokensAlterTarget(db);
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
    // v26's soul_repositories FK needs a stand-in integrations table.
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
      // Retried Worker attempts must not collide on Turn-only keys.
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

      // Channels bind through external_identity_mappings with provider = integration slug.
      const link = (userId: string) =>
        db.query(
          `INSERT INTO external_identity_mappings
             (provider, external_subject, user_id, verified_at, verified_via)
           VALUES ('slack', 'U1', $1, now(), 'manifest_email')`,
          [userId]
        );
      await link(first);
      // Inbound Slack resolves to exactly one person or none, never an arbitrary first row.
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
      await seedRunsFkTarget(db);
      await seedApprovalsAlterTarget(db);
      await seedChannelBindTokensAlterTarget(db);
      await seedTurnCompletionsAlterTarget(db);
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
      // v27 needs pgvector for `knowledge_source_chunks.embedding`; baseline v1 usually creates it.
      await db.query("CREATE EXTENSION IF NOT EXISTS vector");
      await seedRunsFkTarget(db);
      await seedApprovalsAlterTarget(db);
      await seedChannelBindTokensAlterTarget(db);
      await seedTurnCompletionsAlterTarget(db);
      await db.query(`INSERT INTO runs (id, bundle)
        VALUES ('00000000-0000-4000-8000-000000000001', '{"routineId":"chat"}'::jsonb)`);
      await db.query(`CREATE TABLE schema_version (
        id boolean PRIMARY KEY DEFAULT true,
        version integer NOT NULL,
        CONSTRAINT schema_version_single_row CHECK (id)
      )`);
      await db.query("INSERT INTO schema_version (id, version) VALUES (true, 20)");
      await seedEmbeddingTablesAsOf(db, 20);
      // Later migrations need the real users-table shape, even when testing v21.
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

  describe("migration 86", () => {
    it("backfills immutable version one and creates durable blob cleanup storage", async () => {
      const fileId = "00000000-0000-4000-8000-000000000085";
      await db.query(`CREATE TABLE files (
        id                     uuid PRIMARY KEY,
        business_id            text NOT NULL,
        owner_principal_id     text NOT NULL,
        filename               text NOT NULL,
        media_type             text NOT NULL,
        claimed_media_type     text NOT NULL,
        size_bytes             bigint NOT NULL,
        blob_key               text NOT NULL,
        blob_hash              text NOT NULL,
        origin                 text NOT NULL DEFAULT 'uploaded',
        source_conversation_id uuid,
        source_run_id          uuid,
        knowledge_requested_at timestamptz,
        created_at             timestamptz(3) NOT NULL DEFAULT now()
      )`);
      await db.query(
        `INSERT INTO files
          (id, business_id, owner_principal_id, filename, media_type, claimed_media_type,
           size_bytes, blob_key, blob_hash)
         VALUES ($1, 'business', 'owner', 'notes.txt', 'text/plain', 'text/plain',
           3, 'blob-key', 'blob-hash')`,
        [fileId]
      );
      await db.query(`CREATE TABLE schema_version (
        id boolean PRIMARY KEY DEFAULT true,
        version integer NOT NULL,
        CONSTRAINT schema_version_single_row CHECK (id)
      )`);
      await db.query("INSERT INTO schema_version (id, version) VALUES (true, 85)");

      await runPgMigrations(db, undefined, NOOP_LOG);

      const versions = await db.query<{
        id: string;
        file_id: string;
        version_number: number;
        reason: string;
      }>("SELECT id, file_id, version_number, reason FROM file_versions");
      expect(versions.rows).toEqual([
        { id: fileId, file_id: fileId, version_number: 1, reason: "created" },
      ]);
      const files = await db.query<{ current_version_id: string; revision: number }>(
        "SELECT current_version_id, revision FROM files"
      );
      expect(files.rows).toEqual([{ current_version_id: fileId, revision: 1 }]);
      await expect(
        db.query(
          "INSERT INTO file_blob_cleanup (blob_key, blob_hash) VALUES ('blob-key', 'blob-hash')"
        )
      ).resolves.toBeDefined();
    });

    describe("migration 87", () => {
      it("adds expiring generation drafts and Tool-call idempotency", async () => {
        await runPgMigrations(db, undefined, NOOP_LOG);

        const columns = await db.query<{ column_name: string }>(`SELECT column_name
          FROM information_schema.columns
          WHERE table_name = 'file_generation_drafts'
          ORDER BY column_name`);
        expect(columns.rows.map((row) => row.column_name)).toContain("expires_at");
        expect(columns.rows.map((row) => row.column_name)).toContain("source_tool_call_id");

        const files = await db.query<{ column_name: string }>(`SELECT column_name
          FROM information_schema.columns
          WHERE table_name = 'files' AND column_name = 'source_tool_call_id'`);
        expect(files.rows).toHaveLength(1);
      });
    });

    describe("migration 88", () => {
      it("adds nested File folders and optional File placement", async () => {
        await runPgMigrations(db, undefined, NOOP_LOG);

        const folders = await db.query<{ table_name: string }>(`SELECT table_name
            FROM information_schema.tables WHERE table_name = 'file_folders'`);
        const files = await db.query<{ column_name: string }>(`SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'files' AND column_name = 'folder_id'`);

        expect(folders.rows).toHaveLength(1);
        expect(files.rows).toHaveLength(1);
      });
    });
  });

  describe("migration 89", () => {
    it("migrates legacy groups without changing effective Role access", async () => {
      await db.query(`CREATE TABLE principals (
        business_id text NOT NULL,
        id text NOT NULL,
        kind text NOT NULL,
        status text NOT NULL,
        expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, id)
      )`);
      await db.query(`CREATE TABLE roles (
        business_id text NOT NULL,
        id text NOT NULL,
        assignable_to text[] NOT NULL,
        expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, id)
      )`);
      await db.query(`CREATE TABLE role_assignments (
        business_id text NOT NULL,
        principal_id text NOT NULL,
        role_id text NOT NULL,
        expires_at timestamptz,
        assigned_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, principal_id, role_id),
        FOREIGN KEY (business_id, principal_id) REFERENCES principals(business_id, id),
        FOREIGN KEY (business_id, role_id) REFERENCES roles(business_id, id)
      )`);
      await db.query(`CREATE TABLE principal_groups (
        business_id text NOT NULL,
        id text NOT NULL,
        expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, id)
      )`);
      await db.query(`CREATE TABLE principal_group_members (
        business_id text NOT NULL,
        group_id text NOT NULL,
        principal_id text NOT NULL,
        expires_at timestamptz,
        assigned_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, group_id, principal_id)
      )`);
      await db.query(`CREATE TABLE group_role_assignments (
        business_id text NOT NULL,
        group_id text NOT NULL,
        role_id text NOT NULL,
        expires_at timestamptz,
        assigned_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, group_id, role_id)
      )`);
      await db.query(
        `INSERT INTO principals (business_id, id, kind, status)
         VALUES ('business', 'person-1', 'user', 'active'),
                ('business', 'service-1', 'service', 'active')`
      );
      await db.query(
        `INSERT INTO roles (business_id, id, assignable_to)
         VALUES ('business', 'reader', ARRAY['user']),
                ('business', 'owner', ARRAY['user'])`
      );
      await db.query(
        `INSERT INTO principal_groups (business_id, id)
         VALUES ('business', 'customer-success'), ('business', 'owners')`
      );
      await db.query(
        `INSERT INTO principal_group_members
           (business_id, group_id, principal_id, expires_at)
         VALUES ('business', 'customer-success', 'person-1', '2027-01-01T00:00:00Z'),
                ('business', 'customer-success', 'service-1', NULL),
                ('business', 'owners', 'person-1', NULL)`
      );
      await db.query(
        `INSERT INTO group_role_assignments (business_id, group_id, role_id, expires_at)
         VALUES ('business', 'customer-success', 'reader', '2027-02-01'),
                ('business', 'owners', 'owner', NULL)`
      );
      await db.query(`CREATE TABLE schema_version (
        id boolean PRIMARY KEY DEFAULT true,
        version integer NOT NULL,
        CONSTRAINT schema_version_single_row CHECK (id)
      )`);
      await db.query("INSERT INTO schema_version (id, version) VALUES (true, 88)");

      const before = await db.query<{ role_id: string }>(
        `SELECT DISTINCT held.role_id
           FROM principal_group_members membership
           JOIN group_role_assignments held
             ON held.business_id = membership.business_id
            AND held.group_id = membership.group_id
          WHERE membership.business_id = 'business'
            AND membership.principal_id = 'person-1'
          ORDER BY held.role_id`
      );

      await runPgMigrations(db, undefined, NOOP_LOG);

      const after = await db.query<{ role_id: string }>(
        `SELECT role_id FROM role_assignments
          WHERE business_id = 'business' AND principal_id = 'person-1'
         UNION
         SELECT assignment.role_id
           FROM team_memberships membership
           JOIN teams team ON team.id = membership.team_id
           JOIN team_role_assignments assignment ON assignment.team_id = team.id
          WHERE team.business_id = 'business' AND membership.principal_id = 'person-1'
          ORDER BY role_id`
      );
      expect(after.rows).toEqual(before.rows);

      const migrated = await db.query<{
        slug: string;
        parent_slug: string;
        group_id: string;
        member_count: number;
      }>(
        `SELECT team.slug, parent.slug AS parent_slug, mapping.group_id,
                count(membership.principal_id)::int AS member_count
           FROM teams team
           JOIN teams parent ON parent.id = team.parent_team_id
           JOIN legacy_group_team_mappings mapping ON mapping.team_id = team.id
           LEFT JOIN team_memberships membership ON membership.team_id = team.id
          GROUP BY team.slug, parent.slug, mapping.group_id`
      );
      expect(migrated.rows).toEqual([
        {
          slug: "customer-success",
          parent_slug: "everyone",
          group_id: "customer-success",
          member_count: 2,
        },
      ]);
      const owners = await db.query(
        "SELECT 1 FROM teams WHERE business_id = 'business' AND slug = 'owners'"
      );
      expect(owners.rows).toHaveLength(0);
      const migratedRole = await db.query<{ assignable_to: string[] }>(
        "SELECT assignable_to FROM roles WHERE business_id = 'business' AND id = 'reader'"
      );
      expect(migratedRole.rows[0]?.assignable_to).toEqual(["user", "team"]);
      const expiry = await db.query<{ expires_at: Date }>(
        `SELECT expires_at FROM team_memberships membership
         JOIN legacy_group_team_mappings mapping ON mapping.team_id = membership.team_id
         WHERE mapping.group_id = 'customer-success' AND membership.principal_id = 'person-1'`
      );
      expect(expiry.rows[0]?.expires_at.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    });

    it("records slug and sibling-name conflicts for the admin migration report", async () => {
      await db.query(`CREATE TABLE principals (
        business_id text NOT NULL,
        id text NOT NULL,
        kind text NOT NULL,
        status text NOT NULL,
        expires_at timestamptz,
        PRIMARY KEY (business_id, id)
      )`);
      await db.query(`CREATE TABLE roles (
        business_id text NOT NULL,
        id text NOT NULL,
        assignable_to text[] NOT NULL,
        expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, id)
      )`);
      await db.query(`CREATE TABLE role_assignments (
        business_id text NOT NULL,
        principal_id text NOT NULL,
        role_id text NOT NULL,
        expires_at timestamptz,
        assigned_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, principal_id, role_id)
      )`);
      await db.query(`CREATE TABLE principal_groups (
        business_id text NOT NULL,
        id text NOT NULL,
        expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, id)
      )`);
      await db.query(`CREATE TABLE principal_group_members (
        business_id text NOT NULL,
        group_id text NOT NULL,
        principal_id text NOT NULL,
        expires_at timestamptz,
        assigned_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, group_id, principal_id)
      )`);
      await db.query(`CREATE TABLE group_role_assignments (
        business_id text NOT NULL,
        group_id text NOT NULL,
        role_id text NOT NULL,
        expires_at timestamptz,
        assigned_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, group_id, role_id)
      )`);
      await db.query(
        `INSERT INTO principal_groups (business_id, id)
         VALUES
           ('business', 'Customer Success'),
           ('business', 'customer-success'),
           ('business', 'Ops'),
           ('business', 'ops')`
      );
      await db.query(`CREATE TABLE schema_version (
        id boolean PRIMARY KEY DEFAULT true,
        version integer NOT NULL,
        CONSTRAINT schema_version_single_row CHECK (id)
      )`);
      await db.query("INSERT INTO schema_version (id, version) VALUES (true, 88)");

      await runPgMigrations(db, undefined, NOOP_LOG);

      const report = await db.query<{
        legacy_group_id: string;
        team_slug: string;
        display_name: string;
        slug_conflict: boolean;
        sibling_name_conflict: boolean;
      }>(
        `SELECT legacy_group_id, team_slug, display_name, slug_conflict, sibling_name_conflict
           FROM team_migration_report
          ORDER BY legacy_group_id`
      );
      expect(report.rows).toEqual([
        {
          legacy_group_id: "Customer Success",
          team_slug: "customer-success",
          display_name: "Customer Success",
          slug_conflict: true,
          sibling_name_conflict: false,
        },
        {
          legacy_group_id: "Ops",
          team_slug: "ops",
          display_name: "Ops",
          slug_conflict: true,
          sibling_name_conflict: false,
        },
        {
          legacy_group_id: "customer-success",
          team_slug: "customer-success-d38e7425",
          display_name: "customer-success",
          slug_conflict: true,
          sibling_name_conflict: false,
        },
        {
          legacy_group_id: "ops",
          team_slug: "ops-e8478978",
          display_name: "ops [e8478978]",
          slug_conflict: true,
          sibling_name_conflict: true,
        },
      ]);
    });
  });

  describe("migration 32", () => {
    // Fixtures stand in for every baseline table later migrations touch.
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
      await seedRunsFkTarget(db);
      await seedApprovalsAlterTarget(db);
      await seedChannelBindTokensAlterTarget(db);
      await seedTurnCompletionsAlterTarget(db);

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
      await seedRunsFkTarget(db);
      await seedApprovalsAlterTarget(db);
      await seedChannelBindTokensAlterTarget(db);
      await seedTurnCompletionsAlterTarget(db);

      await expect(runPgMigrations(db, undefined, () => {})).resolves.not.toThrow();
    });
  });
});

/** Wraps the DB so tests can observe migration SQL and inject synthetic results. */
function watch(db: PGlite, intercept?: Intercept) {
  const statements: string[] = [];
  const queryable: Queryable = {
    async query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]) {
      statements.push(text);
      const override = intercept?.(text, params as unknown[]);
      if (override) return (await override) as { rows: Row[] };
      return (await db.query(text, params as unknown[])) as { rows: Row[] };
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

    // The lock must precede even `CREATE TABLE IF NOT EXISTS schema_version`.
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
    // Passing proves the whole failed migration rolled back.
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

  describe("migration 64", () => {
    /**
     * The regression this exists for: the index was first written into
     * `CURATOR_STORAGE_STATEMENTS`, which migration 63 applies. A fresh database therefore had it
     * and every test passed, while every already-migrated deployment — the ones that actually
     * matter — would have run the shadow review's window read as a full scan forever.
     */
    it("adds the review index to a database that already applied 63", async () => {
      await runPgMigrations(db, undefined, NOOP_LOG);
      await db.query("DROP INDEX curator_effect_review_idx");
      await db.query("UPDATE schema_version SET version = 63 WHERE id = true");
      await db.query("DELETE FROM schema_migrations WHERE version >= 64");

      await runPgMigrations(db, undefined, NOOP_LOG);

      const { rows } = await db.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE indexname = 'curator_effect_review_idx'"
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe("migration 65", () => {
    /**
     * The document used to be a six-key `jsonb` projection. A deployment that ran 62 before this
     * shipped holds real user memory in that shape, and `CREATE TABLE IF NOT EXISTS` never
     * revisits an existing table — so without this migration those rows would be read through a
     * `document` column that does not exist, and every user's memory would read as empty.
     */
    it("renders an existing jsonb projection into the Markdown page", async () => {
      await runPgMigrations(db, undefined, NOOP_LOG);
      await db.query("ALTER TABLE user_memory DROP COLUMN document");
      await db.query("ALTER TABLE user_memory ADD COLUMN sections jsonb NOT NULL DEFAULT '{}'");
      await db.query("ALTER TABLE user_memory_revisions DROP COLUMN document");
      await db.query(
        "ALTER TABLE user_memory_revisions ADD COLUMN sections jsonb NOT NULL DEFAULT '{}'"
      );
      await db.query(
        `INSERT INTO user_memory (business_id, user_id, sections, version, revision_id, document_hash)
         VALUES ('b', 'u', $1, 1, gen_random_uuid(), 'h')`,
        [JSON.stringify({ identity: "Lives in Bangalore", preferences: "Prefers ASCII diagrams" })]
      );
      await db.query("UPDATE schema_version SET version = 64 WHERE id = true");
      await db.query("DELETE FROM schema_migrations WHERE version >= 65");

      await runPgMigrations(db, undefined, NOOP_LOG);

      const { rows } = await db.query<{ document: string }>(
        "SELECT document FROM user_memory WHERE business_id = 'b' AND user_id = 'u'"
      );
      expect(rows[0]?.document).toBe(
        "## Identity\n\nLives in Bangalore\n\n## Preferences\n\nPrefers ASCII diagrams"
      );
    });

    it("is a no-op on a database created after the text column shipped", async () => {
      await runPgMigrations(db, undefined, NOOP_LOG);
      await db.query("UPDATE schema_version SET version = 64 WHERE id = true");
      await db.query("DELETE FROM schema_migrations WHERE version >= 65");

      await expect(runPgMigrations(db, undefined, NOOP_LOG)).resolves.toBeUndefined();

      const { rows } = await db.query<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns
          WHERE table_name = 'user_memory' AND column_name = 'document'`
      );
      expect(rows[0]?.data_type).toBe("text");
    });
  });

  describe("migration 91", () => {
    it("backfills business-wide and private assets without widening private content", async () => {
      await runPgMigrations(db, undefined, NOOP_LOG);
      const privateOwner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const fileId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const privatePage = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const publicPage = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      const privateSource = "source-private";
      const hrTeamId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

      await db.query("BEGIN");
      await db.query(
        `INSERT INTO files
           (id, business_id, owner_principal_id, filename, media_type, claimed_media_type,
            size_bytes, blob_key, blob_hash, origin, current_version_id, modified_at, created_at)
         VALUES ($1, $2, 'business', 'private.txt', 'text/plain', 'text/plain',
                 1, 'file-key', 'file-hash', 'generated', $1, now(), now())`,
        [fileId, DEPLOYMENT_BUSINESS_ID]
      );
      await db.query(
        `INSERT INTO file_versions
           (id, business_id, file_id, version_number, media_type, claimed_media_type, size_bytes,
            blob_key, blob_hash, actor_kind, actor_id, reason, created_at)
         VALUES ($1, $2, $1, 1, 'text/plain', 'text/plain', 1, 'file-key', 'file-hash',
                 'system', 'business', 'created', now())`,
        [fileId, DEPLOYMENT_BUSINESS_ID]
      );
      await db.query("COMMIT");
      await db.query(
        `INSERT INTO file_shares (business_id, file_id, grantee_kind, grantee_id, granted_by)
         VALUES ($1, $2, 'user', $3, 'business'),
                ($1, $2, 'role', 'role-hr', 'business'),
                ($1, $2, 'role', 'role-everyone', 'business')`,
        [DEPLOYMENT_BUSINESS_ID, fileId, privateOwner]
      );
      // A Team holds the Role the File was shared to. The share grants read; the Team must not
      // come out of the migration owning the File.
      const everyone = await db.query<{ id: string }>(
        `SELECT id FROM teams WHERE business_id = $1 AND slug = 'everyone'`,
        [DEPLOYMENT_BUSINESS_ID]
      );
      await db.query(
        `INSERT INTO teams (business_id, id, slug, display_name, status, parent_team_id)
         VALUES ($1, $2, 'hr', 'HR', 'active', $3)
         ON CONFLICT DO NOTHING`,
        [DEPLOYMENT_BUSINESS_ID, hrTeamId, everyone.rows[0]?.id]
      );
      await db.query(
        `INSERT INTO roles (business_id, id, assignable_to)
         VALUES ($1, 'role-hr', ARRAY['user', 'team'])
         ON CONFLICT DO NOTHING`,
        [DEPLOYMENT_BUSINESS_ID]
      );
      await db.query(
        `INSERT INTO team_role_assignments (team_id, role_business_id, role_id, assigned_at)
         VALUES ($1, $2, 'role-hr', now())
         ON CONFLICT DO NOTHING`,
        [hrTeamId, DEPLOYMENT_BUSINESS_ID]
      );
      await db.query(
        `INSERT INTO knowledge_pages
           (id, title, content, plain_text, source, source_id, tags, author_kind, author_id,
            created_at, updated_at)
         VALUES
           ($1, 'Private', 'private', 'private', 'authored', 'private', '{}', 'user', $3,
            now(), now()),
           ($2, 'Public', 'public', 'public', 'authored', 'public', '{}', NULL, NULL, now(), now())`,
        [privatePage, publicPage, privateOwner]
      );
      await db.query(
        `INSERT INTO knowledge_acl_entries
           (business_id, subject_kind, subject_id, principal_kind, principal_id, effect, capability)
         VALUES
           ($1, 'page', $2, 'user', $3, 'grant', 'read'),
           ($1, 'page', $4, 'role', 'role-everyone', 'grant', 'read')`,
        [DEPLOYMENT_BUSINESS_ID, privatePage, privateOwner, publicPage]
      );
      await db.query(
        `INSERT INTO knowledge_source_records
           (source_id, business_id, integration_id, provider, external_id, external_tenant_id,
            owner_external_id, revision, status, verification, access_control_mode,
            access_control_max_age_seconds, acl_principals, provenance_captured_at,
            provenance_content_hash, last_synced_at, created_at, updated_at)
         VALUES
           ($1, $2, 'integration-1', 'slack', 'external-1', 'tenant-1', 'owner-1', '1',
            'active', 'verified', 'snapshot', 3600, $3::jsonb, now(), 'hash', now(), now(), now())`,
        [
          privateSource,
          DEPLOYMENT_BUSINESS_ID,
          JSON.stringify([{ kind: "user", id: privateOwner }]),
        ]
      );
      await db.query("DELETE FROM asset_ownership WHERE asset_type IN ('file', 'knowledge')");
      await db.query("UPDATE schema_version SET version = 90 WHERE id = true");
      await db.query("DELETE FROM schema_migrations WHERE version >= 91");

      await runPgMigrations(db, undefined, NOOP_LOG);
      await db.query("UPDATE schema_version SET version = 90 WHERE id = true");
      await db.query("DELETE FROM schema_migrations WHERE version >= 91");
      await expect(runPgMigrations(db, undefined, NOOP_LOG)).resolves.toBeUndefined();

      const owners = await db.query<{
        asset_id: string;
        owner_kind: string;
        team_slug: string | null;
        principal_id: string | null;
      }>(
        `SELECT owner.asset_id, owner.owner_kind, team.slug AS team_slug, owner.principal_id
           FROM asset_owners owner
           LEFT JOIN teams team ON team.id = owner.team_id
          WHERE owner.asset_type IN ('file', 'knowledge')
            AND owner.asset_id = ANY($1::text[])
          ORDER BY owner.asset_id`,
        [[fileId, `page:${privatePage}`, `page:${publicPage}`, `source:${privateSource}`]]
      );
      // Every grant the File has is a share — to a person, and to Roles a Team holds — so it must
      // gain no owner at all: naming any recipient would hand a reader the power to re-share,
      // archive and permanently delete it.
      expect(owners.rows).toEqual([
        {
          asset_id: `page:${privatePage}`,
          owner_kind: "principal",
          team_slug: null,
          principal_id: privateOwner,
        },
        {
          asset_id: `page:${publicPage}`,
          owner_kind: "team",
          team_slug: "everyone",
          principal_id: null,
        },
        {
          asset_id: `source:${privateSource}`,
          owner_kind: "principal",
          team_slug: null,
          principal_id: privateOwner,
        },
      ]);
    });
  });

  describe("migration 95", () => {
    it("adds empty labels to existing Teams", async () => {
      await db.query(`CREATE TABLE teams (
        business_id text NOT NULL,
        id text NOT NULL,
        PRIMARY KEY (business_id, id)
      )`);
      await db.query("INSERT INTO teams (business_id, id) VALUES ('business', 'platform')");
      await db.query(`CREATE TABLE schema_version (
        id boolean PRIMARY KEY DEFAULT true,
        version integer NOT NULL,
        CONSTRAINT schema_version_single_row CHECK (id)
      )`);
      await db.query("INSERT INTO schema_version (id, version) VALUES (true, 94)");

      await runPgMigrations(db, undefined, NOOP_LOG);

      const teams = await db.query<{ labels: string[] }>("SELECT labels FROM teams");
      expect(teams.rows).toEqual([{ labels: [] }]);
    });
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
      await seedRunsFkTarget(db);
      await seedApprovalsAlterTarget(db);
      await seedChannelBindTokensAlterTarget(db);
      await seedTurnCompletionsAlterTarget(db);

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
