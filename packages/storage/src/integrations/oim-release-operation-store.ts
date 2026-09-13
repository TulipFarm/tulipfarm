import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Queryable, TransactionPort } from "../ports";
import type {
  CompareAndSwapInstalledOimReleaseProvenanceResult,
  OimReleaseSourceProvenance,
  PersistedInstalledOimReleaseProvenance,
  PutInstalledOimReleaseProvenanceInput,
} from "./oim-release-trust-store";
import {
  isValidOimReleaseSourceProvenance,
  oimReleaseSourceStorageValues,
  parseOimAuthoredDraftReleaseSourceProvenance,
} from "./oim-release-trust-store";

export type OimReleaseOperationKind = "install" | "patch" | "replace";
export type OimReleaseOperationPhase =
  | "prepared"
  | "plan_recorded"
  | "soul_written"
  | "provenance_committed"
  | "completed"
  | "rolled_back"
  | "reconciliation_required";

export interface BeginOimReleaseOperationInput {
  readonly kind: OimReleaseOperationKind;
  readonly next: Omit<PutInstalledOimReleaseProvenanceInput, "installationId" | "soulRevision">;
  readonly expected?: OimReleaseExpectedGeneration;
  readonly packageSnapshot: unknown;
  readonly startedAt: string;
}

export interface OimReleaseExpectedGeneration {
  readonly installationId: string;
  readonly version: string;
  readonly packageDigest: string;
  readonly source: OimReleaseSourceProvenance;
  readonly slug: string;
  readonly soulRevision: string;
  readonly updatedAt: string;
}

