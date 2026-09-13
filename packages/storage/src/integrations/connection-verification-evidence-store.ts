import {
  canonicalHash,
  type OimConnectionVerificationEvidence,
  type OimVerificationBinding,
} from "@tulipfarm/schema";
import type { Queryable, TransactionPort } from "../ports";

export const CONNECTION_VERIFICATION_EVIDENCE_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS connection_verification_evidence (
    business_id       text NOT NULL,
    connection_id     text NOT NULL,
    proof_digest      text NOT NULL CHECK (proof_digest ~ '^[0-9a-f]{64}$'),
    binding_digest    text NOT NULL CHECK (binding_digest ~ '^[0-9a-f]{64}$'),
    package_digest    text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
    configuration_digest text NOT NULL CHECK (configuration_digest ~ '^[0-9a-f]{64}$'),
    assurance         text NOT NULL CHECK (assurance IN ('validity_only', 'identified')),
    evidence          jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
    verified_at       timestamptz NOT NULL,
    invalidated_at    timestamptz,
    invalidation_reason text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, connection_id, proof_digest),
    FOREIGN KEY (business_id, connection_id)
      REFERENCES connections (business_id, id) ON DELETE CASCADE,
    CHECK (
      (invalidated_at IS NULL AND invalidation_reason IS NULL)
      OR (invalidated_at IS NOT NULL AND length(invalidation_reason) > 0)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS connection_verification_evidence_active_idx
     ON connection_verification_evidence (business_id, connection_id)
     WHERE invalidated_at IS NULL`,
];

interface ConnectionBindingRow {
  integration_id: string;
  integration_major_version: number;
  configuration: Readonly<Record<string, string | number | boolean>>;
  secret_bindings: Readonly<Record<string, string>>;
  status: "active" | "revoked";
  health_status: "healthy" | "expiring" | "action_required" | "unknown";
}

interface AuthStepBindingRow {
  step_id: string;
  revision: number | string;
  status: "pending" | "active" | "expired" | "action_required" | "revoked";
}

interface EvidenceRow {
  evidence: OimConnectionVerificationEvidence;
}

async function lockConnection(
  transaction: Queryable,
  businessId: string,
  connectionId: string
): Promise<ConnectionBindingRow | undefined> {
  const connection = await transaction.query<ConnectionBindingRow>(
    `SELECT integration_id, integration_major_version, configuration, secret_bindings,
            status, health_status
       FROM connections
      WHERE business_id = $1 AND id = $2
      FOR UPDATE`,
    [businessId, connectionId]
  );
  return connection.rows[0];
}

async function bindingIsCurrent(
  transaction: Queryable,
  binding: OimVerificationBinding,
  requireHealthy: boolean,
  lockedConnection?: ConnectionBindingRow
): Promise<boolean> {
  const row =
    lockedConnection ??
    (await lockConnection(transaction, binding.businessId, binding.connectionId));
  if (
    row === undefined ||
    row.status !== "active" ||
    (requireHealthy && row.health_status !== "healthy") ||
    row.integration_id !== binding.integrationId ||
    row.integration_major_version !== binding.integrationMajorVersion ||
    canonicalHash(row.configuration) !== binding.configurationDigest
  ) {
    return false;
  }

  const steps = await transaction.query<AuthStepBindingRow>(
    `SELECT step_id, revision, status
       FROM connection_auth_steps
      WHERE business_id = $1 AND connection_id = $2
        AND step_id = ANY($3::text[])
      FOR UPDATE`,
    [binding.businessId, binding.connectionId, binding.authSteps.map((step) => step.stepId)]
  );
  const byId = new Map(steps.rows.map((step) => [step.step_id, step]));
  for (const step of binding.authSteps) {
    const current = byId.get(step.stepId);
    if (
      current === undefined ||
      current.status !== "active" ||
      Number(current.revision) !== step.revision
    ) {
      return false;
    }
    for (const credential of step.credentials) {
      const reference = row.secret_bindings[credential.slot];
      if (reference === undefined || canonicalHash(reference) !== credential.referenceDigest) {
        return false;
      }
    }
  }
  return true;
}

export class ConnectionVerificationEvidenceStore {
  constructor(private readonly transactions: TransactionPort) {}

  async publish(evidence: OimConnectionVerificationEvidence): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await publishConnectionVerificationEvidence(transaction, evidence);
    });
  }

  async findCurrent(
    binding: OimVerificationBinding
  ): Promise<OimConnectionVerificationEvidence | null> {
    return this.transactions.withTransaction(async (transaction) => {
      if (!(await bindingIsCurrent(transaction, binding, true))) return null;
      const result = await transaction.query<EvidenceRow>(
        `SELECT evidence
           FROM connection_verification_evidence
          WHERE business_id = $1 AND connection_id = $2 AND invalidated_at IS NULL`,
        [binding.businessId, binding.connectionId]
      );
      const evidence = result.rows[0]?.evidence;
      if (evidence === undefined || canonicalHash(evidence.binding) !== canonicalHash(binding)) {
        return null;
      }
      return evidence;
    });
  }

  async findCurrentForConnection(
    businessId: string,
    connectionId: string,
    packageDigest: string
  ): Promise<OimConnectionVerificationEvidence | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const connection = await lockConnection(transaction, businessId, connectionId);
      if (connection === undefined) return null;
      const result = await transaction.query<EvidenceRow>(
        `SELECT evidence
           FROM connection_verification_evidence
          WHERE business_id = $1 AND connection_id = $2
            AND package_digest = $3 AND invalidated_at IS NULL`,
        [businessId, connectionId, packageDigest]
      );
      const evidence = result.rows[0]?.evidence;
      if (
        evidence === undefined ||
        evidence.binding.packageDigest !== packageDigest ||
        !(await bindingIsCurrent(transaction, evidence.binding, true, connection))
      ) {
        return null;
      }
      return evidence;
    });
  }

  async invalidate(
    binding: OimVerificationBinding,
    reason: string,
    now = new Date()
  ): Promise<void> {
    if (reason.trim().length === 0) throw new Error("verification_invalidation_reason_required");
    await this.transactions.withTransaction(async (transaction) => {
      await lockConnection(transaction, binding.businessId, binding.connectionId);
      await transaction.query(
        `UPDATE connection_verification_evidence
            SET invalidated_at = $3, invalidation_reason = $4
          WHERE business_id = $1 AND connection_id = $2
            AND binding_digest = $5
            AND invalidated_at IS NULL`,
        [binding.businessId, binding.connectionId, now, reason, canonicalHash(binding)]
      );
    });
  }
}

export async function publishConnectionVerificationEvidence(
  transaction: Queryable,
  evidence: OimConnectionVerificationEvidence
): Promise<void> {
  if (!(await bindingIsCurrent(transaction, evidence.binding, false))) {
    throw new Error("stale_connection_verification_binding");
  }
  await transaction.query(
    `UPDATE connection_verification_evidence
        SET invalidated_at = $3, invalidation_reason = 'superseded'
      WHERE business_id = $1 AND connection_id = $2 AND invalidated_at IS NULL`,
    [evidence.binding.businessId, evidence.binding.connectionId, evidence.verifiedAt]
  );
  await transaction.query(
    `INSERT INTO connection_verification_evidence (
       business_id, connection_id, proof_digest, binding_digest, package_digest,
       configuration_digest, assurance, evidence, verified_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      evidence.binding.businessId,
      evidence.binding.connectionId,
      evidence.proofDigest,
      canonicalHash(evidence.binding),
      evidence.binding.packageDigest,
      evidence.binding.configurationDigest,
      evidence.assurance,
      JSON.stringify(evidence),
      evidence.verifiedAt,
    ]
  );
  await transaction.query(
    `UPDATE connections
        SET health_status = CASE
              WHEN NOT EXISTS (
                SELECT 1
                  FROM connection_auth_steps
                 WHERE business_id = $1 AND connection_id = $2 AND status <> 'active'
              ) THEN 'healthy'
              ELSE 'action_required'
            END,
            health_checked_at = $3,
            updated_at = now()
      WHERE business_id = $1 AND id = $2 AND status = 'active'`,
    [evidence.binding.businessId, evidence.binding.connectionId, evidence.verifiedAt]
  );
}
