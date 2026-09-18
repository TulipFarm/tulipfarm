import type { TransactionPort } from "../ports";

/**
 * `pending` is new work or a scheduled retry. `delivering` is leased work, recoverable at expiry.
 * Only never-claimed work can be superseded: a retry may be reconciling a message already sent.
 */
export type ChannelRunDeliveryStatus = "pending" | "delivering" | "done" | "failed" | "superseded";

export interface PersistedChannelRunDelivery {
  businessId: string;
  runId: string;
  integrationId: string;
  routeId: string;
  provider: string;
  destination: string;
  threadId?: string;
  agentId: string;
  principalId: string;
  idempotencyKey: string;
  /**
   * The provider message that started this Run — Slack's `event.ts`. Distinct from `threadId`,
   * which is the thread *root* (`thread_ts ?? ts`): reacting to `threadId` would land on the wrong
   * message for every in-thread reply.
   */
  sourceMessageTs?: string;
}

export interface PersistedChannelRunDeliveryRecord extends PersistedChannelRunDelivery {
  status: ChannelRunDeliveryStatus;
  leaseGeneration?: number;
  leaseExpiresAt?: string;
  nextAttemptAt?: string;
  slackMessageTs?: string;
  /** The tool-call approval whose Approve/Deny prompt was last posted for this Run, if any. */
  approvalPostedId?: string;
  /** The Slack message ts of that posted approval prompt, for the best-effort status update. */
  approvalMessageTs?: string;
  /** Set once the Agent acknowledged with a reaction instead of answering; suppresses the reply. */
  acknowledgedEmoji?: string;
  createdAt: string;
  updatedAt: string;
}