export interface OimReleaseOperation {
  readonly operationId: string;
  readonly businessId: string;
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly installationId: string;
  readonly kind: OimReleaseOperationKind;
  readonly slug: string;
  readonly phase: OimReleaseOperationPhase;
  readonly expected: OimReleaseExpectedGeneration | null;
  readonly next: Omit<PutInstalledOimReleaseProvenanceInput, "installationId" | "soulRevision">;
  readonly packageSnapshot: unknown;
  readonly writePlan: unknown | null;
  readonly writeReceipt: unknown | null;
  readonly soulRevision: string | null;
  readonly reconciliationReason: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

interface OperationRow {
  operation_id: string;
  business_id: string;
  integration_id: string;
  major_version: number;
  installation_id: string;
  kind: OimReleaseOperationKind;
  slug: string;
  phase: OimReleaseOperationPhase;
  expected_installation_id: string | null;
  expected_version: string | null;
  expected_package_digest: string | null;
  expected_source_kind: OimReleaseSourceProvenance["kind"] | null;
  expected_source: string | null;
  expected_source_ref: string | null;
  expected_candidate_path: string | null;
  expected_authored_draft: unknown | null;
  expected_slug: string | null;
  expected_soul_revision: string | null;
  expected_updated_at: Date | string | null;
  next_version: string;
  next_package_digest: string;
  package_snapshot: unknown;
  source_kind: OimReleaseSourceProvenance["kind"];
  source: string | null;
  source_ref: string | null;
  candidate_path: string | null;
  authored_draft: unknown | null;
  trust_class: "official" | "community";
  signed_release: unknown | null;
  approved_community_digest: string | null;
  original_requirements: unknown;
  auto_patch_opt_in: boolean;
  write_plan: unknown | null;
  write_receipt: unknown | null;
  soul_revision: string | null;
  reconciliation_reason: string | null;
  started_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

function timestamp(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function releaseSource(
  kind: OimReleaseSourceProvenance["kind"],
  repository: string | null,
  ref: string | null,
  path: string | null,
  authoredDraft: unknown | null
): OimReleaseSourceProvenance {
  if (
    kind === "git" &&
    repository !== null &&
    ref !== null &&
    path !== null &&
    authoredDraft === null
  ) {
    return { kind, repository, ref, path };
  }
  if (
    kind === "authored_draft" &&
    repository === null &&
    ref === null &&
    path === null &&
    authoredDraft !== null
  ) {
    return parseOimAuthoredDraftReleaseSourceProvenance(authoredDraft);
  }
  throw new Error("oim_release_operation_source_invalid");
}

function sourceSqlValues(source: OimReleaseSourceProvenance) {
  const [kind, repository, ref, path, authoredDraft] = oimReleaseSourceStorageValues(source);
  return [
    kind,
    repository,
    ref,
    path,
    authoredDraft === null ? null : JSON.stringify(authoredDraft),
  ] as const;
}

function operationFromRow(row: OperationRow): OimReleaseOperation {
  const next = {
    businessId: row.business_id,
    integrationId: row.integration_id,
    majorVersion: row.major_version,
    version: row.next_version,
    packageDigest: row.next_package_digest,
    source: releaseSource(
      row.source_kind,
      row.source,
      row.source_ref,
      row.candidate_path,
      row.authored_draft
    ),
    slug: row.slug,
    trustClass: row.trust_class,
    ...(row.signed_release === null ? {} : { signedRelease: row.signed_release }),
    ...(row.approved_community_digest === null
      ? {}
      : { approvedCommunityDigest: row.approved_community_digest }),
    originalRequirements: row.original_requirements,
    autoPatchOptIn: row.auto_patch_opt_in,
  };
  const expected =
    row.expected_installation_id === null ||
    row.expected_version === null ||
    row.expected_package_digest === null ||
    row.expected_source_kind === null ||
    row.expected_slug === null ||
    row.expected_soul_revision === null ||
    row.expected_updated_at === null
      ? null
      : {
          version: row.expected_version,
          packageDigest: row.expected_package_digest,
          source: releaseSource(
            row.expected_source_kind,
            row.expected_source,
            row.expected_source_ref,
            row.expected_candidate_path,
            row.expected_authored_draft
          ),
          slug: row.expected_slug,
          soulRevision: row.expected_soul_revision,
          installationId: row.expected_installation_id,
          updatedAt: timestamp(row.expected_updated_at),
        };
  return {
    operationId: row.operation_id,
    businessId: row.business_id,
    integrationId: row.integration_id,
    majorVersion: row.major_version,
    installationId: row.installation_id,
    kind: row.kind,
    slug: row.slug,
    phase: row.phase,
    expected,
    next,
    packageSnapshot: row.package_snapshot,
    writePlan: row.write_plan,
    writeReceipt: row.write_receipt,
    soulRevision: row.soul_revision,
    reconciliationReason: row.reconciliation_reason,
    startedAt: timestamp(row.started_at),
    updatedAt: timestamp(row.updated_at),
    completedAt: row.completed_at === null ? null : timestamp(row.completed_at),
  };
}

function sameBegin(row: OperationRow, input: BeginOimReleaseOperationInput): boolean {
  const expected = input.expected;
  return (
    row.kind === input.kind &&
    row.slug === input.next.slug &&
    row.next_version === input.next.version &&
    row.next_package_digest === input.next.packageDigest &&
    isDeepStrictEqual(row.package_snapshot, input.packageSnapshot) &&
    isDeepStrictEqual(
      releaseSource(
        row.source_kind,
        row.source,
        row.source_ref,
        row.candidate_path,
        row.authored_draft
      ),
      input.next.source
    ) &&
    row.trust_class === input.next.trustClass &&
    isDeepStrictEqual(row.signed_release, input.next.signedRelease ?? null) &&
    row.approved_community_digest === (input.next.approvedCommunityDigest ?? null) &&
    isDeepStrictEqual(row.original_requirements, input.next.originalRequirements) &&
    row.auto_patch_opt_in === input.next.autoPatchOptIn &&
    row.expected_installation_id === (expected?.installationId ?? null) &&
    row.expected_version === (expected?.version ?? null) &&
    row.expected_package_digest === (expected?.packageDigest ?? null) &&
    (expected === undefined ||
      isDeepStrictEqual(
        releaseSource(
          row.expected_source_kind as OimReleaseSourceProvenance["kind"],
          row.expected_source,
          row.expected_source_ref,
          row.expected_candidate_path,
          row.expected_authored_draft
        ),
        expected.source
      )) &&
    row.expected_slug === (expected?.slug ?? null) &&
    row.expected_soul_revision === (expected?.soulRevision ?? null) &&
    (row.expected_updated_at === null
      ? expected === undefined
      : expected !== undefined &&
        timestamp(row.expected_updated_at) === timestamp(expected.updatedAt))
  );
}

async function lockedOperation(transaction: Queryable, operationId: string): Promise<OperationRow> {
  const result = await transaction.query<OperationRow>(
    "SELECT * FROM oim_release_install_operations WHERE operation_id = $1::uuid FOR UPDATE",
    [operationId]
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("oim_release_operation_missing");
  return row;
}

export class OimReleaseOperationStore {
  constructor(private readonly transactions: TransactionPort) {}

  async begin(input: BeginOimReleaseOperationInput): Promise<OimReleaseOperation> {
    const { next, expected } = input;
    if (
      (input.kind === "install" && expected !== undefined) ||
      (input.kind !== "install" && expected === undefined) ||
      (expected !== undefined &&
        (!isValidOimReleaseSourceProvenance(expected.source, next.businessId) ||
          expected.slug.length === 0 ||
          expected.slug !== next.slug)) ||
      next.businessId.length === 0 ||
      next.integrationId.length === 0 ||
      next.slug.length === 0 ||
      !isValidOimReleaseSourceProvenance(next.source, next.businessId) ||
      typeof input.packageSnapshot !== "object" ||
      input.packageSnapshot === null ||
      Array.isArray(input.packageSnapshot) ||
      !/^[0-9a-f]{64}$/.test(next.packageDigest)
    ) {
      throw new Error("invalid_oim_release_operation");
    }
    return this.transactions.withTransaction(async (transaction) => {
      const existing = await transaction.query<OperationRow>(
        `SELECT *
           FROM oim_release_install_operations
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND phase NOT IN ('completed', 'rolled_back')
          FOR UPDATE`,
        [next.businessId, next.integrationId, next.majorVersion]
      );
      if (existing.rows[0] !== undefined) {
        if (!sameBegin(existing.rows[0], input)) {
          throw new Error("oim_release_operation_pending");
        }
        return operationFromRow(existing.rows[0]);
      }

      const operationId = randomUUID();
      const installationId =
        input.kind === "patch" ? (expected?.installationId as string) : randomUUID();
      const reservation =
        input.kind === "install"
          ? await transaction.query(
              `INSERT INTO oim_release_slug_reservations (
                 business_id, slug, integration_id, major_version, installation_id, operation_id,
                 state
               ) VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid, 'install_pending')
               ON CONFLICT (business_id, slug) DO NOTHING
               RETURNING installation_id`,
              [
                next.businessId,
                next.slug,
                next.integrationId,
                next.majorVersion,
                installationId,
                operationId,
              ]
            )
          : await transaction.query(
              `UPDATE oim_release_slug_reservations
                  SET installation_id = $5::uuid, operation_id = $6::uuid,
                      state = 'install_pending', updated_at = $7::timestamptz
                WHERE business_id = $1 AND slug = $2
                  AND integration_id = $3 AND major_version = $4
                  AND installation_id = $8::uuid AND state = 'installed'
                RETURNING installation_id`,
              [
                next.businessId,
                next.slug,
                next.integrationId,
                next.majorVersion,
                installationId,
                operationId,
                input.startedAt,
                expected?.installationId,
              ]
            );
      if (reservation.rows.length !== 1) throw new Error("oim_release_location_conflict");
      const expectedSource =
        expected === undefined ? [null, null, null, null, null] : sourceSqlValues(expected.source);
      const nextSource = sourceSqlValues(next.source);
      const inserted = await transaction.query<OperationRow>(
        `INSERT INTO oim_release_install_operations (
           operation_id, business_id, integration_id, major_version, installation_id, kind, slug,
           phase, expected_installation_id, expected_version, expected_package_digest,
           expected_source_kind, expected_source, expected_source_ref, expected_candidate_path,
           expected_authored_draft, expected_slug, expected_soul_revision, expected_updated_at,
           next_version, next_package_digest, package_snapshot, source_kind, source, source_ref,
           candidate_path, authored_draft, trust_class, signed_release, approved_community_digest,
           original_requirements, auto_patch_opt_in, started_at, updated_at
         ) VALUES (
           $1::uuid, $2, $3, $4, $5::uuid, $6, $7, 'prepared', $8::uuid, $9, $10,
           $11, $12, $13, $14, $15::jsonb, $16, $17, $18::timestamptz, $19, $20, $21::jsonb,
           $22, $23, $24, $25, $26::jsonb, $27, $28::jsonb, $29, $30::jsonb, $31,
           $32::timestamptz, $32::timestamptz
         )
         RETURNING *`,
        [
          operationId,
          next.businessId,
          next.integrationId,
          next.majorVersion,
          installationId,
          input.kind,
          next.slug,
          expected?.installationId ?? null,
          expected?.version ?? null,
          expected?.packageDigest ?? null,
          ...expectedSource,
          expected?.slug ?? null,
          expected?.soulRevision ?? null,
          expected?.updatedAt ?? null,
          next.version,
          next.packageDigest,
          JSON.stringify(input.packageSnapshot),
          ...nextSource,
          next.trustClass,
          next.signedRelease === undefined ? null : JSON.stringify(next.signedRelease),
          next.approvedCommunityDigest ?? null,
          JSON.stringify(next.originalRequirements),
          next.autoPatchOptIn,
          input.startedAt,
        ]
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("oim_release_operation_not_persisted");
      return operationFromRow(row);
    });
  }

  async get(operationId: string): Promise<OimReleaseOperation | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<OperationRow>(
        "SELECT * FROM oim_release_install_operations WHERE operation_id = $1::uuid",
        [operationId]
      );
      return result.rows[0] === undefined ? null : operationFromRow(result.rows[0]);
    });
  }

  async listPending(): Promise<readonly OimReleaseOperation[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<OperationRow>(
        `SELECT *
           FROM oim_release_install_operations
          WHERE phase NOT IN ('completed', 'rolled_back')
          ORDER BY started_at, operation_id`
      );
      return result.rows.map(operationFromRow);
    });
  }

