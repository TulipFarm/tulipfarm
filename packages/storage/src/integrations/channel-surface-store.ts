import type { Queryable, TransactionPort } from "../ports";

export type ChannelSurfaceInstanceStatus = "active" | "closed" | "revoked";
export type ChannelSurfacePublishJobStatus =
  | "pending"
  | "leased"
  | "retry_wait"
  | "succeeded"
  | "ambiguous"
  | "failed"
  | "superseded";
export type SlackCapabilityObservationStatus = "supported" | "unsupported";

export interface ChannelSurfaceInstanceKey {
  businessId: string;
  provider: string;
  integrationId: string;
  externalTenantId: string;
  externalSubject: string;
  surface: "home" | "modal";
  externalId: string;
}

export interface PersistedChannelSurfaceInstance extends ChannelSurfaceInstanceKey {
  providerViewId?: string;
  providerHash?: string;
  artifactId?: string;
  artifactRevision?: number;
  renderDigest: string;
  status: ChannelSurfaceInstanceStatus;
  lastPublishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertChannelSurfaceInstance extends ChannelSurfaceInstanceKey {
  providerViewId?: string;
  providerHash?: string;
  artifactId?: string;
  artifactRevision?: number;
  renderDigest: string;
  status: ChannelSurfaceInstanceStatus;
  lastPublishedAt?: string;
}

export interface ChannelSurfacePublishJobKey {
  businessId: string;
  integrationId: string;
  externalTenantId: string;
  externalSubject: string;
  surface: "home" | "modal";
  generation: number;
}

export interface PersistedChannelSurfacePublishJob extends ChannelSurfacePublishJobKey {
  coalescingKey: string;
  status: ChannelSurfacePublishJobStatus;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  attempt: number;
  nextAttemptAt: string;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SlackCapabilityObservationKey {
  businessId: string;
  integrationId: string;
  capability: string;
  rendererVersion: string;
}

export interface PersistedSlackCapabilityObservation extends SlackCapabilityObservationKey {
  status: SlackCapabilityObservationStatus;
  expiresAt: string;
  updatedAt: string;
}

export const CHANNEL_SURFACE_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS channel_surface_instances (
    business_id        text NOT NULL,
    provider           text NOT NULL,
    integration_id     text NOT NULL,
    external_tenant_id text NOT NULL,
    external_subject   text NOT NULL,
    surface            text NOT NULL CHECK (surface IN ('home', 'modal')),
    external_id        text NOT NULL,
    provider_view_id   text,
    provider_hash      text,
    artifact_id        text,
    artifact_revision  integer,
    render_digest      text NOT NULL,
    status             text NOT NULL CHECK (status IN ('active', 'closed', 'revoked')),
    last_published_at  timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (
      business_id,
      provider,
      integration_id,
      external_tenant_id,
      external_subject,
      surface,
      external_id
    ),
    FOREIGN KEY (business_id, integration_id) REFERENCES integrations(business_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS channel_surface_instances_modal_sweep_idx
    ON channel_surface_instances (updated_at)
    WHERE surface = 'modal'`,
  `CREATE TABLE IF NOT EXISTS channel_surface_publish_jobs (
    business_id        text NOT NULL,
    integration_id     text NOT NULL,
    external_tenant_id text NOT NULL,
    external_subject   text NOT NULL,
    surface            text NOT NULL CHECK (surface IN ('home', 'modal')),
    coalescing_key      text NOT NULL,
    generation         bigint NOT NULL,
    status             text NOT NULL CHECK (
      status IN (
        'pending',
        'leased',
        'retry_wait',
        'succeeded',
        'ambiguous',
        'failed',
        'superseded'
      )
    ),
    lease_owner        text,
    lease_expires_at   timestamptz,
    attempt            integer NOT NULL DEFAULT 0,
    next_attempt_at    timestamptz NOT NULL DEFAULT now(),
    last_error_code    text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (
      business_id,
      integration_id,
      external_tenant_id,
      external_subject,
      surface,
      generation
    ),
    UNIQUE (business_id, integration_id, coalescing_key),
    FOREIGN KEY (business_id, integration_id) REFERENCES integrations(business_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS channel_surface_publish_jobs_claim_idx
    ON channel_surface_publish_jobs (status, next_attempt_at, lease_expires_at)`,
  `CREATE TABLE IF NOT EXISTS slack_capability_observations (
    business_id      text NOT NULL,
    integration_id   text NOT NULL,
    capability       text NOT NULL,
    renderer_version text NOT NULL,
    status           text NOT NULL CHECK (status IN ('supported', 'unsupported')),
    expires_at       timestamptz NOT NULL,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, integration_id, capability, renderer_version),
    FOREIGN KEY (business_id, integration_id) REFERENCES integrations(business_id, id)
  )`,
];

interface InstanceRow {
  business_id: string;
  provider: string;
  integration_id: string;
  external_tenant_id: string;
  external_subject: string;
  surface: "home" | "modal";
  external_id: string;
  provider_view_id: string | null;
  provider_hash: string | null;
  artifact_id: string | null;
  artifact_revision: number | null;
  render_digest: string;
  status: ChannelSurfaceInstanceStatus;
  last_published_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PublishJobRow {
  business_id: string;
  integration_id: string;
  external_tenant_id: string;
  external_subject: string;
  surface: "home" | "modal";
  coalescing_key: string;
  generation: number | string;
  status: ChannelSurfacePublishJobStatus;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  attempt: number;
  next_attempt_at: Date | string;
  last_error_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CapabilityRow {
  business_id: string;
  integration_id: string;
  capability: string;
  renderer_version: string;
  status: SlackCapabilityObservationStatus;
  expires_at: Date | string;
  updated_at: Date | string;
}

const INSTANCE_COLUMNS = `business_id, provider, integration_id, external_tenant_id,
  external_subject, surface, external_id, provider_view_id, provider_hash, artifact_id,
  artifact_revision, render_digest, status, last_published_at, created_at, updated_at`;
const JOB_COLUMNS = `business_id, integration_id, external_tenant_id, external_subject, surface,
  coalescing_key, generation, status, lease_owner, lease_expires_at, attempt, next_attempt_at,
  last_error_code, created_at, updated_at`;
const QUALIFIED_JOB_COLUMNS = `jobs.business_id, jobs.integration_id, jobs.external_tenant_id,
  jobs.external_subject, jobs.surface, jobs.coalescing_key, jobs.generation, jobs.status,
  jobs.lease_owner, jobs.lease_expires_at, jobs.attempt, jobs.next_attempt_at,
  jobs.last_error_code, jobs.created_at, jobs.updated_at`;
const CAPABILITY_COLUMNS = `business_id, integration_id, capability, renderer_version, status,
  expires_at, updated_at`;

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function instance(row: InstanceRow): PersistedChannelSurfaceInstance {
  return {
    businessId: row.business_id,
    provider: row.provider,
    integrationId: row.integration_id,
    externalTenantId: row.external_tenant_id,
    externalSubject: row.external_subject,
    surface: row.surface,
    externalId: row.external_id,
    ...(row.provider_view_id === null ? {} : { providerViewId: row.provider_view_id }),
    ...(row.provider_hash === null ? {} : { providerHash: row.provider_hash }),
    ...(row.artifact_id === null ? {} : { artifactId: row.artifact_id }),
    ...(row.artifact_revision === null ? {} : { artifactRevision: row.artifact_revision }),
    renderDigest: row.render_digest,
    status: row.status,
    ...(row.last_published_at === null
      ? {}
      : { lastPublishedAt: timestamp(row.last_published_at) }),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function publishJob(row: PublishJobRow): PersistedChannelSurfacePublishJob {
  return {
    businessId: row.business_id,
    integrationId: row.integration_id,
    externalTenantId: row.external_tenant_id,
    externalSubject: row.external_subject,
    surface: row.surface,
    coalescingKey: row.coalescing_key,
    generation: Number(row.generation),
    status: row.status,
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: timestamp(row.lease_expires_at) }),
    attempt: row.attempt,
    nextAttemptAt: timestamp(row.next_attempt_at),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function capability(row: CapabilityRow): PersistedSlackCapabilityObservation {
  return {
    businessId: row.business_id,
    integrationId: row.integration_id,
    capability: row.capability,
    rendererVersion: row.renderer_version,
    status: row.status,
    expiresAt: timestamp(row.expires_at),
    updatedAt: timestamp(row.updated_at),
  };
}

async function validateArtifactReference(
  transaction: Queryable,
  businessId: string,
  artifactId?: string,
  artifactRevision?: number
): Promise<void> {
  if ((artifactId === undefined) !== (artifactRevision === undefined)) {
    throw new Error("channel_surface_artifact_reference_invalid");
  }
  if (artifactId === undefined) return;

  const artifact = await transaction.query(
    "SELECT 1 FROM artifacts WHERE business_id = $1 AND id = $2",
    [businessId, artifactId]
  );
  if (artifact.rows.length === 0) {
    throw new Error("channel_surface_artifact_reference_invalid");
  }
}

export class ChannelSurfaceStore {
  constructor(
    private readonly transactions: TransactionPort,
    private readonly now: () => string
  ) {}

  async getInstance(
    key: ChannelSurfaceInstanceKey
  ): Promise<PersistedChannelSurfaceInstance | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<InstanceRow>(
        `SELECT ${INSTANCE_COLUMNS}
           FROM channel_surface_instances
          WHERE business_id = $1
            AND provider = $2
            AND integration_id = $3
            AND external_tenant_id = $4
            AND external_subject = $5
            AND surface = $6
            AND external_id = $7`,
        [
          key.businessId,
          key.provider,
          key.integrationId,
          key.externalTenantId,
          key.externalSubject,
          key.surface,
          key.externalId,
        ]
      );
      const row = result.rows[0];
      return row === undefined ? null : instance(row);
    });
  }

  async upsertInstance(
    input: UpsertChannelSurfaceInstance
  ): Promise<PersistedChannelSurfaceInstance> {
    return this.transactions.withTransaction(async (transaction) => {
      await validateArtifactReference(
        transaction,
        input.businessId,
        input.artifactId,
        input.artifactRevision
      );
      const result = await transaction.query<InstanceRow>(
        `INSERT INTO channel_surface_instances (
           business_id, provider, integration_id, external_tenant_id, external_subject, surface,
           external_id, provider_view_id, provider_hash, artifact_id, artifact_revision,
           render_digest, status, last_published_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz,
           $15::timestamptz, $15::timestamptz
         )
         ON CONFLICT (
           business_id, provider, integration_id, external_tenant_id, external_subject, surface,
           external_id
         ) DO UPDATE SET
           provider_view_id = EXCLUDED.provider_view_id,
           provider_hash = EXCLUDED.provider_hash,
           artifact_id = EXCLUDED.artifact_id,
           artifact_revision = EXCLUDED.artifact_revision,
           render_digest = EXCLUDED.render_digest,
           status = EXCLUDED.status,
           last_published_at = EXCLUDED.last_published_at,
           updated_at = EXCLUDED.updated_at
         WHERE (
           channel_surface_instances.status = 'active'
           OR (
             channel_surface_instances.status = 'closed'
             AND EXCLUDED.status IN ('closed', 'revoked')
           )
         )
         RETURNING ${INSTANCE_COLUMNS}`,
        [
          input.businessId,
          input.provider,
          input.integrationId,
          input.externalTenantId,
          input.externalSubject,
          input.surface,
          input.externalId,
          input.providerViewId ?? null,
          input.providerHash ?? null,
          input.artifactId ?? null,
          input.artifactRevision ?? null,
          input.renderDigest,
          input.status,
          input.lastPublishedAt ?? null,
          this.now(),
        ]
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("channel_surface_instance_transition_invalid");
      return instance(row);
    });
  }

  async enqueuePublish(
    input: ChannelSurfaceInstanceKey & {
      coalescingKey: string;
      supersedePending: boolean;
    }
  ): Promise<{
    outcome: "enqueued" | "coalesced";
    job: PersistedChannelSurfacePublishJob;
  }> {
    return this.transactions.withTransaction(async (transaction) => {
      const existing = await transaction.query<PublishJobRow>(
        `SELECT ${JOB_COLUMNS}
           FROM channel_surface_publish_jobs
          WHERE business_id = $1 AND integration_id = $2 AND coalescing_key = $3`,
        [input.businessId, input.integrationId, input.coalescingKey]
      );
      const existingRow = existing.rows[0];
      if (existingRow !== undefined) {
        return { outcome: "coalesced", job: publishJob(existingRow) };
      }

      const activeIntegration = await transaction.query(
        `SELECT 1
           FROM integrations AS integrations
           JOIN integration_apps AS apps
             ON apps.business_id = integrations.business_id
            AND apps.id = integrations.app_id
          WHERE integrations.business_id = $1
            AND integrations.id = $2
            AND integrations.external_tenant_id = $3
            AND integrations.status = 'active'
            AND apps.status = 'active'
            AND apps.provider = $4`,
        [input.businessId, input.integrationId, input.externalTenantId, input.provider]
      );
      if (activeIntegration.rows.length === 0) {
        throw new Error("channel_surface_integration_not_active");
      }

      await transaction.query(
        `INSERT INTO channel_surface_instances (
           business_id, provider, integration_id, external_tenant_id, external_subject, surface,
           external_id, render_digest, status, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, '', 'active', $8::timestamptz, $8::timestamptz)
         ON CONFLICT (
           business_id, provider, integration_id, external_tenant_id, external_subject, surface,
           external_id
         ) DO NOTHING`,
        [
          input.businessId,
          input.provider,
          input.integrationId,
          input.externalTenantId,
          input.externalSubject,
          input.surface,
          input.externalId,
          this.now(),
        ]
      );
      const locked = await transaction.query<{ status: ChannelSurfaceInstanceStatus }>(
        `SELECT status
           FROM channel_surface_instances
          WHERE business_id = $1
            AND provider = $2
            AND integration_id = $3
            AND external_tenant_id = $4
            AND external_subject = $5
            AND surface = $6
            AND external_id = $7
          FOR UPDATE`,
        [
          input.businessId,
          input.provider,
          input.integrationId,
          input.externalTenantId,
          input.externalSubject,
          input.surface,
          input.externalId,
        ]
      );
      if (locked.rows[0]?.status !== "active") {
        throw new Error("channel_surface_instance_not_publishable");
      }

      const coalesced = await transaction.query<PublishJobRow>(
        `SELECT ${JOB_COLUMNS}
           FROM channel_surface_publish_jobs
          WHERE business_id = $1 AND integration_id = $2 AND coalescing_key = $3`,
        [input.businessId, input.integrationId, input.coalescingKey]
      );
      const coalescedRow = coalesced.rows[0];
      if (coalescedRow !== undefined) {
        return { outcome: "coalesced", job: publishJob(coalescedRow) };
      }

      const generationResult = await transaction.query<{ generation: number | string }>(
        `SELECT COALESCE(MAX(generation), 0) + 1 AS generation
           FROM channel_surface_publish_jobs
          WHERE business_id = $1
            AND integration_id = $2
            AND external_tenant_id = $3
            AND external_subject = $4
            AND surface = $5`,
        [
          input.businessId,
          input.integrationId,
          input.externalTenantId,
          input.externalSubject,
          input.surface,
        ]
      );
      const generation = Number(generationResult.rows[0]?.generation ?? 1);
      const now = this.now();

      if (input.supersedePending) {
        await transaction.query(
          `UPDATE channel_surface_publish_jobs
              SET status = 'superseded', updated_at = $6::timestamptz
            WHERE business_id = $1
              AND integration_id = $2
              AND external_tenant_id = $3
              AND external_subject = $4
              AND surface = $5
              AND status IN ('pending', 'retry_wait')`,
          [
            input.businessId,
            input.integrationId,
            input.externalTenantId,
            input.externalSubject,
            input.surface,
            now,
          ]
        );
      }

      const inserted = await transaction.query<PublishJobRow>(
        `INSERT INTO channel_surface_publish_jobs (
           business_id, integration_id, external_tenant_id, external_subject, surface,
           coalescing_key, generation, status, next_attempt_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8::timestamptz,
           $8::timestamptz, $8::timestamptz)
         RETURNING ${JOB_COLUMNS}`,
        [
          input.businessId,
          input.integrationId,
          input.externalTenantId,
          input.externalSubject,
          input.surface,
          input.coalescingKey,
          generation,
          now,
        ]
      );
      return { outcome: "enqueued", job: publishJob(inserted.rows[0]) };
    });
  }

  async getPublishJob(
    key: ChannelSurfacePublishJobKey
  ): Promise<PersistedChannelSurfacePublishJob | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<PublishJobRow>(
        `SELECT ${JOB_COLUMNS}
           FROM channel_surface_publish_jobs
          WHERE business_id = $1
            AND integration_id = $2
            AND external_tenant_id = $3
            AND external_subject = $4
            AND surface = $5
            AND generation = $6`,
        [
          key.businessId,
          key.integrationId,
          key.externalTenantId,
          key.externalSubject,
          key.surface,
          key.generation,
        ]
      );
      const row = result.rows[0];
      return row === undefined ? null : publishJob(row);
    });
  }

  async getLatestPublishJob(
    key: Omit<ChannelSurfacePublishJobKey, "generation">
  ): Promise<PersistedChannelSurfacePublishJob | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<PublishJobRow>(
        `SELECT ${JOB_COLUMNS}
           FROM channel_surface_publish_jobs
          WHERE business_id = $1
            AND integration_id = $2
            AND external_tenant_id = $3
            AND external_subject = $4
            AND surface = $5
          ORDER BY generation DESC
          LIMIT 1`,
        [key.businessId, key.integrationId, key.externalTenantId, key.externalSubject, key.surface]
      );
      const row = result.rows[0];
      return row === undefined ? null : publishJob(row);
    });
  }

  async supersedePublish(input: {
    job: ChannelSurfacePublishJobKey;
    leaseOwner: string;
  }): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE channel_surface_publish_jobs
            SET status = 'superseded',
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = $8::timestamptz
          WHERE business_id = $1
            AND integration_id = $2
            AND external_tenant_id = $3
            AND external_subject = $4
            AND surface = $5
            AND generation = $6
            AND status = 'leased'
            AND lease_owner = $7
          RETURNING generation`,
        [
          input.job.businessId,
          input.job.integrationId,
          input.job.externalTenantId,
          input.job.externalSubject,
          input.job.surface,
          input.job.generation,
          input.leaseOwner,
          this.now(),
        ]
      );
      return result.rows.length > 0;
    });
  }

