import type { Queryable, TransactionPort } from "../ports";
import type {
  OimReleaseLifecycleStore,
  OimReleaseStorageScope,
} from "./oim-release-lifecycle-store";

export interface OimReleaseStorageTarget extends OimReleaseStorageScope {
  readonly installationId: string;
  readonly slug: string;
  readonly packageDigest: string;
  readonly soulRevision: string;
}

export type OimReleaseStorageUninstallStep =
  | "traffic_fenced_and_drained"
  | "remote_unsubscribed"
  | "connections_revoked"
  | "owned_state_removed"
  | "release_provenance_removed"
  | "soul_package_removed";

export type OimReleaseStorageUninstallStage =
  | OimReleaseStorageUninstallStep
  | "operation_completed";

export interface OimReleaseStorageUninstallRetry {
  readonly step: OimReleaseStorageUninstallStage;
  readonly message: string;
  readonly failedAt: string;
}

export interface OimReleaseStorageUninstallJournal extends OimReleaseStorageTarget {
  readonly status: "pending" | "complete";
  readonly completedSteps: readonly OimReleaseStorageUninstallStep[];
  readonly revokedConnectionIds: readonly string[];
  readonly inFlightWorkIds: readonly string[];
  readonly retry: OimReleaseStorageUninstallRetry | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

interface JournalRow {
  business_id: string;
  integration_id: string;
  major_version: number;
  installation_id: string;
  slug: string;
  package_digest: string;
  soul_revision: string;
  status: "pending" | "complete";
  completed_steps: OimReleaseStorageUninstallStep[];
  revoked_connection_ids: string[];
  in_flight_work_ids: string[];
  retry: OimReleaseStorageUninstallRetry | null;
  started_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

interface LifecycleRow {
  installation_id: string;
  slug: string;
  phase: "installed" | "uninstall_pending" | "uninstalled";
}

const STEPS: readonly OimReleaseStorageUninstallStep[] = [
  "traffic_fenced_and_drained",
  "remote_unsubscribed",
  "connections_revoked",
  "owned_state_removed",
  "release_provenance_removed",
  "soul_package_removed",
];

function timestamp(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function journalFromRow(row: JournalRow): OimReleaseStorageUninstallJournal {
  return {
    businessId: row.business_id,
    integrationId: row.integration_id,
    majorVersion: row.major_version,
    installationId: row.installation_id,
    slug: row.slug,
    packageDigest: row.package_digest,
    soulRevision: row.soul_revision,
    status: row.status,
    completedSteps: row.completed_steps,
    revokedConnectionIds: row.revoked_connection_ids,
    inFlightWorkIds: row.in_flight_work_ids,
    retry: row.retry,
    startedAt: timestamp(row.started_at),
    updatedAt: timestamp(row.updated_at),
    completedAt: row.completed_at === null ? null : timestamp(row.completed_at),
  };
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

function assertTarget(target: OimReleaseStorageTarget): void {
  assertScope(target);
  if (
    target.installationId.length === 0 ||
    target.slug.length === 0 ||
    !/^[0-9a-f]{64}$/.test(target.packageDigest) ||
    target.soulRevision.length === 0
  ) {
    throw new Error("invalid_oim_release_installation");
  }
}

function scopeParams(scope: OimReleaseStorageScope): readonly [string, string, number] {
  return [scope.businessId, scope.integrationId, scope.majorVersion];
}

async function lockedLifecycle(
  transaction: Queryable,
  scope: OimReleaseStorageScope
): Promise<LifecycleRow | undefined> {
  const result = await transaction.query<LifecycleRow>(
    `SELECT installation_id, slug, phase
       FROM oim_release_lifecycle_state
      WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
      FOR UPDATE`,
    scopeParams(scope)
  );
  return result.rows[0];
}

async function lockedJournal(
  transaction: Queryable,
  target: OimReleaseStorageScope & { readonly installationId: string }
): Promise<JournalRow | undefined> {
  const result = await transaction.query<JournalRow>(
    `SELECT *
       FROM oim_release_uninstall_journals
      WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
        AND installation_id = $4::uuid
      FOR UPDATE`,
    [...scopeParams(target), target.installationId]
  );
  return result.rows[0];
}

function requireCurrentTarget(
  lifecycle: LifecycleRow | undefined,
  target: OimReleaseStorageTarget
): LifecycleRow {
  if (lifecycle === undefined) throw new Error("oim_release_installation_missing");
  if (lifecycle.installation_id !== target.installationId || lifecycle.slug !== target.slug) {
    throw new Error("oim_uninstall_generation_mismatch");
  }
  return lifecycle;
}

function requirePendingJournal(
  row: JournalRow | undefined,
  target: OimReleaseStorageTarget
): JournalRow {
  if (row === undefined) throw new Error("oim_uninstall_journal_missing");
  if (
    row.installation_id !== target.installationId ||
    row.slug !== target.slug ||
    row.package_digest !== target.packageDigest ||
    row.soul_revision !== target.soulRevision
  ) {
    throw new Error("oim_uninstall_generation_mismatch");
  }
  if (row.status !== "pending") throw new Error("oim_uninstall_not_pending");
  return row;
}

/** PostgreSQL implementation of the release package's durable uninstall journal port. */
export class OimReleaseUninstallJournalStore {
  constructor(
    private readonly transactions: TransactionPort,
    private readonly lifecycle: Pick<OimReleaseLifecycleStore, "runExclusive">
  ) {}

  runExclusive<T>(scope: OimReleaseStorageScope, operation: () => Promise<T>): Promise<T> {
    return this.lifecycle.runExclusive(scope, operation);
  }

  async begin(
    target: OimReleaseStorageTarget,
    startedAt: string
  ): Promise<OimReleaseStorageUninstallJournal> {
    assertTarget(target);
    return this.transactions.withTransaction(async (transaction) => {
      const lifecycle = requireCurrentTarget(await lockedLifecycle(transaction, target), target);
      const existing = await lockedJournal(transaction, target);
      if (existing !== undefined) {
        if (
          existing.slug !== target.slug ||
          existing.package_digest !== target.packageDigest ||
          existing.soul_revision !== target.soulRevision
        ) {
          throw new Error("oim_uninstall_generation_mismatch");
        }
        if (
          (existing.status === "pending" && lifecycle.phase !== "uninstall_pending") ||
          (existing.status === "complete" && lifecycle.phase === "uninstall_pending")
        ) {
          throw new Error("oim_uninstall_lifecycle_mismatch");
        }
        return journalFromRow(existing);
      }
      if (lifecycle.phase !== "installed") {
        throw new Error("oim_uninstall_generation_mismatch");
      }
      const reserved = await transaction.query(
        `UPDATE oim_release_slug_reservations
            SET state = 'uninstall_pending', updated_at = GREATEST(updated_at, $6::timestamptz)
          WHERE business_id = $1 AND slug = $4
            AND integration_id = $2 AND major_version = $3
            AND installation_id = $5::uuid AND state = 'installed'
          RETURNING installation_id`,
        [
          target.businessId,
          target.integrationId,
          target.majorVersion,
          target.slug,
          target.installationId,
          startedAt,
        ]
      );
      if (reserved.rows.length !== 1) throw new Error("oim_release_location_conflict");
      const provenance = await transaction.query<{
        installation_id: string;
        slug: string;
        package_digest: string;
        soul_revision: string;
      }>(
        `SELECT installation_id, slug, package_digest, soul_revision
           FROM oim_installed_release_provenance
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND recovery_state = 'verified'
          FOR UPDATE`,
        scopeParams(target)
      );
      if (
        provenance.rows[0]?.installation_id !== target.installationId ||
        provenance.rows[0]?.slug !== target.slug ||
        provenance.rows[0]?.package_digest !== target.packageDigest ||
        provenance.rows[0]?.soul_revision !== target.soulRevision
      ) {
        throw new Error("oim_release_installation_missing");
      }
      const inserted = await transaction.query<JournalRow>(
        `INSERT INTO oim_release_uninstall_journals (
           business_id, integration_id, major_version, installation_id, slug,
           package_digest, soul_revision, status, started_at, updated_at
         ) VALUES (
           $1, $2, $3, $4::uuid, $5, $6, $7, 'pending', $8::timestamptz, $8::timestamptz
         )
         ON CONFLICT (business_id, integration_id, major_version, installation_id) DO NOTHING
         RETURNING *`,
        [
          ...scopeParams(target),
          target.installationId,
          target.slug,
          target.packageDigest,
          target.soulRevision,
          startedAt,
        ]
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("oim_uninstall_pending");
      const fenced = await transaction.query(
        `UPDATE oim_release_lifecycle_state
            SET phase = 'uninstall_pending',
                updated_at = GREATEST(updated_at, $4::timestamptz)
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND installation_id = $5::uuid AND phase = 'installed'
          RETURNING installation_id`,
        [...scopeParams(target), startedAt, target.installationId]
      );
      if (fenced.rows.length !== 1) throw new Error("oim_uninstall_generation_mismatch");
      return journalFromRow(row);
    });
  }

  async get(
    scope: OimReleaseStorageScope & { readonly installationId: string }
  ): Promise<OimReleaseStorageUninstallJournal | null> {
    assertScope(scope);
    if (scope.installationId.length === 0) throw new Error("invalid_oim_release_installation");
    return this.transactions.withTransaction(async (transaction) => {
      const lifecycle = await lockedLifecycle(transaction, scope);
      const journal = await lockedJournal(transaction, scope);
      if (journal === undefined) return null;
      if (journal.status === "pending") {
        if (
          lifecycle?.phase !== "uninstall_pending" ||
          lifecycle.installation_id !== journal.installation_id
        ) {
          throw new Error("oim_uninstall_lifecycle_mismatch");
        }
      } else if (
        lifecycle?.installation_id === journal.installation_id &&
        lifecycle.phase !== "uninstalled"
      ) {
        throw new Error("oim_uninstall_lifecycle_mismatch");
      }
      return journalFromRow(journal);
    });
  }

  async markStepCompleted(
    target: OimReleaseStorageTarget,
    step: OimReleaseStorageUninstallStep,
    completedAt: string,
    inFlightWorkIds: readonly string[] = []
  ): Promise<void> {
    assertTarget(target);
    const stepIndex = STEPS.indexOf(step);
    if (stepIndex < 0) throw new Error("invalid_oim_uninstall_step");
    await this.transactions.withTransaction(async (transaction) => {
      requireCurrentTarget(await lockedLifecycle(transaction, target), target);
      const journal = requirePendingJournal(await lockedJournal(transaction, target), target);
      if (journal.completed_steps.includes(step)) return;
      const missingPredecessor = STEPS.slice(0, stepIndex).find(
        (required) => !journal.completed_steps.includes(required)
      );
      if (missingPredecessor !== undefined) throw new Error("oim_uninstall_step_out_of_order");
      if (step === "release_provenance_removed") {
        const provenance = await transaction.query(
          `SELECT 1
             FROM oim_installed_release_provenance
            WHERE business_id = $1 AND integration_id = $2 AND major_version = $3`,
          scopeParams(target)
        );
        if (provenance.rows.length !== 0) {
          throw new Error("oim_release_provenance_still_present");
        }
      }
      const updated = await transaction.query(
        `UPDATE oim_release_uninstall_journals
            SET completed_steps = array_append(completed_steps, $5),
                in_flight_work_ids = CASE
                  WHEN $5 = 'traffic_fenced_and_drained' THEN $6::text[]
                  ELSE in_flight_work_ids
                END,
                retry = NULL,
                updated_at = GREATEST(updated_at, $4::timestamptz)
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND installation_id = $7::uuid AND status = 'pending'
          RETURNING installation_id`,
        [
          ...scopeParams(target),
          completedAt,
          step,
          [...new Set(inFlightWorkIds)],
          target.installationId,
        ]
      );
      if (updated.rows.length !== 1) throw new Error("oim_uninstall_generation_mismatch");
    });
  }

  async markConnectionRevoked(
    target: OimReleaseStorageTarget,
    connectionId: string,
    updatedAt: string
  ): Promise<void> {
    assertTarget(target);
    if (connectionId.length === 0) throw new Error("invalid_oim_connection_id");
    await this.transactions.withTransaction(async (transaction) => {
      requireCurrentTarget(await lockedLifecycle(transaction, target), target);
      const journal = requirePendingJournal(await lockedJournal(transaction, target), target);
      if (!journal.completed_steps.includes("remote_unsubscribed")) {
        throw new Error("oim_uninstall_step_out_of_order");
      }
      const updated = await transaction.query(
        `UPDATE oim_release_uninstall_journals
            SET revoked_connection_ids = CASE
                  WHEN $5 = ANY(revoked_connection_ids) THEN revoked_connection_ids
                  ELSE array_append(revoked_connection_ids, $5)
                END,
                retry = NULL,
                updated_at = GREATEST(updated_at, $4::timestamptz)
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND installation_id = $6::uuid AND status = 'pending'
          RETURNING installation_id`,
        [...scopeParams(target), updatedAt, connectionId, target.installationId]
      );
      if (updated.rows.length !== 1) throw new Error("oim_uninstall_generation_mismatch");
    });
  }

  async markRetryRequired(
    target: OimReleaseStorageTarget,
    retry: OimReleaseStorageUninstallRetry
  ): Promise<void> {
    assertTarget(target);
    await this.transactions.withTransaction(async (transaction) => {
      requireCurrentTarget(await lockedLifecycle(transaction, target), target);
      requirePendingJournal(await lockedJournal(transaction, target), target);
      const updated = await transaction.query(
        `UPDATE oim_release_uninstall_journals
            SET retry = $5::jsonb, updated_at = GREATEST(updated_at, $6::timestamptz)
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND installation_id = $4::uuid AND status = 'pending'
          RETURNING installation_id`,
        [...scopeParams(target), target.installationId, JSON.stringify(retry), retry.failedAt]
      );
      if (updated.rows.length !== 1) throw new Error("oim_uninstall_generation_mismatch");
    });
  }

  async markCompleted(target: OimReleaseStorageTarget, completedAt: string): Promise<void> {
    assertTarget(target);
    await this.transactions.withTransaction(async (transaction) => {
      const lifecycle = requireCurrentTarget(await lockedLifecycle(transaction, target), target);
      const journal = requirePendingJournal(await lockedJournal(transaction, target), target);
      if (
        lifecycle.phase !== "uninstall_pending" ||
        STEPS.some((step) => !journal.completed_steps.includes(step))
      ) {
        throw new Error("oim_uninstall_cleanup_incomplete");
      }
      const provenance = await transaction.query(
        `SELECT 1
           FROM oim_installed_release_provenance
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3`,
        scopeParams(target)
      );
      if (provenance.rows.length !== 0) throw new Error("oim_release_provenance_still_present");
      const completed = await transaction.query(
        `UPDATE oim_release_uninstall_journals
            SET status = 'complete', retry = NULL,
                completed_at = GREATEST(updated_at, $4::timestamptz),
                updated_at = GREATEST(updated_at, $4::timestamptz)
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND installation_id = $5::uuid AND status = 'pending'
          RETURNING installation_id`,
        [...scopeParams(target), completedAt, target.installationId]
      );
      if (completed.rows.length !== 1) throw new Error("oim_uninstall_generation_mismatch");
      const lifecycleCompleted = await transaction.query(
        `UPDATE oim_release_lifecycle_state
            SET phase = 'uninstalled', updated_at = GREATEST(updated_at, $4::timestamptz)
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND installation_id = $5::uuid AND phase = 'uninstall_pending'
          RETURNING installation_id`,
        [...scopeParams(target), completedAt, target.installationId]
      );
      if (lifecycleCompleted.rows.length !== 1) {
        throw new Error("oim_uninstall_generation_mismatch");
      }
      const released = await transaction.query(
        `DELETE FROM oim_release_slug_reservations
          WHERE business_id = $1 AND slug = $4
            AND integration_id = $2 AND major_version = $3
            AND installation_id = $5::uuid AND state = 'uninstall_pending'
          RETURNING installation_id`,
        [
          target.businessId,
          target.integrationId,
          target.majorVersion,
          target.slug,
          target.installationId,
        ]
      );
      if (released.rows.length !== 1) throw new Error("oim_release_location_conflict");
    });
  }
}
