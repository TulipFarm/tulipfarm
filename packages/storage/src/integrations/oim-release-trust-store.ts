import type { TransactionPort } from "../ports";

export type OimTrustRootPurpose = "release" | "revocation";
export type OimInstalledReleaseTrustClass = "official" | "community";

export interface OimTrustRoot {
  readonly purpose: OimTrustRootPurpose;
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly disabledAt?: string;
  readonly disabledBy?: string;
}

export interface AddOimTrustRootInput {
  readonly purpose: OimTrustRootPurpose;
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly createdBy: string;
}

export interface OimRevocationFeed {
  readonly url: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly disabledAt?: string;
  readonly disabledBy?: string;
}

export interface SetOimRevocationFeedInput {
  readonly url: string;
  readonly updatedBy: string;
}

export interface InstalledOimReleaseProvenance {
  readonly businessId: string;
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly version: string;
  readonly packageDigest: string;
  readonly source: string;
  readonly trustClass: OimInstalledReleaseTrustClass;
  readonly signedRelease?: unknown;
  readonly approvedCommunityDigest?: string;
  readonly originalRequirements: unknown;
  readonly autoPatchOptIn: boolean;
  readonly installedAt: string;
  readonly updatedAt: string;
}

export interface PutInstalledOimReleaseProvenanceInput {
  readonly businessId: string;
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly version: string;
  readonly packageDigest: string;
  readonly source: string;
  readonly trustClass: OimInstalledReleaseTrustClass;
  readonly signedRelease?: unknown;
  readonly approvedCommunityDigest?: string;
  readonly originalRequirements: unknown;
  readonly autoPatchOptIn: boolean;
}

export class OimTrustRootConflictError extends Error {
  constructor(purpose: OimTrustRootPurpose, keyId: string) {
    super(`OIM ${purpose} trust root ${keyId} already exists with different key material`);
    this.name = "OimTrustRootConflictError";
  }
}

class OimAutoPatchPreferenceError extends Error {
  constructor(readonly code: "community_oim_release_auto_patch_forbidden") {
    super(code);
    this.name = "OimAutoPatchPreferenceError";
  }
}

