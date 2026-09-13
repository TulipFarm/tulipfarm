import type { Queryable, TransactionPort } from "../ports";

export interface OimReleaseStorageScope {
  readonly businessId: string;
  readonly integrationId: string;
  readonly majorVersion: number;
}

export interface OimReleaseInstallStorageScope extends OimReleaseStorageScope {
  readonly slug: string;
}

export interface OimReleaseSession extends Queryable {
  release(): void;
}

export interface OimReleaseSessionSource {
  connect(): Promise<OimReleaseSession>;
}

export const OIM_RELEASE_LIFECYCLE_STORAGE_STATEMENTS: readonly string[] = [
  `ALTER TABLE oim_installed_release_provenance
     ADD COLUMN IF NOT EXISTS installation_id uuid`,
  `ALTER TABLE oim_installed_release_provenance
     ADD COLUMN IF NOT EXISTS slug text`,
  `ALTER TABLE oim_installed_release_provenance
     ADD COLUMN IF NOT EXISTS source_ref text`,
  `ALTER TABLE oim_installed_release_provenance
     ADD COLUMN IF NOT EXISTS candidate_path text`,
  `ALTER TABLE oim_installed_release_provenance
     ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'git'
       CHECK (source_kind IN ('git', 'authored_draft'))`,
  `ALTER TABLE oim_installed_release_provenance
     ADD COLUMN IF NOT EXISTS authored_draft jsonb`,
  `ALTER TABLE oim_installed_release_provenance
     ALTER COLUMN source DROP NOT NULL`,
  `ALTER TABLE oim_installed_release_provenance
     ADD COLUMN IF NOT EXISTS soul_revision text`,
  `ALTER TABLE oim_installed_release_provenance
     ADD COLUMN IF NOT EXISTS recovery_state text NOT NULL DEFAULT 'quarantined'
       CHECK (recovery_state IN ('verified', 'quarantined'))`,
  `UPDATE oim_installed_release_provenance
      SET auto_patch_opt_in = false
    WHERE recovery_state = 'quarantined'`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1
         FROM pg_constraint
        WHERE conname = 'oim_installed_release_verified_location'
          AND conrelid = 'oim_installed_release_provenance'::regclass
     ) THEN
       ALTER TABLE oim_installed_release_provenance
         ADD CONSTRAINT oim_installed_release_verified_location CHECK (
           (
             recovery_state = 'verified'
             AND installation_id IS NOT NULL
             AND slug IS NOT NULL
             AND soul_revision IS NOT NULL
             AND (
               (
                 source_kind = 'git'
                 AND source IS NOT NULL
                 AND source_ref IS NOT NULL
                 AND candidate_path IS NOT NULL
                 AND authored_draft IS NULL
               )
               OR (
                 source_kind = 'authored_draft'
                 AND source IS NULL
                 AND source_ref IS NULL
                 AND candidate_path IS NULL
                 AND jsonb_typeof(authored_draft) = 'object'
               )
             )
           )
           OR (
             recovery_state = 'quarantined'
             AND installation_id IS NULL
             AND slug IS NULL
             AND source_ref IS NULL
             AND candidate_path IS NULL
             AND soul_revision IS NULL
             AND auto_patch_opt_in = false
           )
         );
     END IF;
   END
   $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS oim_installed_release_installation_idx
     ON oim_installed_release_provenance (
       business_id, integration_id, major_version, installation_id
     ) WHERE recovery_state = 'verified'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS oim_installed_release_slug_idx
     ON oim_installed_release_provenance (business_id, slug)
     WHERE recovery_state = 'verified'`,
  `CREATE TABLE IF NOT EXISTS oim_release_lifecycle_state (
    business_id     text NOT NULL,
    integration_id  text NOT NULL,
    major_version   integer NOT NULL CHECK (major_version >= 0),
    installation_id uuid NOT NULL,
    slug            text NOT NULL,
    phase           text NOT NULL CHECK (phase IN ('installed', 'uninstall_pending', 'uninstalled')),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, integration_id, major_version)
  )`,
  `INSERT INTO oim_release_lifecycle_state (
     business_id, integration_id, major_version, installation_id, slug, phase
   )
   SELECT business_id, integration_id, major_version, installation_id, slug, 'installed'
     FROM oim_installed_release_provenance
    WHERE recovery_state = 'verified'
   ON CONFLICT (business_id, integration_id, major_version) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS oim_release_slug_reservations (
    business_id     text NOT NULL,
    slug            text NOT NULL,
    integration_id  text NOT NULL,
    major_version   integer NOT NULL CHECK (major_version >= 0),
    installation_id uuid NOT NULL,
    operation_id    uuid,
    state           text NOT NULL CHECK (
      state IN ('install_pending', 'installed', 'uninstall_pending')
    ),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, slug)
  )`,
  `INSERT INTO oim_release_slug_reservations (
     business_id, slug, integration_id, major_version, installation_id, state
   )
   SELECT business_id, slug, integration_id, major_version, installation_id, 'installed'
     FROM oim_installed_release_provenance
    WHERE recovery_state = 'verified'
   ON CONFLICT (business_id, slug) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS oim_release_install_operations (
    operation_id             uuid PRIMARY KEY,
    business_id              text NOT NULL,
    integration_id           text NOT NULL,
    major_version            integer NOT NULL CHECK (major_version >= 0),
    installation_id          uuid NOT NULL,
    kind                     text NOT NULL CHECK (kind IN ('install', 'patch', 'replace')),
    slug                     text NOT NULL,
    phase                    text NOT NULL CHECK (
      phase IN (
        'prepared',
        'plan_recorded',
        'soul_written',
        'provenance_committed',
        'completed',
        'rolled_back',
        'reconciliation_required'
      )
    ),
    expected_installation_id uuid,
    expected_version         text,
    expected_package_digest  text CHECK (
      expected_package_digest IS NULL OR expected_package_digest ~ '^[0-9a-f]{64}$'
    ),
    expected_source_kind     text CHECK (
      expected_source_kind IS NULL OR expected_source_kind IN ('git', 'authored_draft')
    ),
    expected_source          text,
    expected_source_ref      text,
    expected_candidate_path  text,
    expected_authored_draft  jsonb,
    expected_slug            text,
    expected_soul_revision   text,
    expected_updated_at      timestamptz,
    next_version             text NOT NULL,
    next_package_digest      text NOT NULL CHECK (next_package_digest ~ '^[0-9a-f]{64}$'),
    package_snapshot         jsonb NOT NULL CHECK (jsonb_typeof(package_snapshot) = 'object'),
    source_kind              text NOT NULL CHECK (source_kind IN ('git', 'authored_draft')),
    source                   text,
    source_ref               text,
    candidate_path           text,
    authored_draft           jsonb,
    trust_class              text NOT NULL CHECK (trust_class IN ('official', 'community')),
    signed_release           jsonb,
    approved_community_digest text CHECK (
      approved_community_digest IS NULL
      OR approved_community_digest ~ '^[0-9a-f]{64}$'
    ),
    original_requirements    jsonb NOT NULL CHECK (jsonb_typeof(original_requirements) = 'object'),
    auto_patch_opt_in        boolean NOT NULL,
    write_plan               jsonb,
    write_receipt            jsonb,
    soul_revision            text,
    reconciliation_reason    text,
    started_at               timestamptz NOT NULL,
    updated_at               timestamptz NOT NULL,
    completed_at             timestamptz,
    CHECK (
      (
        kind = 'install'
        AND expected_installation_id IS NULL
        AND expected_source_kind IS NULL
        AND expected_version IS NULL
        AND expected_package_digest IS NULL
        AND expected_source IS NULL
        AND expected_source_ref IS NULL
        AND expected_candidate_path IS NULL
        AND expected_authored_draft IS NULL
        AND expected_slug IS NULL
        AND expected_soul_revision IS NULL
        AND expected_updated_at IS NULL
      )
      OR (
        kind IN ('patch', 'replace')
        AND (
          (kind = 'patch' AND expected_installation_id = installation_id)
          OR (kind = 'replace' AND expected_installation_id <> installation_id)
        )
        AND expected_version IS NOT NULL
        AND expected_package_digest IS NOT NULL
        AND expected_source_kind IS NOT NULL
        AND expected_slug IS NOT NULL
        AND expected_soul_revision IS NOT NULL
        AND expected_updated_at IS NOT NULL
        AND (
          (
            expected_source_kind = 'git'
            AND expected_source IS NOT NULL
            AND expected_source_ref IS NOT NULL
            AND expected_candidate_path IS NOT NULL
            AND expected_authored_draft IS NULL
          )
          OR (
            expected_source_kind = 'authored_draft'
            AND expected_source IS NULL
            AND expected_source_ref IS NULL
            AND expected_candidate_path IS NULL
            AND jsonb_typeof(expected_authored_draft) = 'object'
          )
        )
      )
    ),
    CHECK (
      (
        source_kind = 'git'
        AND source IS NOT NULL
        AND source_ref IS NOT NULL
        AND candidate_path IS NOT NULL
        AND authored_draft IS NULL
      )
      OR (
        source_kind = 'authored_draft'
        AND source IS NULL
        AND source_ref IS NULL
        AND candidate_path IS NULL
        AND jsonb_typeof(authored_draft) = 'object'
      )
    ),
    CHECK (
      (phase IN ('prepared', 'plan_recorded', 'soul_written', 'reconciliation_required')
       AND completed_at IS NULL)
      OR
      (phase IN ('provenance_committed', 'completed', 'rolled_back'))
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS oim_release_install_operation_pending_idx
     ON oim_release_install_operations (business_id, integration_id, major_version)
     WHERE phase NOT IN ('completed', 'rolled_back')`,
  `CREATE TABLE IF NOT EXISTS oim_release_uninstall_journals (
    business_id            text NOT NULL,
    integration_id         text NOT NULL,
    major_version          integer NOT NULL CHECK (major_version >= 0),
    installation_id        uuid NOT NULL,
    slug                   text NOT NULL,
    package_digest         text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
    soul_revision          text NOT NULL,
    status                 text NOT NULL CHECK (status IN ('pending', 'complete')),
    completed_steps        text[] NOT NULL DEFAULT '{}',
    revoked_connection_ids text[] NOT NULL DEFAULT '{}',
    in_flight_work_ids     text[] NOT NULL DEFAULT '{}',
    retry                  jsonb,
    started_at             timestamptz NOT NULL,
    updated_at             timestamptz NOT NULL,
    completed_at           timestamptz,
    PRIMARY KEY (business_id, integration_id, major_version, installation_id),
    CHECK (
      completed_steps <@ ARRAY[
        'traffic_fenced_and_drained',
        'remote_unsubscribed',
        'connections_revoked',
        'owned_state_removed',
        'release_provenance_removed',
        'soul_package_removed'
      ]::text[]
    ),
    CHECK (
      (status = 'pending' AND completed_at IS NULL)
      OR (status = 'complete' AND completed_at IS NOT NULL)
    ),
    CHECK (retry IS NULL OR jsonb_typeof(retry) = 'object')
  )`,
  `CREATE TABLE IF NOT EXISTS oim_release_dispatch_leases (
    lease_id           uuid PRIMARY KEY,
    business_id        text NOT NULL,
    integration_id     text NOT NULL,
    major_version      integer NOT NULL CHECK (major_version >= 0),
    installation_id    uuid NOT NULL,
    package_digest     text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
    status             text NOT NULL CHECK (
      status IN ('active', 'reconciliation_required', 'released')
    ),
    outcome            text CHECK (outcome IN ('completed', 'not_dispatched')),
    reconciliation_reason text,
    acquired_at        timestamptz NOT NULL,
    expires_at         timestamptz NOT NULL,
    updated_at         timestamptz NOT NULL,
    released_at        timestamptz,
    CHECK (expires_at > acquired_at),
    CHECK (
      (status = 'released' AND outcome IS NOT NULL AND released_at IS NOT NULL)
      OR (status <> 'released' AND outcome IS NULL AND released_at IS NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS oim_release_dispatch_unresolved_idx
     ON oim_release_dispatch_leases (business_id, integration_id, major_version, status)
     WHERE status <> 'released'`,
  `CREATE TABLE IF NOT EXISTS oim_known_signed_releases (
    integration_id text NOT NULL,
    version         text NOT NULL,
    package_digest  text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
    key_id          text NOT NULL,
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (integration_id, version, package_digest)
  )`,
];

interface LifecycleRow {
  slug: string;
  phase: "installed" | "uninstall_pending" | "uninstalled";
}

function assertScope(scope: OimReleaseStorageScope): void {
  if (
    scope.businessId.length === 0 ||
    scope.integrationId.length === 0 ||
    !Number.isSafeInteger(scope.majorVersion) ||
    scope.majorVersion < 0
  ) {
    throw new Error("invalid_oim_release_scope");
  }
}

function lockIdentity(scope: OimReleaseStorageScope): string {
  return [
    scope.businessId.length,
    scope.businessId,
    scope.integrationId.length,
    scope.integrationId,
    scope.majorVersion,
  ].join(":");
}

/**
 * One PostgreSQL session lock shared by install, patch, and uninstall for an exact Integration
 * major. The transaction port is used only for short state checks, never across external work.
 */
export class OimReleaseLifecycleStore {
  constructor(
    private readonly sessions: OimReleaseSessionSource,
    private readonly transactions: TransactionPort
  ) {}

  async runExclusive<T>(scope: OimReleaseStorageScope, operation: () => Promise<T>): Promise<T> {
    assertScope(scope);
    const identity = lockIdentity(scope);
    const session = await this.sessions.connect();
    let locked = false;
    let outcome:
      | { readonly ok: true; readonly value: T }
      | { readonly ok: false; readonly error: unknown };
    try {
      await session.query("SELECT pg_advisory_lock(hashtextextended($1, 80909)) AS locked", [
        identity,
      ]);
      locked = true;
      outcome = { ok: true, value: await operation() };
    } catch (error) {
      outcome = { ok: false, error };
    }

    let cleanupError: unknown;
    if (locked) {
      try {
        const result = await session.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock(hashtextextended($1, 80909)) AS unlocked",
          [identity]
        );
        if (result.rows[0]?.unlocked !== true) {
          cleanupError = new Error("oim_release_lifecycle_lock_not_released");
        }
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      session.release();
    } catch (error) {
      cleanupError ??= error;
    }

    if (!outcome.ok) {
      if (cleanupError !== undefined) {
        throw new AggregateError(
          [outcome.error, cleanupError],
          "OIM release lifecycle operation and lock cleanup failed"
        );
      }
      throw outcome.error;
    }
    if (cleanupError !== undefined) throw cleanupError;
    return outcome.value;
  }

  async runInstallExclusive<T>(
    scope: OimReleaseInstallStorageScope,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.runExclusive(scope, async () => {
      await this.assertMutationAllowed(scope);
      return operation();
    });
  }

  async runPatchExclusive<T>(
    scope: OimReleaseInstallStorageScope,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.runInstallExclusive(scope, operation);
  }

  private async assertMutationAllowed(scope: OimReleaseInstallStorageScope): Promise<void> {
    if (scope.slug.length === 0) throw new Error("invalid_oim_release_slug");
    await this.transactions.withTransaction(async (transaction) => {
      const lifecycle = await transaction.query<LifecycleRow>(
        `SELECT slug, phase
           FROM oim_release_lifecycle_state
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3`,
        [scope.businessId, scope.integrationId, scope.majorVersion]
      );
      const journal = await transaction.query<{ status: "pending" | "complete" }>(
        `SELECT status
           FROM oim_release_uninstall_journals
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND status = 'pending'`,
        [scope.businessId, scope.integrationId, scope.majorVersion]
      );
      const reservation = await transaction.query<{
        integration_id: string;
        major_version: number;
        state: "install_pending" | "installed" | "uninstall_pending";
      }>(
        `SELECT integration_id, major_version, state
           FROM oim_release_slug_reservations
          WHERE business_id = $1 AND slug = $2`,
        [scope.businessId, scope.slug]
      );
      if (
        lifecycle.rows[0]?.phase === "uninstall_pending" ||
        journal.rows[0]?.status === "pending"
      ) {
        throw new Error("oim_uninstall_pending");
      }
      const owner = reservation.rows[0];
      if (
        owner !== undefined &&
        (owner.integration_id !== scope.integrationId ||
          owner.major_version !== scope.majorVersion ||
          owner.state !== "installed")
      ) {
        throw new Error("oim_release_location_conflict");
      }
      if (lifecycle.rows[0]?.phase === "installed" && lifecycle.rows[0].slug !== scope.slug) {
        throw new Error("oim_release_location_conflict");
      }
    });
  }
}