export const CHANNEL_RUN_DELIVERY_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS channel_run_deliveries (
    business_id     text NOT NULL,
    run_id          text NOT NULL,
    integration_id  text NOT NULL,
    route_id        text NOT NULL,
    provider        text NOT NULL,
    destination     text NOT NULL,
    thread_id       text,
    agent_id        text NOT NULL,
    principal_id    text NOT NULL,
    idempotency_key text NOT NULL,
    status          text NOT NULL CHECK (
      status IN ('pending', 'delivering', 'done', 'failed', 'superseded')
    ),
    slack_message_ts text,
    approval_posted_id text,
    approval_message_ts text,
    source_message_ts text,
    acknowledged_emoji text,
    lease_generation integer NOT NULL DEFAULT 0,
    lease_expires_at timestamptz,
    next_attempt_at timestamptz,
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    PRIMARY KEY (business_id, run_id)
  )`,
  `CREATE INDEX IF NOT EXISTS channel_run_deliveries_pending_idx
    ON channel_run_deliveries (business_id, status)
    WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS channel_run_deliveries_inflight_thread_idx
    ON channel_run_deliveries (business_id, provider, destination, thread_id)
    WHERE status = 'pending'`,
];

export const CHANNEL_RUN_DELIVERY_LEASE_STATEMENTS: readonly string[] = [
  `ALTER TABLE channel_run_deliveries ADD COLUMN IF NOT EXISTS lease_generation integer NOT NULL DEFAULT 0`,
  `ALTER TABLE channel_run_deliveries ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz`,
  `ALTER TABLE channel_run_deliveries ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz`,
  `UPDATE channel_run_deliveries SET lease_expires_at = updated_at
    WHERE status = 'delivering' AND lease_expires_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS channel_run_deliveries_recovery_idx
    ON channel_run_deliveries (business_id, lease_expires_at) WHERE status = 'delivering'`,
];

/** Adds the Approve/Deny prompt correlation columns to a table created before they existed. */
export const CHANNEL_RUN_DELIVERY_APPROVAL_COLUMNS_STATEMENTS: readonly string[] = [
  `ALTER TABLE channel_run_deliveries ADD COLUMN IF NOT EXISTS approval_posted_id text`,
  `ALTER TABLE channel_run_deliveries ADD COLUMN IF NOT EXISTS approval_message_ts text`,
];

/**
 * Brings a table created before acknowledgement and superseding up to date: the reaction columns,
 * the widened status domain, and the thread index a supersede lookup needs.
 *
 * `ADD CONSTRAINT` is not idempotent, so the check is dropped and re-added as a pair rather than
 * guarded — re-running the pair is a no-op, re-running a bare `ADD` is an error.
 */
export const CHANNEL_RUN_DELIVERY_ACKNOWLEDGE_STATEMENTS: readonly string[] = [
  `ALTER TABLE channel_run_deliveries ADD COLUMN IF NOT EXISTS source_message_ts text`,
  `ALTER TABLE channel_run_deliveries ADD COLUMN IF NOT EXISTS acknowledged_emoji text`,
  `ALTER TABLE channel_run_deliveries DROP CONSTRAINT IF EXISTS channel_run_deliveries_status_check`,
  `ALTER TABLE channel_run_deliveries ADD CONSTRAINT channel_run_deliveries_status_check
    CHECK (status IN ('pending', 'delivering', 'done', 'failed', 'superseded'))`,
  `CREATE INDEX IF NOT EXISTS channel_run_deliveries_inflight_thread_idx
    ON channel_run_deliveries (business_id, provider, destination, thread_id)
    WHERE status = 'pending'`,
];

interface RunDeliveryRow {
  business_id: string;
  run_id: string;
  integration_id: string;
  route_id: string;
  provider: string;
  destination: string;
  thread_id: string | null;
  agent_id: string;
  principal_id: string;
  idempotency_key: string;
  status: ChannelRunDeliveryStatus;
  slack_message_ts: string | null;
  approval_posted_id: string | null;
  approval_message_ts: string | null;
  source_message_ts: string | null;
  acknowledged_emoji: string | null;
  lease_generation: number;
  lease_expires_at: Date | string | null;
  next_attempt_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const RUN_DELIVERY_COLUMNS = `business_id, run_id, integration_id, route_id, provider, destination,
  thread_id, agent_id, principal_id, idempotency_key, status, slack_message_ts, approval_posted_id,
  approval_message_ts, source_message_ts, acknowledged_emoji, lease_generation, lease_expires_at,
  next_attempt_at, created_at, updated_at`;

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function runDeliveryRecord(row: RunDeliveryRow): PersistedChannelRunDeliveryRecord {
  return {
    businessId: row.business_id,
    runId: row.run_id,
    integrationId: row.integration_id,
    routeId: row.route_id,
    provider: row.provider,
    destination: row.destination,
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    agentId: row.agent_id,
    principalId: row.principal_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    leaseGeneration: row.lease_generation,
    ...(row.lease_expires_at == null ? {} : { leaseExpiresAt: timestamp(row.lease_expires_at) }),
    ...(row.next_attempt_at == null ? {} : { nextAttemptAt: timestamp(row.next_attempt_at) }),
    ...(row.slack_message_ts === null ? {} : { slackMessageTs: row.slack_message_ts }),
    ...(row.approval_posted_id === null ? {} : { approvalPostedId: row.approval_posted_id }),
    ...(row.approval_message_ts === null ? {} : { approvalMessageTs: row.approval_message_ts }),
    ...(row.source_message_ts === null ? {} : { sourceMessageTs: row.source_message_ts }),
    ...(row.acknowledged_emoji === null ? {} : { acknowledgedEmoji: row.acknowledged_emoji }),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

/** PostgreSQL correlation between a Run started from a Channel and where its reply must go. */
export class ChannelRunDeliveryStore {
  constructor(
    private readonly transactions: TransactionPort,
    private readonly now: () => string
  ) {}

  async create(delivery: PersistedChannelRunDelivery): Promise<PersistedChannelRunDeliveryRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      const now = this.now();
      const result = await transaction.query<RunDeliveryRow>(
        `INSERT INTO channel_run_deliveries (
           business_id, run_id, integration_id, route_id, provider, destination,
           thread_id, agent_id, principal_id, idempotency_key, status, slack_message_ts,
           approval_posted_id, approval_message_ts, source_message_ts, acknowledged_emoji,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', NULL, NULL, NULL,
           $11, NULL, $12::timestamptz, $12::timestamptz)
         ON CONFLICT (business_id, run_id) DO UPDATE SET run_id = EXCLUDED.run_id
         RETURNING ${RUN_DELIVERY_COLUMNS}`,
        [
          delivery.businessId,
          delivery.runId,
          delivery.integrationId,
          delivery.routeId,
          delivery.provider,
          delivery.destination,
          delivery.threadId ?? null,
          delivery.agentId,
          delivery.principalId,
          delivery.idempotencyKey,
          delivery.sourceMessageTs ?? null,
          now,
        ]
      );
      return runDeliveryRecord(result.rows[0]);
    });
  }

  async find(businessId: string, runId: string): Promise<PersistedChannelRunDeliveryRecord | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<RunDeliveryRow>(
        `SELECT ${RUN_DELIVERY_COLUMNS}
           FROM channel_run_deliveries
          WHERE business_id = $1 AND run_id = $2`,
        [businessId, runId]
      );
      const row = result.rows[0];
      return row === undefined ? null : runDeliveryRecord(row);
    });
  }

  async ownsSlackMessage(input: {
    businessId: string;
    integrationId: string;
    channelId: string;
    messageTs: string;
  }): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `SELECT 1
           FROM channel_run_deliveries
          WHERE business_id = $1
            AND integration_id = $2
            AND provider = 'slack'
            AND destination = $3
            AND slack_message_ts = $4
          LIMIT 1`,
        [input.businessId, input.integrationId, input.channelId, input.messageTs]
      );
      return result.rows.length === 1;
    });
  }

  async ownsSlackReaction(input: {
    businessId: string;
    integrationId: string;
    channelId: string;
    messageTs: string;
    emoji: string;
  }): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `SELECT 1
           FROM channel_run_deliveries
          WHERE business_id = $1
            AND integration_id = $2
            AND provider = 'slack'
            AND destination = $3
            AND source_message_ts = $4
            AND acknowledged_emoji = $5
          LIMIT 1`,
        [input.businessId, input.integrationId, input.channelId, input.messageTs, input.emoji]
      );
      return result.rows.length === 1;
    });
  }

  async listPending(businessId: string): Promise<PersistedChannelRunDeliveryRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<RunDeliveryRow>(
        `SELECT ${RUN_DELIVERY_COLUMNS}
           FROM channel_run_deliveries
          WHERE business_id = $1 AND (
            (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $2::timestamptz))
            OR (status = 'delivering' AND lease_expires_at <= $2::timestamptz)
          )
          ORDER BY created_at`,
        [businessId, this.now()]
      );
      return result.rows.map(runDeliveryRecord);
    });
  }

  /**
   * The newest never-claimed delivery for a provider thread, excluding `runId` itself.
   */
  async findInFlightForThread(input: {
    businessId: string;
    provider: string;
    destination: string;
    threadId: string;
    excludeRunId?: string;
  }): Promise<PersistedChannelRunDeliveryRecord | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<RunDeliveryRow>(
        `SELECT ${RUN_DELIVERY_COLUMNS}
           FROM channel_run_deliveries
          WHERE business_id = $1
            AND provider = $2
            AND destination = $3
            AND thread_id = $4
            AND status = 'pending'
            AND lease_generation = 0
            AND ($5::text IS NULL OR run_id <> $5)
          ORDER BY created_at DESC
          LIMIT 1`,
        [
          input.businessId,
          input.provider,
          input.destination,
          input.threadId,
          input.excludeRunId ?? null,
        ]
      );
      const row = result.rows[0];
      return row === undefined ? null : runDeliveryRecord(row);
    });
  }

  /**
   * Claims pending or expired work for sixty seconds; terminal writes must carry the generation.
   *
   * Returns `null` when the row was already claimed or superseded. Callers must post only on a
   * non-null result: this claim is the sole reason a supersede and a delivery cannot both act on
   * the same Run, and skipping it reintroduces the double reply as a narrow race rather than a
   * reliable one.
   */
  async claim(
    businessId: string,
    runId: string
  ): Promise<PersistedChannelRunDeliveryRecord | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<RunDeliveryRow>(
        `UPDATE channel_run_deliveries
            SET status = 'delivering',
                lease_generation = lease_generation + 1,
                lease_expires_at = $3::timestamptz + interval '60 seconds',
                next_attempt_at = NULL,
                updated_at = $3::timestamptz
          WHERE business_id = $1 AND run_id = $2 AND (
            (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $3::timestamptz))
            OR (status = 'delivering' AND lease_expires_at <= $3::timestamptz)
          )
          RETURNING ${RUN_DELIVERY_COLUMNS}`,
        [businessId, runId, this.now()]
      );
      const row = result.rows[0];
      return row === undefined ? null : runDeliveryRecord(row);
    });
  }

  /**
   * Retires a delivery a newer message has taken over, so its reply is never posted.
   *
   * Conditional on `pending` for the same reason `claim` is, and reports whether it won so the
   * caller knows whether cancelling the Run is still worthwhile.
   */
  async markSuperseded(businessId: string, runId: string): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<RunDeliveryRow>(
        `UPDATE channel_run_deliveries
            SET status = 'superseded',
                updated_at = $3::timestamptz
          WHERE business_id = $1 AND run_id = $2 AND status = 'pending' AND lease_generation = 0
          RETURNING ${RUN_DELIVERY_COLUMNS}`,
        [businessId, runId, this.now()]
      );
      return result.rows.length > 0;
    });
  }

  /** Records the reaction an Agent answered with, which suppresses this Run's text reply. */
  async markAcknowledged(
    businessId: string,
    runId: string,
    emoji: string
  ): Promise<PersistedChannelRunDeliveryRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<RunDeliveryRow>(
        `UPDATE channel_run_deliveries
            SET acknowledged_emoji = $3,
                updated_at = $4::timestamptz
          WHERE business_id = $1 AND run_id = $2
          RETURNING ${RUN_DELIVERY_COLUMNS}`,
        [businessId, runId, emoji, this.now()]
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("channel_run_delivery_not_found");
      return runDeliveryRecord(row);
    });
  }

  async markStatus(
    businessId: string,
    runId: string,
    status: "done" | "failed",
    leaseGeneration?: number
  ): Promise<PersistedChannelRunDeliveryRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<RunDeliveryRow>(
        `UPDATE channel_run_deliveries
            SET status = $3,
                lease_expires_at = NULL,
                updated_at = $4::timestamptz
          WHERE business_id = $1 AND run_id = $2
            AND (($5::integer IS NULL AND status = 'pending') OR (
              status = 'delivering' AND lease_generation = $5 AND lease_expires_at > $4::timestamptz
            ))
          RETURNING ${RUN_DELIVERY_COLUMNS}`,
        [businessId, runId, status, this.now(), leaseGeneration ?? null]
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("channel_run_delivery_not_found");
      return runDeliveryRecord(row);
    });
  }

  async retry(
    businessId: string,
    runId: string,
    leaseGeneration: number,
    retryAfterMs: number
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const now = this.now();
      const result = await transaction.query(
        `UPDATE channel_run_deliveries
            SET status = 'pending', lease_expires_at = NULL, next_attempt_at = $4::timestamptz,
                updated_at = $5::timestamptz
          WHERE business_id = $1 AND run_id = $2 AND status = 'delivering'
            AND lease_generation = $3 AND lease_expires_at > $5::timestamptz
          RETURNING run_id`,
        [
          businessId,
          runId,
          leaseGeneration,
          new Date(Date.parse(now) + Math.max(1000, retryAfterMs)).toISOString(),
          now,
        ]
      );
      return result.rows.length === 1;
    });
  }

  async setSlackMessageTs(
    businessId: string,
    runId: string,
    slackMessageTs: string
  ): Promise<PersistedChannelRunDeliveryRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<RunDeliveryRow>(
        `UPDATE channel_run_deliveries
            SET slack_message_ts = $3,
                updated_at = $4::timestamptz
          WHERE business_id = $1 AND run_id = $2
          RETURNING ${RUN_DELIVERY_COLUMNS}`,
        [businessId, runId, slackMessageTs, this.now()]
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("channel_run_delivery_not_found");
      return runDeliveryRecord(row);
    });
  }

  /** Records which approval's Approve/Deny prompt was posted, so a poll tick never reposts it. */
  async setApprovalPosted(
    businessId: string,
    runId: string,
    approvalId: string,
    slackMessageTs: string
  ): Promise<PersistedChannelRunDeliveryRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<RunDeliveryRow>(
        `UPDATE channel_run_deliveries
            SET approval_posted_id = $3,
                approval_message_ts = $4,
                updated_at = $5::timestamptz
          WHERE business_id = $1 AND run_id = $2
          RETURNING ${RUN_DELIVERY_COLUMNS}`,
        [businessId, runId, approvalId, slackMessageTs, this.now()]
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("channel_run_delivery_not_found");
      return runDeliveryRecord(row);
    });
  }
}