export const OIM_RELEASE_TRUST_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS oim_release_trust_roots (
    purpose        text NOT NULL CHECK (purpose IN ('release', 'revocation')),
    key_id         text NOT NULL,
    public_key_pem text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     text NOT NULL,
    disabled_at    timestamptz,
    disabled_by    text,
    PRIMARY KEY (purpose, key_id),
    CHECK (
      (disabled_at IS NULL AND disabled_by IS NULL)
      OR (disabled_at IS NOT NULL AND disabled_by IS NOT NULL)
    )
  )`,
  `CREATE TABLE IF NOT EXISTS oim_release_revocation_state (
    singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    sequence   bigint NOT NULL CHECK (sequence >= 1),
    envelope   jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS oim_installed_release_provenance (
    business_id              text NOT NULL,
    integration_id           text NOT NULL,
    major_version            integer NOT NULL CHECK (major_version >= 0),
    version                  text NOT NULL,
    package_digest           text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
    source                   text NOT NULL,
    trust_class              text NOT NULL CHECK (trust_class IN ('official', 'community')),
    signed_release           jsonb,
    approved_community_digest text CHECK (
      approved_community_digest IS NULL
      OR approved_community_digest ~ '^[0-9a-f]{64}$'
    ),
    original_requirements    jsonb NOT NULL CHECK (jsonb_typeof(original_requirements) = 'object'),
    auto_patch_opt_in        boolean NOT NULL DEFAULT false,
    installed_at             timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, integration_id, major_version),
    CHECK (
      (
        trust_class = 'official'
        AND signed_release IS NOT NULL
        AND approved_community_digest IS NULL
      )
      OR (
        trust_class = 'community'
        AND signed_release IS NULL
        AND approved_community_digest = package_digest
        AND auto_patch_opt_in = false
      )
    )
  )`,
];

export const OIM_RELEASE_MAINTENANCE_STORAGE_STATEMENTS: readonly string[] = [
  `ALTER TABLE oim_installed_release_provenance
     ALTER COLUMN auto_patch_opt_in SET DEFAULT true`,
  `CREATE TABLE IF NOT EXISTS oim_release_maintenance_config (
    singleton            boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    revocation_feed_url  text NOT NULL,
    updated_at           timestamptz NOT NULL DEFAULT now(),
    updated_by           text NOT NULL,
    disabled_at          timestamptz,
    disabled_by          text,
    CHECK (
      (disabled_at IS NULL AND disabled_by IS NULL)
      OR (disabled_at IS NOT NULL AND disabled_by IS NOT NULL)
    )
  )`,
];

interface TrustRootRow {
  purpose: OimTrustRootPurpose;
  key_id: string;
  public_key_pem: string;
  created_at: Date | string;
  created_by: string;
  disabled_at: Date | string | null;
  disabled_by: string | null;
}

interface RevocationRow {
  envelope: unknown;
}

interface RevocationFeedRow {
  revocation_feed_url: string;
  updated_at: Date | string;
  updated_by: string;
  disabled_at: Date | string | null;
  disabled_by: string | null;
}

interface ProvenanceRow {
  business_id: string;
  integration_id: string;
  major_version: number;
  version: string;
  package_digest: string;
  source: string;
  trust_class: OimInstalledReleaseTrustClass;
  signed_release: unknown | null;
  approved_community_digest: string | null;
  original_requirements: unknown;
  auto_patch_opt_in: boolean;
  installed_at: Date | string;
  updated_at: Date | string;
}

function timestamp(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function rootFromRow(row: TrustRootRow): OimTrustRoot {
  return {
    purpose: row.purpose,
    keyId: row.key_id,
    publicKeyPem: row.public_key_pem,
    createdAt: timestamp(row.created_at),
    createdBy: row.created_by,
    ...(row.disabled_at === null ? {} : { disabledAt: timestamp(row.disabled_at) }),
    ...(row.disabled_by === null ? {} : { disabledBy: row.disabled_by }),
  };
}

function provenanceFromRow(row: ProvenanceRow): InstalledOimReleaseProvenance {
  return {
    businessId: row.business_id,
    integrationId: row.integration_id,
    majorVersion: row.major_version,
    version: row.version,
    packageDigest: row.package_digest,
    source: row.source,
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

function revocationFeedFromRow(row: RevocationFeedRow): OimRevocationFeed {
  return {
    url: row.revocation_feed_url,
    updatedAt: timestamp(row.updated_at),
    updatedBy: row.updated_by,
    ...(row.disabled_at === null ? {} : { disabledAt: timestamp(row.disabled_at) }),
    ...(row.disabled_by === null ? {} : { disabledBy: row.disabled_by }),
  };
}

function assertRevocationFeed(input: SetOimRevocationFeedInput): void {
  try {
    const url = new URL(input.url);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      input.url.length > 2048 ||
      input.updatedBy.length === 0
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new Error("invalid_oim_revocation_feed");
  }
}

function assertTrustRoot(input: AddOimTrustRootInput): void {
  if (
    !["release", "revocation"].includes(input.purpose) ||
    input.keyId.length === 0 ||
    input.keyId.length > 128 ||
    input.publicKeyPem.length === 0 ||
    input.publicKeyPem.length > 16_384 ||
    input.publicKeyPem.includes("PRIVATE KEY") ||
    input.createdBy.length === 0
  ) {
    throw new Error("invalid_oim_trust_root");
  }
}

function revocationSequence(envelope: unknown): number {
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    !("list" in envelope) ||
    typeof envelope.list !== "object" ||
    envelope.list === null ||
    !("sequence" in envelope.list) ||
    !Number.isSafeInteger(envelope.list.sequence) ||
    (envelope.list.sequence as number) < 1
  ) {
    throw new Error("invalid_oim_revocation_envelope");
  }
  return envelope.list.sequence as number;
}

function assertProvenance(input: PutInstalledOimReleaseProvenanceInput): void {
  if (
    input.businessId.length === 0 ||
    input.integrationId.length === 0 ||
    input.version.length === 0 ||
    !Number.isSafeInteger(input.majorVersion) ||
    input.majorVersion < 0 ||
    !/^[0-9a-f]{64}$/.test(input.packageDigest) ||
    input.source.length === 0 ||
    typeof input.originalRequirements !== "object" ||
    input.originalRequirements === null ||
    Array.isArray(input.originalRequirements)
  ) {
    throw new Error("invalid_oim_release_provenance");
  }
  if (input.trustClass === "official" && input.signedRelease === undefined) {
    throw new Error("official_oim_release_signature_required");
  }
  if (input.trustClass === "official" && input.approvedCommunityDigest !== undefined) {
    throw new Error("official_oim_release_community_approval_forbidden");
  }
  if (input.trustClass === "community") {
    if (input.signedRelease !== undefined) {
      throw new Error("community_oim_release_signature_forbidden");
    }
    if (input.autoPatchOptIn) throw new Error("community_oim_release_auto_patch_forbidden");
    if (input.approvedCommunityDigest !== input.packageDigest) {
      throw new Error("community_oim_release_digest_approval_required");
    }
  }
}

/** Durable operator trust roots, signed revocation state, and installed release provenance. */
export class OimReleaseTrustStore {
  constructor(private readonly transactions: TransactionPort) {}

  async listTrustRoots(includeDisabled = false): Promise<readonly OimTrustRoot[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<TrustRootRow>(
        `SELECT purpose, key_id, public_key_pem, created_at, created_by, disabled_at, disabled_by
           FROM oim_release_trust_roots
          ${includeDisabled ? "" : "WHERE disabled_at IS NULL"}
          ORDER BY purpose, key_id`
      );
      return rows.map(rootFromRow);
    });
  }

  async addTrustRoot(input: AddOimTrustRootInput): Promise<OimTrustRoot> {
    assertTrustRoot(input);
    return this.transactions.withTransaction(async (transaction) => {
      const inserted = await transaction.query<TrustRootRow>(
        `INSERT INTO oim_release_trust_roots (
           purpose, key_id, public_key_pem, created_by
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (purpose, key_id) DO NOTHING
         RETURNING purpose, key_id, public_key_pem, created_at, created_by, disabled_at, disabled_by`,
        [input.purpose, input.keyId, input.publicKeyPem, input.createdBy]
      );
      const created = inserted.rows[0];
      if (created !== undefined) return rootFromRow(created);

      const existing = await transaction.query<TrustRootRow>(
        `SELECT purpose, key_id, public_key_pem, created_at, created_by, disabled_at, disabled_by
           FROM oim_release_trust_roots
          WHERE purpose = $1 AND key_id = $2`,
        [input.purpose, input.keyId]
      );
      const root = existing.rows[0];
      if (
        root !== undefined &&
        root.public_key_pem === input.publicKeyPem &&
        root.disabled_at === null
      ) {
        return rootFromRow(root);
      }
      throw new OimTrustRootConflictError(input.purpose, input.keyId);
    });
  }

  async disableTrustRoot(
    purpose: OimTrustRootPurpose,
    keyId: string,
    disabledBy: string
  ): Promise<OimTrustRoot | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const updated = await transaction.query<TrustRootRow>(
        `UPDATE oim_release_trust_roots
            SET disabled_at = COALESCE(disabled_at, now()),
                disabled_by = COALESCE(disabled_by, $3)
          WHERE purpose = $1 AND key_id = $2
          RETURNING purpose, key_id, public_key_pem, created_at, created_by, disabled_at, disabled_by`,
        [purpose, keyId, disabledBy]
      );
      return updated.rows[0] === undefined ? null : rootFromRow(updated.rows[0]);
    });
  }

  async load(): Promise<unknown> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<RevocationRow>(
        "SELECT envelope FROM oim_release_revocation_state WHERE singleton = true"
      );
      return rows[0]?.envelope;
    });
  }

  async compareAndSwap(expectedSequence: number | undefined, next: unknown): Promise<boolean> {
    const sequence = revocationSequence(next);
    return this.transactions.withTransaction(async (transaction) => {
      const result =
        expectedSequence === undefined
          ? await transaction.query(
              `INSERT INTO oim_release_revocation_state (singleton, sequence, envelope)
               VALUES (true, $1, $2::jsonb)
               ON CONFLICT (singleton) DO NOTHING
               RETURNING sequence`,
              [sequence, JSON.stringify(next)]
            )
          : await transaction.query(
              `UPDATE oim_release_revocation_state
                  SET sequence = $2, envelope = $3::jsonb, updated_at = now()
                WHERE singleton = true AND sequence = $1 AND $2 > sequence
                RETURNING sequence`,
              [expectedSequence, sequence, JSON.stringify(next)]
            );
      return result.rows.length === 1;
    });
  }

  async getRevocationFeed(includeDisabled = false): Promise<OimRevocationFeed | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<RevocationFeedRow>(
        `SELECT revocation_feed_url, updated_at, updated_by, disabled_at, disabled_by
           FROM oim_release_maintenance_config
          WHERE singleton = true${includeDisabled ? "" : " AND disabled_at IS NULL"}`
      );
      return rows[0] === undefined ? null : revocationFeedFromRow(rows[0]);
    });
  }

  async setRevocationFeed(input: SetOimRevocationFeedInput): Promise<OimRevocationFeed> {
    assertRevocationFeed(input);
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<RevocationFeedRow>(
        `INSERT INTO oim_release_maintenance_config (
           singleton, revocation_feed_url, updated_by
         ) VALUES (true, $1, $2)
         ON CONFLICT (singleton) DO UPDATE SET
           revocation_feed_url = EXCLUDED.revocation_feed_url,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by,
           disabled_at = NULL,
           disabled_by = NULL
         RETURNING revocation_feed_url, updated_at, updated_by, disabled_at, disabled_by`,
        [input.url, input.updatedBy]
      );
      const feed = rows[0];
      if (feed === undefined) throw new Error("oim_revocation_feed_not_persisted");
      return revocationFeedFromRow(feed);
    });
  }

  async disableRevocationFeed(disabledBy: string): Promise<boolean> {
    if (disabledBy.length === 0) throw new Error("invalid_oim_revocation_feed_actor");
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE oim_release_maintenance_config
            SET disabled_at = now(), disabled_by = $1
          WHERE singleton = true AND disabled_at IS NULL
          RETURNING singleton`,
        [disabledBy]
      );
      return result.rows.length === 1;
    });
  }

  async putInstalledProvenance(input: PutInstalledOimReleaseProvenanceInput): Promise<void> {
    assertProvenance(input);
    await this.transactions.withTransaction((transaction) =>
      transaction.query(
        `INSERT INTO oim_installed_release_provenance (
           business_id, integration_id, major_version, version, package_digest, source,
           trust_class, signed_release, approved_community_digest, original_requirements,
           auto_patch_opt_in
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11)
         ON CONFLICT (business_id, integration_id, major_version) DO UPDATE SET
           version = EXCLUDED.version,
           package_digest = EXCLUDED.package_digest,
           source = EXCLUDED.source,
           trust_class = EXCLUDED.trust_class,
           signed_release = EXCLUDED.signed_release,
           approved_community_digest = EXCLUDED.approved_community_digest,
           auto_patch_opt_in = EXCLUDED.auto_patch_opt_in,
           updated_at = now()`,
        [
          input.businessId,
          input.integrationId,
          input.majorVersion,
          input.version,
          input.packageDigest,
          input.source,
          input.trustClass,
          input.signedRelease === undefined ? null : JSON.stringify(input.signedRelease),
          input.approvedCommunityDigest ?? null,
          JSON.stringify(input.originalRequirements),
          input.autoPatchOptIn,
        ]
      )
    );
  }

  async findInstalledProvenance(
    businessId: string,
    integrationId: string,
    majorVersion: number
  ): Promise<InstalledOimReleaseProvenance | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<ProvenanceRow>(
        `SELECT *
           FROM oim_installed_release_provenance
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3`,
        [businessId, integrationId, majorVersion]
      );
      return rows[0] === undefined ? null : provenanceFromRow(rows[0]);
    });
  }

  async setInstalledAutoPatchPreference(
    businessId: string,
    integrationId: string,
    majorVersion: number,
    enabled: boolean
  ): Promise<InstalledOimReleaseProvenance | null> {
    if (
      businessId.length === 0 ||
      integrationId.length === 0 ||
      !Number.isSafeInteger(majorVersion) ||
      majorVersion < 0
    ) {
      throw new Error("invalid_oim_auto_patch_preference");
    }
    return this.transactions.withTransaction(async (transaction) => {
      const existing = await transaction.query<ProvenanceRow>(
        `SELECT *
           FROM oim_installed_release_provenance
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
          FOR UPDATE`,
        [businessId, integrationId, majorVersion]
      );
      const provenance = existing.rows[0];
      if (provenance === undefined) return null;
      if (provenance.trust_class === "community" && enabled) {
        throw new OimAutoPatchPreferenceError("community_oim_release_auto_patch_forbidden");
      }
      const updated = await transaction.query<ProvenanceRow>(
        `UPDATE oim_installed_release_provenance
            SET auto_patch_opt_in = $4, updated_at = now()
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
          RETURNING *`,
        [businessId, integrationId, majorVersion, enabled]
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error("oim_auto_patch_preference_not_persisted");
      return provenanceFromRow(row);
    });
  }

  async listAutoPatchProvenance(
    businessId: string
  ): Promise<readonly InstalledOimReleaseProvenance[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<ProvenanceRow>(
        `SELECT *
           FROM oim_installed_release_provenance
          WHERE business_id = $1
            AND trust_class = 'official'
            AND auto_patch_opt_in = true
          ORDER BY integration_id, major_version`,
        [businessId]
      );
      return rows.map(provenanceFromRow);
    });
  }
}