  async recordPlan(operationId: string, plan: unknown, updatedAt: string): Promise<void> {
    await this.advance(operationId, "prepared", "plan_recorded", updatedAt, {
      column: "write_plan",
      value: plan,
    });
  }

  async recordSoulWrite(
    operationId: string,
    receipt: unknown,
    soulRevision: string,
    updatedAt: string
  ): Promise<void> {
    if (soulRevision.length === 0) throw new Error("invalid_oim_release_soul_revision");
    await this.transactions.withTransaction(async (transaction) => {
      const row = await lockedOperation(transaction, operationId);
      if (
        (row.phase === "soul_written" ||
          row.phase === "provenance_committed" ||
          row.phase === "completed") &&
        row.soul_revision === soulRevision &&
        isDeepStrictEqual(row.write_receipt, receipt)
      ) {
        return;
      }
      if (row.phase !== "plan_recorded") throw new Error("oim_release_operation_phase_mismatch");
      const updated = await transaction.query(
        `UPDATE oim_release_install_operations
            SET phase = 'soul_written', write_receipt = $2::jsonb, soul_revision = $3,
                updated_at = GREATEST(updated_at, $4::timestamptz)
          WHERE operation_id = $1::uuid AND phase = 'plan_recorded'
          RETURNING operation_id`,
        [operationId, JSON.stringify(receipt), soulRevision, updatedAt]
      );
      if (updated.rows.length !== 1) throw new Error("oim_release_operation_phase_mismatch");
    });
  }

