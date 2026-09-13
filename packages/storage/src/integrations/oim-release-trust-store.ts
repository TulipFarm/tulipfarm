import { randomUUID } from "node:crypto";
import type { TransactionPort } from "../ports";
import type { OimReleaseStorageTarget } from "./oim-release-uninstall-store";

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

export interface OimKnownSignedReleaseIdentity {
  readonly integrationId: string;
  readonly version: string;
  readonly packageDigest: string;
}

export interface RecordOimKnownSignedReleaseInput extends OimKnownSignedReleaseIdentity {
  readonly keyId: string;
}

export interface OimAuthoredDraftReleaseSourceProvenance {
  readonly kind: "authored_draft";
  readonly reviewId: string;
  readonly reviewedAt: string;
  readonly reviewedBy: {
    readonly businessId: string;
    readonly principal: {
      readonly kind: string;
      readonly id: string;
    };
  };
  readonly runId?: string;
  readonly toolCallId?: string;
}

export type OimReleaseSourceProvenance =
  | {
      readonly kind: "git";
      readonly repository: string;
      readonly ref: string;
      readonly path: string;
    }
  | OimAuthoredDraftReleaseSourceProvenance;

export interface InstalledOimReleaseProvenance {
  readonly businessId: string;
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly version: string;
  readonly packageDigest: string;
  readonly source: OimReleaseSourceProvenance;
  readonly slug: string;
  readonly soulRevision: string;
  readonly trustClass: OimInstalledReleaseTrustClass;
  readonly signedRelease?: unknown;
  readonly approvedCommunityDigest?: string;
  readonly originalRequirements: unknown;
  readonly autoPatchOptIn: boolean;
  readonly installedAt: string;
  readonly updatedAt: string;
}

export interface PersistedInstalledOimReleaseProvenance extends InstalledOimReleaseProvenance {
  readonly installationId: string;
}

export interface PutInstalledOimReleaseProvenanceInput {
  readonly businessId: string;
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly version: string;
  readonly packageDigest: string;
  readonly source: OimReleaseSourceProvenance;
  readonly slug: string;
  readonly soulRevision: string;
  readonly trustClass: OimInstalledReleaseTrustClass;
  readonly signedRelease?: unknown;
  readonly approvedCommunityDigest?: string;
  readonly originalRequirements: unknown;
  readonly autoPatchOptIn: boolean;
  readonly installationId?: string;
}

export interface QuarantinedOimReleaseProvenance {
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
  readonly installedAt: string;
  readonly updatedAt: string;
}

export interface RecoverQuarantinedOimReleaseInput {
  readonly businessId: string;
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly version: string;
  readonly packageDigest: string;
  readonly source: string;
  readonly sourceRef: string;
  readonly candidatePath: string;
  readonly slug: string;
  readonly soulRevision: string;
}

export interface CompareAndSwapInstalledOimReleaseProvenanceInput {
  readonly expected: PersistedInstalledOimReleaseProvenance;
  readonly next: PutInstalledOimReleaseProvenanceInput;
}

export interface UpdateRestoredOimReleaseSoulRevisionInput {
  readonly businessId: string;
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly version: string;
  readonly packageDigest: string;
  readonly slug: string;
  readonly soulRevision: string;
}

export type CompareAndSwapInstalledOimReleaseProvenanceResult =
  | {
      readonly status: "updated";
      readonly provenance: PersistedInstalledOimReleaseProvenance;
    }
  | {
      readonly status: "skipped";
      readonly reason: "auto_patch_disabled" | "installed_release_changed";
    };

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
  source_kind: OimReleaseSourceProvenance["kind"];
  source: string | null;
  source_ref: string | null;
  candidate_path: string | null;
  authored_draft: unknown | null;
  slug: string | null;
  soul_revision: string | null;
  trust_class: OimInstalledReleaseTrustClass;
  signed_release: unknown | null;
  approved_community_digest: string | null;
  original_requirements: unknown;
  auto_patch_opt_in: boolean;
  installation_id: string | null;
  recovery_state: "verified" | "quarantined";
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

