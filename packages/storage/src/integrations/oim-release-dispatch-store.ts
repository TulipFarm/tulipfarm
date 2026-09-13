import { randomUUID } from "node:crypto";
import type { TransactionPort } from "../ports";
import type { OimReleaseStorageScope } from "./oim-release-lifecycle-store";

export interface AcquireOimReleaseDispatchLeaseInput extends OimReleaseStorageScope {
  readonly packageDigest: string;
  readonly acquiredAt?: string;
  readonly leaseDurationMs?: number;
}

export interface OimReleaseDispatchLease {
  readonly leaseId: string;
  readonly businessId: string;
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly installationId: string;
  readonly packageDigest: string;
  readonly status: "active" | "reconciliation_required" | "released";
  readonly outcome?: "completed" | "not_dispatched";
  readonly reconciliationReason?: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly updatedAt: string;
  readonly releasedAt?: string;
}

interface DispatchLeaseRow {
  lease_id: string;
  business_id: string;
  integration_id: string;
  major_version: number;
  installation_id: string;
  package_digest: string;
  status: "active" | "reconciliation_required" | "released";
  outcome: "completed" | "not_dispatched" | null;
  reconciliation_reason: string | null;
  acquired_at: Date | string;
  expires_at: Date | string;
  updated_at: Date | string;
  released_at: Date | string | null;
}

function timestamp(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function leaseFromRow(row: DispatchLeaseRow): OimReleaseDispatchLease {
  return {
    leaseId: row.lease_id,
    businessId: row.business_id,
    integrationId: row.integration_id,
    majorVersion: row.major_version,
    installationId: row.installation_id,
    packageDigest: row.package_digest,
    status: row.status,
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    ...(row.reconciliation_reason === null
      ? {}
      : { reconciliationReason: row.reconciliation_reason }),
    acquiredAt: timestamp(row.acquired_at),
    expiresAt: timestamp(row.expires_at),
    updatedAt: timestamp(row.updated_at),
    ...(row.released_at === null ? {} : { releasedAt: timestamp(row.released_at) }),
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

export class OimReleaseDispatchLeaseStore {
  constructor(private readonly transactions: TransactionPort) {}

  async acquire(input: AcquireOimReleaseDispatchLeaseInput): Promise<OimReleaseDispatchLease> {
    assertScope(input);
    if (!/^[0-9a-f]{64}$/.test(input.packageDigest)) {
      throw new Error("invalid_oim_release_package_digest");
    }
    const acquiredAt = input.acquiredAt ?? new Date().toISOString();
    const leaseDurationMs = input.leaseDurationMs ?? 60_000;
    if (
      !Number.isSafeInteger(leaseDurationMs) ||
      leaseDurationMs < 1 ||
      leaseDurationMs > 300_000
    ) {
      throw new Error("invalid_oim_release_dispatch_lease_duration");
    }
    const expiresAt = new Date(Date.parse(acquiredAt) + leaseDurationMs).toISOString();
    return this.transactions.withTransaction(async (transaction) => {
      const lifecycle = await transaction.query<{
        installation_id: string;
        phase: "installed" | "uninstall_pending" | "uninstalled";
      }>(
        `SELECT installation_id, phase
           FROM oim_release_lifecycle_state
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
          FOR UPDATE`,
        [input.businessId, input.integrationId, input.majorVersion]
      );
      if (lifecycle.rows[0]?.phase !== "installed") throw new Error("oim_uninstall_pending");
      const installationId = lifecycle.rows[0].installation_id;
      const provenance = await transaction.query(
        `SELECT 1
           FROM oim_installed_release_provenance
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND installation_id = $4::uuid AND package_digest = $5
            AND recovery_state = 'verified'
          FOR UPDATE`,
        [
          input.businessId,
          input.integrationId,
          input.majorVersion,
          installationId,
          input.packageDigest,
        ]
      );
      if (provenance.rows.length !== 1) throw new Error("oim_release_provenance_mismatch");
      const result = await transaction.query<DispatchLeaseRow>(
        `INSERT INTO oim_release_dispatch_leases (
           lease_id, business_id, integration_id, major_version, installation_id,
           package_digest, status, acquired_at, expires_at, updated_at
         ) VALUES (
           $1::uuid, $2, $3, $4, $5::uuid, $6, 'active',
           $7::timestamptz, $8::timestamptz, $7::timestamptz
         )
         RETURNING *`,
        [
          randomUUID(),
          input.businessId,
          input.integrationId,
          input.majorVersion,
          installationId,
          input.packageDigest,
          acquiredAt,
          expiresAt,
        ]
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("oim_release_dispatch_lease_not_created");
      return leaseFromRow(row);
    });
  }

  async complete(leaseId: string, completedAt = new Date().toISOString()): Promise<void> {
    await this.release(leaseId, "completed", completedAt);
  }

  async releaseNotDispatched(
    leaseId: string,
    releasedAt = new Date().toISOString()
  ): Promise<void> {
    await this.release(leaseId, "not_dispatched", releasedAt);
  }

  async markReconciliationRequired(
    leaseId: string,
    reason: string,
    updatedAt = new Date().toISOString()
  ): Promise<void> {
    if (reason.length === 0) throw new Error("invalid_oim_dispatch_reconciliation_reason");
    await this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE oim_release_dispatch_leases
            SET status = 'reconciliation_required',
                reconciliation_reason = $2,
                updated_at = $3::timestamptz
          WHERE lease_id = $1::uuid AND status = 'active'
          RETURNING lease_id`,
        [leaseId, reason, updatedAt]
      );
      if (result.rows.length !== 1) throw new Error("oim_release_dispatch_lease_not_active");
    });
  }

  async listUnresolved(
    scope: OimReleaseStorageScope,
    observedAt = new Date().toISOString()
  ): Promise<readonly OimReleaseDispatchLease[]> {
    assertScope(scope);
    return this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `UPDATE oim_release_dispatch_leases
            SET status = 'reconciliation_required',
                reconciliation_reason = COALESCE(
                  reconciliation_reason,
                  'lease_expired_without_dispatch_outcome'
                ),
                updated_at = $4::timestamptz
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND status = 'active' AND expires_at <= $4::timestamptz`,
        [scope.businessId, scope.integrationId, scope.majorVersion, observedAt]
      );
      const result = await transaction.query<DispatchLeaseRow>(
        `SELECT *
           FROM oim_release_dispatch_leases
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND status <> 'released'
          ORDER BY acquired_at, lease_id`,
        [scope.businessId, scope.integrationId, scope.majorVersion]
      );
      return result.rows.map(leaseFromRow);
    });
  }

  async reconcile(
    leaseId: string,
    outcome: "completed" | "not_dispatched",
    reconciledAt = new Date().toISOString()
  ): Promise<void> {
    await this.release(leaseId, outcome, reconciledAt, "reconciliation_required");
  }

  private async release(
    leaseId: string,
    outcome: "completed" | "not_dispatched",
    releasedAt: string,
    requiredStatus: "active" | "reconciliation_required" = "active"
  ): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE oim_release_dispatch_leases
            SET status = 'released',
                outcome = $2,
                released_at = $3::timestamptz,
                updated_at = $3::timestamptz
          WHERE lease_id = $1::uuid AND status = $4
          RETURNING lease_id`,
        [leaseId, outcome, releasedAt, requiredStatus]
      );
      if (result.rows.length !== 1) throw new Error("oim_release_dispatch_lease_not_active");
    });
  }
}