  async commitProvenance(
    operationId: string,
    committedAt: string
  ): Promise<CompareAndSwapInstalledOimReleaseProvenanceResult> {
    return this.transactions.withTransaction(async (transaction) => {
      const row = await lockedOperation(transaction, operationId);
      if (row.phase === "provenance_committed" || row.phase === "completed") {
        const provenance = await this.readCommittedProvenance(transaction, row);
        return { status: "updated", provenance };
      }
      if (row.phase !== "soul_written" || row.soul_revision === null) {
        throw new Error("oim_release_operation_phase_mismatch");
      }
      const result =
        row.kind === "install"
          ? await this.commitInstall(transaction, row)
          : row.kind === "patch"
            ? await this.commitPatch(transaction, row)
            : await this.commitReplace(transaction, row);
      if (result.status === "skipped") return result;
      await transaction.query(
        `UPDATE oim_release_install_operations
            SET phase = 'provenance_committed',
                updated_at = GREATEST(updated_at, $2::timestamptz)
          WHERE operation_id = $1::uuid AND phase = 'soul_written'`,
        [operationId, committedAt]
      );
      return result;
    });
  }

  async markCompleted(operationId: string, completedAt: string): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      const row = await lockedOperation(transaction, operationId);
      if (row.phase === "completed") return;
      if (row.phase !== "provenance_committed") {
        throw new Error("oim_release_operation_phase_mismatch");
      }
      await transaction.query(
        `UPDATE oim_release_install_operations
            SET phase = 'completed', completed_at = $2::timestamptz,
                updated_at = GREATEST(updated_at, $2::timestamptz)
          WHERE operation_id = $1::uuid`,
        [operationId, completedAt]
      );
    });
  }

  async markRolledBack(operationId: string, completedAt: string): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      const row = await lockedOperation(transaction, operationId);
      if (row.phase === "rolled_back") return;
      if (
        !["prepared", "plan_recorded", "soul_written", "reconciliation_required"].includes(
          row.phase
        )
      ) {
        throw new Error("oim_release_operation_phase_mismatch");
      }
      if (row.kind === "install") {
        await transaction.query(
          `DELETE FROM oim_release_slug_reservations
            WHERE business_id = $1 AND slug = $2 AND operation_id = $3::uuid
              AND installation_id = $4::uuid`,
          [row.business_id, row.slug, row.operation_id, row.installation_id]
        );
      } else if (row.kind === "patch") {
        await transaction.query(
          `UPDATE oim_release_slug_reservations
              SET operation_id = NULL, state = 'installed', updated_at = $4::timestamptz
            WHERE business_id = $1 AND slug = $2 AND operation_id = $3::uuid`,
          [row.business_id, row.slug, row.operation_id, completedAt]
        );
      } else {
        await transaction.query(
          `UPDATE oim_release_slug_reservations
              SET installation_id = $4::uuid, operation_id = NULL, state = 'installed',
                  updated_at = $5::timestamptz
            WHERE business_id = $1 AND slug = $2 AND operation_id = $3::uuid`,
          [row.business_id, row.slug, row.operation_id, row.expected_installation_id, completedAt]
        );
      }
      await transaction.query(
        `UPDATE oim_release_install_operations
            SET phase = 'rolled_back', completed_at = $2::timestamptz,
                updated_at = GREATEST(updated_at, $2::timestamptz)
          WHERE operation_id = $1::uuid`,
        [operationId, completedAt]
      );
    });
  }

  async requireReconciliation(
    operationId: string,
    reason: string,
    updatedAt: string
  ): Promise<void> {
    if (reason.length === 0) throw new Error("invalid_oim_release_reconciliation_reason");
    await this.transactions.withTransaction(async (transaction) => {
      const row = await lockedOperation(transaction, operationId);
      if (row.phase === "completed" || row.phase === "rolled_back") return;
      await transaction.query(
        `UPDATE oim_release_install_operations
            SET phase = 'reconciliation_required', reconciliation_reason = $2,
                updated_at = GREATEST(updated_at, $3::timestamptz)
          WHERE operation_id = $1::uuid`,
        [operationId, reason, updatedAt]
      );
    });
  }

  async resumeReconciliation(operationId: string, updatedAt: string): Promise<OimReleaseOperation> {
    return this.transactions.withTransaction(async (transaction) => {
      const row = await lockedOperation(transaction, operationId);
      if (row.phase !== "reconciliation_required") return operationFromRow(row);
      const phase = row.write_plan === null ? "prepared" : "plan_recorded";
      const updated = await transaction.query<OperationRow>(
        `UPDATE oim_release_install_operations
            SET phase = $2, reconciliation_reason = NULL,
                updated_at = GREATEST(updated_at, $3::timestamptz)
          WHERE operation_id = $1::uuid AND phase = 'reconciliation_required'
          RETURNING *`,
        [operationId, phase, updatedAt]
      );
      const resumed = updated.rows[0];
      if (resumed === undefined) throw new Error("oim_release_operation_phase_mismatch");
      return operationFromRow(resumed);
    });
  }

  private async advance(
    operationId: string,
    expected: OimReleaseOperationPhase,
    next: OimReleaseOperationPhase,
    updatedAt: string,
    payload: { readonly column: "write_plan"; readonly value: unknown }
  ): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      const row = await lockedOperation(transaction, operationId);
      if (
        (row.phase === next ||
          row.phase === "soul_written" ||
          row.phase === "provenance_committed" ||
          row.phase === "completed") &&
        isDeepStrictEqual(row.write_plan, payload.value)
      ) {
        return;
      }
      if (row.phase !== expected) throw new Error("oim_release_operation_phase_mismatch");
      const updated = await transaction.query(
        `UPDATE oim_release_install_operations
            SET phase = $2, write_plan = $3::jsonb,
                updated_at = GREATEST(updated_at, $4::timestamptz)
          WHERE operation_id = $1::uuid AND phase = $5
          RETURNING operation_id`,
        [operationId, next, JSON.stringify(payload.value), updatedAt, expected]
      );
      if (updated.rows.length !== 1) throw new Error("oim_release_operation_phase_mismatch");
    });
  }

  private async commitInstall(
    transaction: Queryable,
    row: OperationRow
  ): Promise<CompareAndSwapInstalledOimReleaseProvenanceResult> {
    const existing = await transaction.query<ProvenanceRow>(
      `SELECT * FROM oim_installed_release_provenance
        WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
        FOR UPDATE`,
      [row.business_id, row.integration_id, row.major_version]
    );
    if (existing.rows[0] !== undefined) {
      if (
        existing.rows[0].installation_id === row.installation_id &&
        existing.rows[0].version === row.next_version &&
        existing.rows[0].package_digest === row.next_package_digest &&
        existing.rows[0].soul_revision === row.soul_revision
      ) {
        return { status: "updated", provenance: provenanceFromOperationRow(row, existing.rows[0]) };
      }
      return { status: "skipped", reason: "installed_release_changed" };
    }
    await transaction.query(
      `INSERT INTO oim_installed_release_provenance (
         business_id, integration_id, major_version, version, package_digest, source_kind,
         source, source_ref, candidate_path, authored_draft, slug, soul_revision, trust_class,
         signed_release, approved_community_digest, original_requirements, auto_patch_opt_in,
         installation_id, recovery_state
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14::jsonb, $15,
         $16::jsonb, $17, $18::uuid, 'verified'
       )`,
      operationProvenanceParams(row)
    );
    const lifecycle = await transaction.query(
      `INSERT INTO oim_release_lifecycle_state (
         business_id, integration_id, major_version, installation_id, slug, phase
       ) VALUES ($1, $2, $3, $4::uuid, $5, 'installed')
       ON CONFLICT (business_id, integration_id, major_version) DO UPDATE SET
         installation_id = EXCLUDED.installation_id,
         slug = EXCLUDED.slug,
         phase = 'installed',
         updated_at = now()
       WHERE oim_release_lifecycle_state.phase = 'uninstalled'
       RETURNING installation_id`,
      [row.business_id, row.integration_id, row.major_version, row.installation_id, row.slug]
    );
    if (lifecycle.rows.length !== 1) throw new Error("oim_release_install_generation_conflict");
    await this.markReservationInstalled(transaction, row);
    return {
      status: "updated",
      provenance: await this.readCommittedProvenance(transaction, row),
    };
  }

  private async commitPatch(
    transaction: Queryable,
    row: OperationRow
  ): Promise<CompareAndSwapInstalledOimReleaseProvenanceResult> {
    const current = await transaction.query<ProvenanceRow>(
      `SELECT * FROM oim_installed_release_provenance
        WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
        FOR UPDATE`,
      [row.business_id, row.integration_id, row.major_version]
    );
    const existing = current.rows[0];
    if (
      existing === undefined ||
      existing.installation_id !== row.expected_installation_id ||
      existing.version !== row.expected_version ||
      existing.package_digest !== row.expected_package_digest ||
      existing.source_kind !== row.expected_source_kind ||
      existing.source !== row.expected_source ||
      existing.source_ref !== row.expected_source_ref ||
      existing.candidate_path !== row.expected_candidate_path ||
      !isDeepStrictEqual(existing.authored_draft, row.expected_authored_draft) ||
      existing.slug !== row.expected_slug ||
      existing.soul_revision !== row.expected_soul_revision ||
      timestamp(existing.updated_at) !== timestamp(row.expected_updated_at as Date | string)
    ) {
      if (
        existing?.installation_id === row.installation_id &&
        existing.version === row.next_version &&
        existing.package_digest === row.next_package_digest &&
        existing.soul_revision === row.soul_revision
      ) {
        await this.markReservationInstalled(transaction, row);
        return { status: "updated", provenance: provenanceFromOperationRow(row, existing) };
      }
      return { status: "skipped", reason: "installed_release_changed" };
    }
    if (!existing.auto_patch_opt_in) {
      return { status: "skipped", reason: "auto_patch_disabled" };
    }
    const updated = await transaction.query<ProvenanceRow>(
      `UPDATE oim_installed_release_provenance
          SET version = $4, package_digest = $5, source_kind = $6, source = $7,
              source_ref = $8, candidate_path = $9, authored_draft = $10::jsonb,
              soul_revision = $11,
              trust_class = $12, signed_release = $13::jsonb,
              approved_community_digest = $14,
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 millisecond')
        WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
          AND installation_id = $15::uuid
        RETURNING *`,
      [
        row.business_id,
        row.integration_id,
        row.major_version,
        row.next_version,
        row.next_package_digest,
        row.source_kind,
        row.source,
        row.source_ref,
        row.candidate_path,
        row.authored_draft === null ? null : JSON.stringify(row.authored_draft),
        row.soul_revision,
        row.trust_class,
        row.signed_release === null ? null : JSON.stringify(row.signed_release),
        row.approved_community_digest,
        row.installation_id,
      ]
    );
    const provenance = updated.rows[0];
    if (provenance === undefined) {
      return { status: "skipped", reason: "installed_release_changed" };
    }
    await this.markReservationInstalled(transaction, row);
    return { status: "updated", provenance: provenanceFromOperationRow(row, provenance) };
  }

  private async commitReplace(
    transaction: Queryable,
    row: OperationRow
  ): Promise<CompareAndSwapInstalledOimReleaseProvenanceResult> {
    const current = await transaction.query<ProvenanceRow>(
      `SELECT * FROM oim_installed_release_provenance
        WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
        FOR UPDATE`,
      [row.business_id, row.integration_id, row.major_version]
    );
    const existing = current.rows[0];
    if (
      existing === undefined ||
      existing.installation_id !== row.expected_installation_id ||
      existing.version !== row.expected_version ||
      existing.package_digest !== row.expected_package_digest ||
      existing.source_kind !== row.expected_source_kind ||
      existing.source !== row.expected_source ||
      existing.source_ref !== row.expected_source_ref ||
      existing.candidate_path !== row.expected_candidate_path ||
      !isDeepStrictEqual(existing.authored_draft, row.expected_authored_draft) ||
      existing.slug !== row.expected_slug ||
      existing.soul_revision !== row.expected_soul_revision ||
      timestamp(existing.updated_at) !== timestamp(row.expected_updated_at as Date | string)
    ) {
      if (
        existing?.installation_id === row.installation_id &&
        existing.version === row.next_version &&
        existing.package_digest === row.next_package_digest &&
        existing.soul_revision === row.soul_revision
      ) {
        await this.markReservationInstalled(transaction, row);
        return { status: "updated", provenance: provenanceFromOperationRow(row, existing) };
      }
      return { status: "skipped", reason: "installed_release_changed" };
    }
    const updated = await transaction.query<ProvenanceRow>(
      `UPDATE oim_installed_release_provenance
          SET installation_id = $4::uuid, version = $5, package_digest = $6,
              source_kind = $7, source = $8, source_ref = $9, candidate_path = $10,
              authored_draft = $11::jsonb, soul_revision = $12, trust_class = $13,
              signed_release = $14::jsonb, approved_community_digest = $15,
              original_requirements = $16::jsonb, auto_patch_opt_in = $17,
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 millisecond')
        WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
          AND installation_id = $18::uuid
        RETURNING *`,
      [
        row.business_id,
        row.integration_id,
        row.major_version,
        row.installation_id,
        row.next_version,
        row.next_package_digest,
        row.source_kind,
        row.source,
        row.source_ref,
        row.candidate_path,
        row.authored_draft === null ? null : JSON.stringify(row.authored_draft),
        row.soul_revision,
        row.trust_class,
        row.signed_release === null ? null : JSON.stringify(row.signed_release),
        row.approved_community_digest,
        JSON.stringify(row.original_requirements),
        row.auto_patch_opt_in,
        row.expected_installation_id,
      ]
    );
    const provenance = updated.rows[0];
    if (provenance === undefined) {
      return { status: "skipped", reason: "installed_release_changed" };
    }
    const lifecycle = await transaction.query(
      `UPDATE oim_release_lifecycle_state
          SET installation_id = $4::uuid, updated_at = now()
        WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
          AND installation_id = $5::uuid AND slug = $6 AND phase = 'installed'
        RETURNING installation_id`,
      [
        row.business_id,
        row.integration_id,
        row.major_version,
        row.installation_id,
        row.expected_installation_id,
        row.slug,
      ]
    );
    if (lifecycle.rows.length !== 1) throw new Error("oim_release_install_generation_conflict");
    await this.markReservationInstalled(transaction, row);
    return { status: "updated", provenance: provenanceFromOperationRow(row, provenance) };
  }

  private async markReservationInstalled(transaction: Queryable, row: OperationRow): Promise<void> {
    const updated = await transaction.query(
      `UPDATE oim_release_slug_reservations
          SET operation_id = NULL, state = 'installed', updated_at = now()
        WHERE business_id = $1 AND slug = $2 AND operation_id = $3::uuid
          AND installation_id = $4::uuid
        RETURNING installation_id`,
      [row.business_id, row.slug, row.operation_id, row.installation_id]
    );
    if (updated.rows.length !== 1) throw new Error("oim_release_location_conflict");
  }

  private async readCommittedProvenance(
    transaction: Queryable,
    row: OperationRow
  ): Promise<PersistedInstalledOimReleaseProvenance> {
    const result = await transaction.query<ProvenanceRow>(
      `SELECT * FROM oim_installed_release_provenance
        WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
          AND installation_id = $4::uuid`,
      [row.business_id, row.integration_id, row.major_version, row.installation_id]
    );
    const provenance = result.rows[0];
    if (provenance === undefined) throw new Error("oim_release_provenance_not_committed");
    return provenanceFromOperationRow(row, provenance);
  }
}