function releaseSourceFromRow(row: ProvenanceRow): OimReleaseSourceProvenance {
  if (
    row.source_kind === "git" &&
    row.source !== null &&
    row.source_ref !== null &&
    row.candidate_path !== null &&
    row.authored_draft === null
  ) {
    return {
      kind: "git",
      repository: row.source,
      ref: row.source_ref,
      path: row.candidate_path,
    };
  }
  if (
    row.source_kind === "authored_draft" &&
    row.source === null &&
    row.source_ref === null &&
    row.candidate_path === null &&
    row.authored_draft !== null
  ) {
    return parseOimAuthoredDraftReleaseSourceProvenance(row.authored_draft);
  }
  throw new Error("oim_release_provenance_source_invalid");
}

export function oimReleaseSourceStorageValues(
  source: OimReleaseSourceProvenance
): readonly [
  OimReleaseSourceProvenance["kind"],
  string | null,
  string | null,
  string | null,
  unknown | null,
] {
  return source.kind === "git"
    ? ["git", source.repository, source.ref, source.path, null]
    : ["authored_draft", null, null, null, source];
}

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(input).every((key) => allowed.includes(key));
}

export function parseOimAuthoredDraftReleaseSourceProvenance(
  input: unknown
): OimAuthoredDraftReleaseSourceProvenance {
  if (
    !record(input) ||
    !exactKeys(input, ["kind", "reviewId", "reviewedAt", "reviewedBy", "runId", "toolCallId"]) ||
    input.kind !== "authored_draft" ||
    typeof input.reviewId !== "string" ||
    input.reviewId.length === 0 ||
    typeof input.reviewedAt !== "string" ||
    Number.isNaN(Date.parse(input.reviewedAt)) ||
    !record(input.reviewedBy) ||
    !exactKeys(input.reviewedBy, ["businessId", "principal"]) ||
    typeof input.reviewedBy.businessId !== "string" ||
    input.reviewedBy.businessId.length === 0 ||
    !record(input.reviewedBy.principal) ||
    !exactKeys(input.reviewedBy.principal, ["kind", "id"]) ||
    typeof input.reviewedBy.principal.kind !== "string" ||
    input.reviewedBy.principal.kind.length === 0 ||
    typeof input.reviewedBy.principal.id !== "string" ||
    input.reviewedBy.principal.id.length === 0 ||
    (input.runId !== undefined && (typeof input.runId !== "string" || input.runId.length === 0)) ||
    (input.toolCallId !== undefined &&
      (typeof input.toolCallId !== "string" || input.toolCallId.length === 0))
  ) {
    throw new Error("invalid_oim_authored_draft_provenance");
  }
  return input as unknown as OimAuthoredDraftReleaseSourceProvenance;
}

export function isValidOimReleaseSourceProvenance(
  source: OimReleaseSourceProvenance,
  businessId: string
): boolean {
  return source.kind === "git"
    ? source.repository.length > 0 &&
        source.ref.length > 0 &&
        source.ref !== "legacy-unresolved" &&
        source.path.length > 0
    : parseOimAuthoredDraftReleaseSourceProvenance(source).reviewedBy.businessId === businessId;
}