  async claimPublish(options: {
    businessId: string;
    owner: string;
    limit: number;
    leaseDurationMs: number;
  }): Promise<readonly PersistedChannelSurfacePublishJob[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<PublishJobRow>(
        `WITH candidates AS (
           SELECT business_id, integration_id, external_tenant_id, external_subject, surface,
                  generation
             FROM channel_surface_publish_jobs
            WHERE business_id = $1
              AND (
                (
                  status IN ('pending', 'retry_wait')
                  AND next_attempt_at <= $2::timestamptz
                )
                OR (status = 'leased' AND lease_expires_at <= $2::timestamptz)
              )
            ORDER BY next_attempt_at, created_at, generation
            FOR UPDATE SKIP LOCKED
            LIMIT $3
         )
         UPDATE channel_surface_publish_jobs AS jobs
            SET status = 'leased',
                lease_owner = $4,
                lease_expires_at =
                  $2::timestamptz + ($5::integer * interval '1 millisecond'),
                attempt = jobs.attempt + 1,
                updated_at = $2::timestamptz
           FROM candidates
          WHERE jobs.business_id = candidates.business_id
            AND jobs.integration_id = candidates.integration_id
            AND jobs.external_tenant_id = candidates.external_tenant_id
            AND jobs.external_subject = candidates.external_subject
            AND jobs.surface = candidates.surface
            AND jobs.generation = candidates.generation
         RETURNING ${QUALIFIED_JOB_COLUMNS}`,
        [
          options.businessId,
          this.now(),
          Math.max(0, options.limit),
          options.owner,
          Math.max(1, options.leaseDurationMs),
        ]
      );
      return result.rows.map(publishJob);
    });
  }

  async finalizePublishSuccess(input: {
    key: ChannelSurfaceInstanceKey;
    generation: number;
    leaseOwner: string;
    providerViewId: string;
    providerHash: string;
    artifactId?: string;
    artifactRevision?: number;
    renderDigest: string;
  }): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      await validateArtifactReference(
        transaction,
        input.key.businessId,
        input.artifactId,
        input.artifactRevision
      );
      const now = this.now();
      const completed = await transaction.query(
        `UPDATE channel_surface_publish_jobs
            SET status = 'succeeded',
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error_code = NULL,
                updated_at = $8::timestamptz
          WHERE business_id = $1
            AND integration_id = $2
            AND external_tenant_id = $3
            AND external_subject = $4
            AND surface = $5
            AND generation = $6
            AND status = 'leased'
            AND lease_owner = $7
          RETURNING generation`,
        [
          input.key.businessId,
          input.key.integrationId,
          input.key.externalTenantId,
          input.key.externalSubject,
          input.key.surface,
          input.generation,
          input.leaseOwner,
          now,
        ]
      );
      if (completed.rows.length === 0) return false;

      const updated = await transaction.query(
        `UPDATE channel_surface_instances
            SET provider_view_id = $8,
                provider_hash = $9,
                artifact_id = $10,
                artifact_revision = $11,
                render_digest = $12,
                last_published_at = $13::timestamptz,
                updated_at = $13::timestamptz
          WHERE business_id = $1
            AND provider = $2
            AND integration_id = $3
            AND external_tenant_id = $4
            AND external_subject = $5
            AND surface = $6
            AND external_id = $7
            AND status = 'active'
          RETURNING external_id`,
        [
          input.key.businessId,
          input.key.provider,
          input.key.integrationId,
          input.key.externalTenantId,
          input.key.externalSubject,
          input.key.surface,
          input.key.externalId,
          input.providerViewId,
          input.providerHash,
          input.artifactId ?? null,
          input.artifactRevision ?? null,
          input.renderDigest,
          now,
        ]
      );
      if (updated.rows.length === 0) {
        throw new Error("channel_surface_instance_not_publishable");
      }
      return true;
    });
  }

  async finalizePublishFailure(input: {
    job: ChannelSurfacePublishJobKey;
    leaseOwner: string;
    status: "retry_wait" | "ambiguous" | "failed";
    errorCode: string;
    nextAttemptAt?: string;
  }): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE channel_surface_publish_jobs
            SET status = $8,
                lease_owner = NULL,
                lease_expires_at = NULL,
                next_attempt_at = COALESCE($9::timestamptz, next_attempt_at),
                last_error_code = $10,
                updated_at = $11::timestamptz
          WHERE business_id = $1
            AND integration_id = $2
            AND external_tenant_id = $3
            AND external_subject = $4
            AND surface = $5
            AND generation = $6
            AND status = 'leased'
            AND lease_owner = $7
          RETURNING generation`,
        [
          input.job.businessId,
          input.job.integrationId,
          input.job.externalTenantId,
          input.job.externalSubject,
          input.job.surface,
          input.job.generation,
          input.leaseOwner,
          input.status,
          input.nextAttemptAt ?? null,
          input.errorCode,
          this.now(),
        ]
      );
      return result.rows.length > 0;
    });
  }
}

export class SlackCapabilityObservationStore {
  constructor(
    private readonly transactions: TransactionPort,
    private readonly now: () => string
  ) {}

  async get(
    key: SlackCapabilityObservationKey
  ): Promise<PersistedSlackCapabilityObservation | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<CapabilityRow>(
        `SELECT ${CAPABILITY_COLUMNS}
           FROM slack_capability_observations
          WHERE business_id = $1
            AND integration_id = $2
            AND capability = $3
            AND renderer_version = $4
            AND expires_at > $5::timestamptz`,
        [key.businessId, key.integrationId, key.capability, key.rendererVersion, this.now()]
      );
      const row = result.rows[0];
      return row === undefined ? null : capability(row);
    });
  }

  async upsert(
    input: SlackCapabilityObservationKey & {
      status: SlackCapabilityObservationStatus;
      expiresAt: string;
    }
  ): Promise<PersistedSlackCapabilityObservation> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<CapabilityRow>(
        `INSERT INTO slack_capability_observations (
           business_id, integration_id, capability, renderer_version, status, expires_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)
         ON CONFLICT (business_id, integration_id, capability, renderer_version) DO UPDATE SET
           status = EXCLUDED.status,
           expires_at = EXCLUDED.expires_at,
           updated_at = EXCLUDED.updated_at
         RETURNING ${CAPABILITY_COLUMNS}`,
        [
          input.businessId,
          input.integrationId,
          input.capability,
          input.rendererVersion,
          input.status,
          input.expiresAt,
          this.now(),
        ]
      );
      return capability(result.rows[0]);
    });
  }
}