interface ProvenanceRow {
  installation_id: string;
  version: string;
  package_digest: string;
  source_kind: OimReleaseSourceProvenance["kind"];
  source: string | null;
  source_ref: string | null;
  candidate_path: string | null;
  authored_draft: unknown | null;
  slug: string;
  soul_revision: string;
  trust_class: "official" | "community";
  signed_release: unknown | null;
  approved_community_digest: string | null;
  original_requirements: unknown;
  auto_patch_opt_in: boolean;
  installed_at: Date | string;
  updated_at: Date | string;
}

function operationProvenanceParams(row: OperationRow): readonly unknown[] {
  return [
    row.business_id,
    row.integration_id,
    row.major_version,
    row.next_version,
    row.next_package_digest,
    row.source_kind,
    row.source,
    row.source_ref,
    row.candidate_path,
    row.authored_draft === null ? null : JSON.stringify(row.authored_draft),
    row.slug,
    row.soul_revision,
    row.trust_class,
    row.signed_release === null ? null : JSON.stringify(row.signed_release),
    row.approved_community_digest,
    JSON.stringify(row.original_requirements),
    row.auto_patch_opt_in,
    row.installation_id,
  ];
}

function provenanceFromOperationRow(
  operation: OperationRow,
  row: ProvenanceRow
): PersistedInstalledOimReleaseProvenance {
  return {
    businessId: operation.business_id,
    integrationId: operation.integration_id,
    majorVersion: operation.major_version,
    installationId: row.installation_id,
    version: row.version,
    packageDigest: row.package_digest,
    source: releaseSource(
      row.source_kind,
      row.source,
      row.source_ref,
      row.candidate_path,
      row.authored_draft
    ),
    slug: row.slug,
    soulRevision: row.soul_revision,
    trustClass: row.trust_class,
    ...(row.signed_release === null ? {} : { signedRelease: row.signed_release }),
    ...(row.approved_community_digest === null
      ? {}
      : { approvedCommunityDigest: row.approved_community_digest }),
    originalRequirements: row.original_requirements,
    autoPatchOptIn: row.auto_patch_opt_in,
    installedAt: timestamp(row.installed_at),
    updatedAt: timestamp(row.updated_at),
  };
}
