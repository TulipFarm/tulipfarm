import type { Queryable, TransactionPort } from "../ports";

export type ConnectionIdentityProofKind = "auth" | "health";

export interface VerifiedConnectionExternalIdentity {
  readonly businessId: string;
  readonly connectionId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly externalTenantId: string;
  readonly externalAccountId: string;
  readonly proofKind: ConnectionIdentityProofKind;
  readonly proofDigest: string;
  readonly verifiedAt: string;
  readonly verifiedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BindVerifiedConnectionExternalIdentity {
  readonly businessId: string;
  readonly connectionId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly externalTenantId: string;
  readonly externalAccountId: string;
  readonly proofKind: ConnectionIdentityProofKind;
  readonly proofDigest: string;
  readonly verifiedAt: string;
  readonly verifiedBy: string;
}

export class ConnectionExternalIdentityConflictError extends Error {
  constructor(connectionId: string) {
    super(`Connection ${connectionId} is already bound to another verified provider identity`);
    this.name = "ConnectionExternalIdentityConflictError";
  }
}

export const CONNECTION_EXTERNAL_IDENTITY_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS connection_external_identities (
    business_id                 text NOT NULL,
    connection_id               text NOT NULL,
    integration_id              text NOT NULL,
    integration_major_version   integer NOT NULL CHECK (integration_major_version >= 0),
    external_tenant_id          text NOT NULL CHECK (length(external_tenant_id) > 0),
    external_account_id         text NOT NULL CHECK (length(external_account_id) > 0),
    proof_kind                  text NOT NULL CHECK (proof_kind IN ('auth', 'health')),
    proof_digest                text NOT NULL CHECK (proof_digest ~ '^[0-9a-f]{64}$'),
    verified_at                 timestamptz NOT NULL,
    verified_by                 text NOT NULL CHECK (length(verified_by) > 0),
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, connection_id),
    FOREIGN KEY (
      business_id, connection_id, integration_id, integration_major_version
    ) REFERENCES connections (
      business_id, id, integration_id, integration_major_version
    ) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS connection_external_identities_provider_idx
     ON connection_external_identities (
       business_id,
       integration_id,
       integration_major_version,
       external_tenant_id,
       external_account_id
     )`,
];

export async function bindVerifiedConnectionExternalIdentity(
  transaction: Queryable,
  input: BindVerifiedConnectionExternalIdentity
): Promise<VerifiedConnectionExternalIdentity> {
  assertInput(input);
  const result = await transaction.query<IdentityRow>(
    `INSERT INTO connection_external_identities (
       business_id, connection_id, integration_id, integration_major_version,
       external_tenant_id, external_account_id, proof_kind, proof_digest,
       verified_at, verified_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (business_id, connection_id) DO UPDATE SET
       proof_kind = EXCLUDED.proof_kind,
       proof_digest = EXCLUDED.proof_digest,
       verified_at = EXCLUDED.verified_at,
       verified_by = EXCLUDED.verified_by,
       updated_at = now()
     WHERE connection_external_identities.integration_id = EXCLUDED.integration_id
       AND connection_external_identities.integration_major_version =
         EXCLUDED.integration_major_version
       AND connection_external_identities.external_tenant_id = EXCLUDED.external_tenant_id
       AND connection_external_identities.external_account_id = EXCLUDED.external_account_id
     RETURNING *`,
    [
      input.businessId,
      input.connectionId,
      input.integrationId,
      input.integrationMajorVersion,
      input.externalTenantId,
      input.externalAccountId,
      input.proofKind,
      input.proofDigest,
      input.verifiedAt,
      input.verifiedBy,
    ]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ConnectionExternalIdentityConflictError(input.connectionId);
  }
  return fromRow(row);
}

interface IdentityRow {
  business_id: string;
  connection_id: string;
  integration_id: string;
  integration_major_version: number;
  external_tenant_id: string;
  external_account_id: string;
  proof_kind: ConnectionIdentityProofKind;
  proof_digest: string;
  verified_at: Date | string;
  verified_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function timestamp(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function fromRow(row: IdentityRow): VerifiedConnectionExternalIdentity {
  return {
    businessId: row.business_id,
    connectionId: row.connection_id,
    integrationId: row.integration_id,
    integrationMajorVersion: row.integration_major_version,
    externalTenantId: row.external_tenant_id,
    externalAccountId: row.external_account_id,
    proofKind: row.proof_kind,
    proofDigest: row.proof_digest,
    verifiedAt: timestamp(row.verified_at),
    verifiedBy: row.verified_by,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function assertInput(input: BindVerifiedConnectionExternalIdentity): void {
  if (
    input.businessId.length === 0 ||
    input.connectionId.length === 0 ||
    input.integrationId.length === 0 ||
    !Number.isSafeInteger(input.integrationMajorVersion) ||
    input.integrationMajorVersion < 0 ||
    input.externalTenantId.length === 0 ||
    input.externalAccountId.length === 0 ||
    !/^[0-9a-f]{64}$/.test(input.proofDigest) ||
    input.verifiedBy.length === 0 ||
    !Number.isFinite(new Date(input.verifiedAt).getTime())
  ) {
    throw new Error("invalid_verified_connection_external_identity");
  }
}

/**
 * Durable provider identity proof for a Connection.
 *
 * Tenant/account identity is immutable. A trusted auth or health service may refresh proof only
 * for that same identity; safe Connection configuration is never consulted here.
 */
export class ConnectionExternalIdentityStore {
  constructor(private readonly transactions: TransactionPort) {}

  async bindVerified(
    input: BindVerifiedConnectionExternalIdentity
  ): Promise<VerifiedConnectionExternalIdentity> {
    return this.transactions.withTransaction((transaction) =>
      bindVerifiedConnectionExternalIdentity(transaction, input)
    );
  }

  async find(
    businessId: string,
    connectionId: string
  ): Promise<VerifiedConnectionExternalIdentity | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<IdentityRow>(
        `SELECT * FROM connection_external_identities
          WHERE business_id = $1 AND connection_id = $2`,
        [businessId, connectionId]
      );
      return result.rows[0] === undefined ? null : fromRow(result.rows[0]);
    });
  }
}