function provenanceFromRow(row: ProvenanceRow): PersistedInstalledOimReleaseProvenance {
  if (
    row.recovery_state !== "verified" ||
    row.installation_id === null ||
    row.slug === null ||
    row.soul_revision === null
  ) {
    throw new Error("oim_release_provenance_incomplete");
  }
  const source = releaseSourceFromRow(row);
  return {
    businessId: row.business_id,
    integrationId: row.integration_id,
    majorVersion: row.major_version,
    version: row.version,
    packageDigest: row.package_digest,
    source,
    slug: row.slug,
    soulRevision: row.soul_revision,
    trustClass: row.trust_class,
    ...(row.signed_release === null ? {} : { signedRelease: row.signed_release }),
    ...(row.approved_community_digest === null
      ? {}
      : { approvedCommunityDigest: row.approved_community_digest }),
    originalRequirements: row.original_requirements,
    autoPatchOptIn: row.auto_patch_opt_in,
    installationId: row.installation_id,
    installedAt: timestamp(row.installed_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function quarantinedFromRow(row: ProvenanceRow): QuarantinedOimReleaseProvenance {
  if (row.recovery_state !== "quarantined" || row.source === null) {
    throw new Error("oim_release_provenance_not_quarantined");
  }
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
  const versionMajor = /^(0|[1-9]\d*)\./.exec(input.version);
  if (
    input.businessId.length === 0 ||
    input.integrationId.length === 0 ||
    input.version.length === 0 ||
    !Number.isSafeInteger(input.majorVersion) ||
    input.majorVersion < 0 ||
    !/^[0-9a-f]{64}$/.test(input.packageDigest) ||
    !isValidOimReleaseSourceProvenance(input.source, input.businessId) ||
    input.slug.length === 0 ||
    input.soulRevision.length === 0 ||
    input.soulRevision === "legacy-unresolved" ||
    versionMajor === null ||
    Number(versionMajor[1]) !== input.majorVersion ||
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

  async isKnownSignedRelease(identity: OimKnownSignedReleaseIdentity): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `SELECT 1
           FROM oim_known_signed_releases
          WHERE integration_id = $1 AND version = $2 AND package_digest = $3`,
        [identity.integrationId, identity.version, identity.packageDigest]
      );
      return result.rows.length === 1;
    });
  }

  async recordKnownSignedRelease(input: RecordOimKnownSignedReleaseInput): Promise<void> {
    if (
      input.integrationId.length === 0 ||
      input.version.length === 0 ||
      !/^[0-9a-f]{64}$/.test(input.packageDigest) ||
      input.keyId.length === 0
    ) {
      throw new Error("invalid_oim_known_signed_release");
    }
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO oim_known_signed_releases (
           integration_id, version, package_digest, key_id
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (integration_id, version, package_digest) DO NOTHING`,
        [input.integrationId, input.version, input.packageDigest, input.keyId]
      );
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
    await this.transactions.withTransaction(async (transaction) => {
      const scope = [input.businessId, input.integrationId, input.majorVersion] as const;
      const lifecycle = await transaction.query<{
        installation_id: string;
        slug: string;
        phase: "installed" | "uninstall_pending" | "uninstalled";
      }>(
        `SELECT installation_id, slug, phase
           FROM oim_release_lifecycle_state
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
          FOR UPDATE`,
        scope
      );
      const journal = await transaction.query<{ status: "pending" | "complete" }>(
        `SELECT status
           FROM oim_release_uninstall_journals
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND status = 'pending'
          FOR UPDATE`,
        scope
      );
      if (
        lifecycle.rows[0]?.phase === "uninstall_pending" ||
        journal.rows[0]?.status === "pending"
      ) {
        throw new Error("oim_uninstall_pending");
      }

      const existing = await transaction.query<ProvenanceRow>(
        `SELECT *
           FROM oim_installed_release_provenance
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
          FOR UPDATE`,
        scope
      );
      const current = existing.rows[0];
      if (current !== undefined) {
        if (
          lifecycle.rows[0]?.phase !== "installed" ||
          lifecycle.rows[0].installation_id !== current.installation_id ||
          lifecycle.rows[0].slug !== current.slug
        ) {
          throw new Error("oim_release_lifecycle_mismatch");
        }
        const [sourceKind, source, sourceRef, candidatePath, authoredDraft] =
          oimReleaseSourceStorageValues(input.source);
        const idempotent = await transaction.query(
          `SELECT 1
             FROM oim_installed_release_provenance
            WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
              AND version = $4
              AND package_digest = $5
              AND source_kind = $6
              AND source IS NOT DISTINCT FROM $7
              AND source_ref IS NOT DISTINCT FROM $8
              AND candidate_path IS NOT DISTINCT FROM $9
              AND authored_draft IS NOT DISTINCT FROM $10::jsonb
              AND slug = $11
              AND soul_revision = $12
              AND trust_class = $13
              AND signed_release IS NOT DISTINCT FROM $14::jsonb
              AND approved_community_digest IS NOT DISTINCT FROM $15
              AND original_requirements = $16::jsonb
              AND auto_patch_opt_in = $17`,
          [
            ...scope,
            input.version,
            input.packageDigest,
            sourceKind,
            source,
            sourceRef,
            candidatePath,
            authoredDraft === null ? null : JSON.stringify(authoredDraft),
            input.slug,
            input.soulRevision,
            input.trustClass,
            input.signedRelease === undefined ? null : JSON.stringify(input.signedRelease),
            input.approvedCommunityDigest ?? null,
            JSON.stringify(input.originalRequirements),
            input.autoPatchOptIn,
          ]
        );
        if (idempotent.rows.length === 1) return;
        throw new Error("oim_release_already_installed");
      }

      if (lifecycle.rows[0] !== undefined && lifecycle.rows[0].phase !== "uninstalled") {
        throw new Error("oim_release_lifecycle_mismatch");
      }
      const installationId = input.installationId ?? randomUUID();
      const reservation = await transaction.query(
        `INSERT INTO oim_release_slug_reservations (
           business_id, slug, integration_id, major_version, installation_id, state
         ) VALUES ($1, $4, $2, $3, $5::uuid, 'installed')
         ON CONFLICT (business_id, slug) DO UPDATE SET
           integration_id = EXCLUDED.integration_id,
           major_version = EXCLUDED.major_version,
           installation_id = EXCLUDED.installation_id,
           operation_id = NULL,
           state = 'installed',
           updated_at = now()
         WHERE oim_release_slug_reservations.integration_id = EXCLUDED.integration_id
           AND oim_release_slug_reservations.major_version = EXCLUDED.major_version
           AND oim_release_slug_reservations.installation_id = EXCLUDED.installation_id
         RETURNING installation_id`,
        [input.businessId, input.integrationId, input.majorVersion, input.slug, installationId]
      );
      if (reservation.rows.length !== 1) throw new Error("oim_release_location_conflict");
      const [sourceKind, source, sourceRef, candidatePath, authoredDraft] =
        oimReleaseSourceStorageValues(input.source);
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
        [
          ...scope,
          input.version,
          input.packageDigest,
          sourceKind,
          source,
          sourceRef,
          candidatePath,
          authoredDraft === null ? null : JSON.stringify(authoredDraft),
          input.slug,
          input.soulRevision,
          input.trustClass,
          input.signedRelease === undefined ? null : JSON.stringify(input.signedRelease),
          input.approvedCommunityDigest ?? null,
          JSON.stringify(input.originalRequirements),
          input.autoPatchOptIn,
          installationId,
        ]
      );
      const registered = await transaction.query(
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
        [...scope, installationId, input.slug]
      );
      if (registered.rows.length !== 1) throw new Error("oim_release_lifecycle_mismatch");
    });
  }

  async findQuarantinedProvenance(
    businessId: string,
    integrationId: string,
    majorVersion: number
  ): Promise<QuarantinedOimReleaseProvenance | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<ProvenanceRow>(
        `SELECT *
           FROM oim_installed_release_provenance
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND recovery_state = 'quarantined'`,
        [businessId, integrationId, majorVersion]
      );
      return result.rows[0] === undefined ? null : quarantinedFromRow(result.rows[0]);
    });
  }

  async recoverQuarantinedProvenance(
    input: RecoverQuarantinedOimReleaseInput
  ): Promise<PersistedInstalledOimReleaseProvenance> {
    if (
      input.businessId.length === 0 ||
      input.integrationId.length === 0 ||
      !Number.isSafeInteger(input.majorVersion) ||
      input.majorVersion < 0 ||
      input.version.length === 0 ||
      !/^[0-9a-f]{64}$/.test(input.packageDigest) ||
      input.source.length === 0 ||
      input.sourceRef.length === 0 ||
      input.candidatePath.length === 0 ||
      input.slug.length === 0 ||
      input.soulRevision.length === 0
    ) {
      throw new Error("invalid_oim_release_recovery");
    }
    return this.transactions.withTransaction(async (transaction) => {
      const current = await transaction.query<ProvenanceRow>(
        `SELECT *
           FROM oim_installed_release_provenance
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
          FOR UPDATE`,
        [input.businessId, input.integrationId, input.majorVersion]
      );
      const row = current.rows[0];
      if (
        row === undefined ||
        row.recovery_state !== "quarantined" ||
        row.version !== input.version ||
        row.package_digest !== input.packageDigest ||
        row.source !== input.source
      ) {
        throw new Error("oim_release_recovery_mismatch");
      }
      const installationId = randomUUID();
      const reserved = await transaction.query(
        `INSERT INTO oim_release_slug_reservations (
           business_id, slug, integration_id, major_version, installation_id, state
         ) VALUES ($1, $4, $2, $3, $5::uuid, 'installed')
         ON CONFLICT (business_id, slug) DO NOTHING
         RETURNING installation_id`,
        [input.businessId, input.integrationId, input.majorVersion, input.slug, installationId]
      );
      if (reserved.rows.length !== 1) throw new Error("oim_release_location_conflict");
      const recovered = await transaction.query<ProvenanceRow>(
        `UPDATE oim_installed_release_provenance
            SET installation_id = $4::uuid,
                slug = $5,
                source_kind = 'git',
                source_ref = $6,
                candidate_path = $7,
                authored_draft = NULL,
                soul_revision = $8,
                recovery_state = 'verified',
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 millisecond')
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND recovery_state = 'quarantined'
          RETURNING *`,
        [
          input.businessId,
          input.integrationId,
          input.majorVersion,
          installationId,
          input.slug,
          input.sourceRef,
          input.candidatePath,
          input.soulRevision,
        ]
      );
      const recoveredRow = recovered.rows[0];
      if (recoveredRow === undefined) throw new Error("oim_release_recovery_mismatch");
      await transaction.query(
        `INSERT INTO oim_release_lifecycle_state (
           business_id, integration_id, major_version, installation_id, slug, phase
         ) VALUES ($1, $2, $3, $4::uuid, $5, 'installed')`,
        [input.businessId, input.integrationId, input.majorVersion, installationId, input.slug]
      );
      return provenanceFromRow(recoveredRow);
    });
  }

  async compareAndSwapInstalledProvenance(
    input: CompareAndSwapInstalledOimReleaseProvenanceInput
  ): Promise<CompareAndSwapInstalledOimReleaseProvenanceResult> {
    assertProvenance(input.next);
    const { expected, next } = input;
    if (
      expected.businessId !== next.businessId ||
      expected.integrationId !== next.integrationId ||
      expected.majorVersion !== next.majorVersion ||
      expected.trustClass !== "official" ||
      next.trustClass !== "official" ||
      expected.source.kind !== "git" ||
      next.source.kind !== "git" ||
      expected.source.repository !== next.source.repository ||
      expected.slug !== next.slug
    ) {
      throw new Error("invalid_oim_release_patch_scope");
    }
    const nextSource = next.source;
    if (nextSource.kind !== "git") throw new Error("invalid_oim_release_patch_scope");

    return this.transactions.withTransaction(async (transaction) => {
      const scope = [expected.businessId, expected.integrationId, expected.majorVersion] as const;
      const lifecycle = await transaction.query<{
        installation_id: string;
        slug: string;
        phase: "installed" | "uninstall_pending" | "uninstalled";
      }>(
        `SELECT installation_id, slug, phase
           FROM oim_release_lifecycle_state
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
          FOR UPDATE`,
        scope
      );
      const currentResult = await transaction.query<ProvenanceRow>(
        `SELECT *
           FROM oim_installed_release_provenance
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
          FOR UPDATE`,
        scope
      );
      const current = currentResult.rows[0];
      if (
        lifecycle.rows[0]?.phase !== "installed" ||
        lifecycle.rows[0].installation_id !== expected.installationId ||
        lifecycle.rows[0].slug !== expected.slug ||
        current === undefined ||
        current.installation_id !== expected.installationId ||
        current.slug !== expected.slug ||
        current.version !== expected.version ||
        current.package_digest !== expected.packageDigest
      ) {
        return { status: "skipped", reason: "installed_release_changed" };
      }
      if (!current.auto_patch_opt_in) {
        return { status: "skipped", reason: "auto_patch_disabled" };
      }
      if (timestamp(current.updated_at) !== expected.updatedAt) {
        return { status: "skipped", reason: "installed_release_changed" };
      }
      const updated = await transaction.query<ProvenanceRow>(
        `UPDATE oim_installed_release_provenance
            SET version = $4,
                package_digest = $5,
                source_kind = 'git',
                source = $6,
                source_ref = $7,
                candidate_path = $8,
                authored_draft = NULL,
                soul_revision = $9,
                trust_class = $10,
                signed_release = $11::jsonb,
                approved_community_digest = $12,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 millisecond')
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND installation_id = $13::uuid
          RETURNING *`,
        [
          ...scope,
          next.version,
          next.packageDigest,
          nextSource.repository,
          nextSource.ref,
          nextSource.path,
          next.soulRevision,
          next.trustClass,
          next.signedRelease === undefined ? null : JSON.stringify(next.signedRelease),
          next.approvedCommunityDigest ?? null,
          expected.installationId,
        ]
      );
      const provenance = updated.rows[0];
      if (provenance === undefined) {
        return { status: "skipped", reason: "installed_release_changed" };
      }
      return { status: "updated", provenance: provenanceFromRow(provenance) };
    });
  }

  async updateRestoredSoulRevision(
    input: UpdateRestoredOimReleaseSoulRevisionInput
  ): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      const updated = await transaction.query(
        `UPDATE oim_installed_release_provenance AS provenance
            SET soul_revision = $7,
                updated_at = GREATEST(clock_timestamp(), provenance.updated_at + interval '1 millisecond')
           FROM oim_release_lifecycle_state AS lifecycle
          WHERE provenance.business_id = $1
            AND provenance.integration_id = $2
            AND provenance.major_version = $3
            AND provenance.version = $4
            AND provenance.package_digest = $5
            AND provenance.slug = $6
            AND lifecycle.business_id = provenance.business_id
            AND lifecycle.integration_id = provenance.integration_id
            AND lifecycle.major_version = provenance.major_version
            AND lifecycle.installation_id = provenance.installation_id
            AND lifecycle.slug = provenance.slug
            AND lifecycle.phase = 'installed'
          RETURNING provenance.installation_id`,
        [
          input.businessId,
          input.integrationId,
          input.majorVersion,
          input.version,
          input.packageDigest,
          input.slug,
          input.soulRevision,
        ]
      );
      if (updated.rows.length !== 1) {
        throw new Error("oim_release_restored_provenance_mismatch");
      }
    });
  }

  async removeInstalledProvenance(target: OimReleaseStorageTarget): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const scope = [target.businessId, target.integrationId, target.majorVersion] as const;
      const lifecycle = await transaction.query<{
        installation_id: string;
        slug: string;
        phase: "installed" | "uninstall_pending" | "uninstalled";
      }>(
        `SELECT installation_id, slug, phase
           FROM oim_release_lifecycle_state
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
          FOR UPDATE`,
        scope
      );
      if (
        lifecycle.rows[0]?.phase !== "uninstall_pending" ||
        lifecycle.rows[0].installation_id !== target.installationId ||
        lifecycle.rows[0].slug !== target.slug
      ) {
        throw new Error("oim_uninstall_generation_mismatch");
      }
      const journalResult = await transaction.query<{
        installation_id: string;
        slug: string;
        package_digest: string;
        soul_revision: string;
        status: "pending" | "complete";
        completed_steps: string[];
      }>(
        `SELECT installation_id, slug, package_digest, soul_revision, status, completed_steps
           FROM oim_release_uninstall_journals
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND installation_id = $4::uuid
          FOR UPDATE`,
        [...scope, target.installationId]
      );
      const journal = journalResult.rows[0];
      if (
        journal === undefined ||
        journal.installation_id !== target.installationId ||
        journal.slug !== target.slug ||
        journal.package_digest !== target.packageDigest ||
        journal.soul_revision !== target.soulRevision ||
        journal.status !== "pending"
      ) {
        throw new Error("oim_uninstall_generation_mismatch");
      }
      const prerequisites = [
        "traffic_fenced_and_drained",
        "remote_unsubscribed",
        "connections_revoked",
        "owned_state_removed",
      ];
      if (prerequisites.some((step) => !journal.completed_steps.includes(step))) {
        throw new Error("oim_uninstall_cleanup_incomplete");
      }
      if (journal.completed_steps.includes("release_provenance_removed")) return false;
      const deleted = await transaction.query(
        `DELETE FROM oim_installed_release_provenance
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND installation_id = $4::uuid AND slug = $5
            AND package_digest = $6 AND soul_revision = $7
          RETURNING installation_id`,
        [...scope, target.installationId, target.slug, target.packageDigest, target.soulRevision]
      );
      if (deleted.rows.length !== 1) {
        throw new Error("oim_release_provenance_missing_without_evidence");
      }
      await transaction.query(
        `UPDATE oim_release_uninstall_journals
            SET completed_steps = array_append(completed_steps, 'release_provenance_removed'),
                retry = NULL,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 millisecond')
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND installation_id = $4::uuid AND status = 'pending'`,
        [...scope, target.installationId]
      );
      return true;
    });
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
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND recovery_state = 'verified'`,
        [businessId, integrationId, majorVersion]
      );
      return rows[0] === undefined ? null : provenanceFromRow(rows[0]);
    });
  }

  async findInstalledGeneration(
    businessId: string,
    integrationId: string,
    majorVersion: number
  ): Promise<PersistedInstalledOimReleaseProvenance | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<ProvenanceRow>(
        `SELECT *
           FROM oim_installed_release_provenance
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND recovery_state = 'verified'`,
        [businessId, integrationId, majorVersion]
      );
      return rows[0] === undefined ? null : provenanceFromRow(rows[0]);
    });
  }

  async findUninstallTarget(
    businessId: string,
    integrationId: string,
    majorVersion: number,
    installationId: string
  ): Promise<OimReleaseStorageTarget | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const provenance = await transaction.query<ProvenanceRow>(
        `SELECT *
           FROM oim_installed_release_provenance
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND installation_id = $4::uuid AND recovery_state = 'verified'`,
        [businessId, integrationId, majorVersion, installationId]
      );
      if (provenance.rows[0] !== undefined) {
        const current = provenanceFromRow(provenance.rows[0]);
        return {
          businessId,
          integrationId,
          majorVersion,
          installationId,
          slug: current.slug,
          packageDigest: current.packageDigest,
          soulRevision: current.soulRevision,
        };
      }
      const journal = await transaction.query<{
        slug: string;
        package_digest: string;
        soul_revision: string;
      }>(
        `SELECT slug, package_digest, soul_revision
           FROM oim_release_uninstall_journals
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND installation_id = $4::uuid`,
        [businessId, integrationId, majorVersion, installationId]
      );
      const historical = journal.rows[0];
      return historical === undefined
        ? null
        : {
            businessId,
            integrationId,
            majorVersion,
            installationId,
            slug: historical.slug,
            packageDigest: historical.package_digest,
            soulRevision: historical.soul_revision,
          };
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
      const lifecycle = await transaction.query<{
        phase: "installed" | "uninstall_pending" | "uninstalled";
      }>(
        `SELECT phase
           FROM oim_release_lifecycle_state
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
          FOR UPDATE`,
        [businessId, integrationId, majorVersion]
      );
      if (lifecycle.rows[0]?.phase === "uninstall_pending") {
        throw new Error("oim_uninstall_pending");
      }
      const existing = await transaction.query<ProvenanceRow>(
        `SELECT *
           FROM oim_installed_release_provenance
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND recovery_state = 'verified'
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
            SET auto_patch_opt_in = $4,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 millisecond')
          WHERE business_id = $1 AND integration_id = $2 AND major_version = $3
            AND recovery_state = 'verified'
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
            AND recovery_state = 'verified'
          ORDER BY integration_id, major_version`,
        [businessId]
      );
      return rows.map(provenanceFromRow);
    });
  }
}
