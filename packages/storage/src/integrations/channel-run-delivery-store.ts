import type { TransactionPort } from "../ports";

export type ChannelRunDeliveryStatus = "pending" | "done" | "failed";

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
}

export interface PersistedChannelRunDeliveryRecord extends PersistedChannelRunDelivery {
  status: ChannelRunDeliveryStatus;
  slackMessageTs?: string;
  /** The tool-call approval whose Approve/Deny prompt was last posted for this Run, if any. */
  approvalPostedId?: string;
  /** The Slack message ts of that posted approval prompt, for the best-effort status update. */
  approvalMessageTs?: string;
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
    status          text NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
    slack_message_ts text,
    approval_posted_id text,
    approval_message_ts text,
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    PRIMARY KEY (business_id, run_id)
  )`,
  `CREATE INDEX IF NOT EXISTS channel_run_deliveries_pending_idx
    ON channel_run_deliveries (business_id, status)
    WHERE status = 'pending'`,
];

/** Adds the Approve/Deny prompt correlation columns to a table created before they existed. */
export const CHANNEL_RUN_DELIVERY_APPROVAL_COLUMNS_STATEMENTS: readonly string[] = [
  `ALTER TABLE channel_run_deliveries ADD COLUMN IF NOT EXISTS approval_posted_id text`,
  `ALTER TABLE channel_run_deliveries ADD COLUMN IF NOT EXISTS approval_message_ts text`,
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
  created_at: Date | string;
  updated_at: Date | string;
}

const RUN_DELIVERY_COLUMNS = `business_id, run_id, integration_id, route_id, provider, destination,
  thread_id, agent_id, principal_id, idempotency_key, status, slack_message_ts, approval_posted_id,
  approval_message_ts, created_at, updated_at`;

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
    ...(row.slack_message_ts === null ? {} : { slackMessageTs: row.slack_message_ts }),
    ...(row.approval_posted_id === null ? {} : { approvalPostedId: row.approval_posted_id }),
    ...(row.approval_message_ts === null ? {} : { approvalMessageTs: row.approval_message_ts }),
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
           approval_posted_id, approval_message_ts, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', NULL, NULL, NULL,
           $11::timestamptz, $11::timestamptz)
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

  async listPending(businessId: string): Promise<PersistedChannelRunDeliveryRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<RunDeliveryRow>(
        `SELECT ${RUN_DELIVERY_COLUMNS}
           FROM channel_run_deliveries
          WHERE business_id = $1 AND status = 'pending'
          ORDER BY created_at`,
        [businessId]
      );
      return result.rows.map(runDeliveryRecord);
    });
  }

  async markStatus(
    businessId: string,
    runId: string,
    status: Exclude<ChannelRunDeliveryStatus, "pending">
  ): Promise<PersistedChannelRunDeliveryRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<RunDeliveryRow>(
        `UPDATE channel_run_deliveries
            SET status = $3,
                updated_at = $4::timestamptz
          WHERE business_id = $1 AND run_id = $2
          RETURNING ${RUN_DELIVERY_COLUMNS}`,
        [businessId, runId, status, this.now()]
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("channel_run_delivery_not_found");
      return runDeliveryRecord(row);
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
