import { randomUUID } from "node:crypto";
import type { Queryable, TransactionPort } from "../ports";

/** Everything a Task's action can ask a human to do. */
export type TaskAction =
  | { kind: "answer"; field: string; sink: "business_profile" | "memory"; hint?: string }
  | { kind: "chat"; prompt: string }
  | { kind: "link"; href: string }
  | { kind: "ack" };

export type TaskAssigneeKind = "user" | "role";
export type TaskStatus = "open" | "claimed" | "done" | "snoozed" | "dismissed";

export interface TaskSubjectRef {
  readonly kind: string;
  readonly id: string;
}

export interface TaskRecord {
  readonly id: string;
  readonly businessId: string;
  readonly assigneeKind: TaskAssigneeKind;
  readonly assigneeId: string;
  readonly dedupeKey: string;
  readonly title: string;
  readonly detail?: string;
  readonly action: TaskAction;
  readonly blocking: boolean;
  readonly priority: number;
  readonly status: TaskStatus;
  readonly claimedBy?: string;
  readonly snoozedUntil?: Date;
  readonly remindAt?: Date;
  readonly dueAt?: Date;
  readonly originAgentId?: string;
  readonly originRunId?: string;
  readonly subject?: TaskSubjectRef;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly closedAt?: Date;
}

/** A producer's upsert request: an unsatisfied check, or a re-detected one that closes itself. */
export interface UpsertTaskInput {
  readonly businessId: string;
  readonly assigneeKind: TaskAssigneeKind;
  readonly assigneeId: string;
  readonly dedupeKey: string;
  readonly title: string;
  readonly detail?: string;
  readonly action: TaskAction;
  readonly blocking?: boolean;
  readonly priority?: number;
  readonly remindAt?: Date;
  readonly dueAt?: Date;
  readonly originAgentId?: string;
  readonly originRunId?: string;
  readonly subject?: TaskSubjectRef;
}

export type TaskStoreErrorCode = "not_found" | "not_answerable" | "dismissed_permanently";

export class TaskStoreError extends Error {
  constructor(
    public readonly code: TaskStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "TaskStoreError";
  }
}

export interface TaskStore {
  /**
   * Upsert on the live dedupe key (open/claimed/snoozed). A `dismissed` row for the same key is
   * left alone and blocks recreation — the caller gets that existing row back instead.
   */
  upsertOpen(input: UpsertTaskInput, now: Date): Promise<TaskRecord>;
  /** Closes a task by dedupe key when a reconciler observes the underlying gap is now satisfied. */
  closeByDedupeKey(businessId: string, dedupeKey: string, now: Date): Promise<void>;
  get(businessId: string, id: string): Promise<TaskRecord | undefined>;
  /** Open/claimed/snoozed tasks assigned to this user directly or through any of their roles. */
  listForPrincipal(
    businessId: string,
    userId: string,
    roles: readonly string[],
    includeSnoozed: boolean
  ): Promise<TaskRecord[]>;
  claim(businessId: string, id: string, userId: string, now: Date): Promise<TaskRecord>;
  markDone(businessId: string, id: string, now: Date): Promise<TaskRecord>;
  snooze(businessId: string, id: string, until: Date, now: Date): Promise<TaskRecord>;
  dismiss(businessId: string, id: string, now: Date): Promise<TaskRecord>;
}

export const TASK_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id              uuid PRIMARY KEY,
    business_id     text NOT NULL,
    assignee_kind   text NOT NULL CHECK (assignee_kind IN ('user', 'role')),
    assignee_id     text NOT NULL CHECK (length(assignee_id) > 0),
    dedupe_key      text NOT NULL CHECK (length(dedupe_key) > 0),
    title           text NOT NULL CHECK (length(title) > 0),
    detail          text,
    action          jsonb NOT NULL,
    blocking        boolean NOT NULL DEFAULT false,
    priority        smallint NOT NULL DEFAULT 0,
    status          text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'claimed', 'done', 'snoozed', 'dismissed')),
    claimed_by      text,
    snoozed_until   timestamptz,
    remind_at       timestamptz,
    due_at          timestamptz,
    origin_agent_id text,
    origin_run_id   text,
    subject_kind    text,
    subject_id      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    closed_at       timestamptz,
    CHECK ((status = 'claimed') = (claimed_by IS NOT NULL)),
    CHECK ((status = 'snoozed') = (snoozed_until IS NOT NULL)),
    CHECK ((subject_kind IS NULL) = (subject_id IS NULL))
  )`,
  // Re-detecting the same gap for the same assignee must upsert, not duplicate — but only while
  // the task is still live. A dismissed row keeps the key permanently, which is what stops the
  // reconciler from ever reopening something the user told it to drop.
  `CREATE UNIQUE INDEX IF NOT EXISTS tasks_live_dedupe_idx
    ON tasks (business_id, assignee_kind, assignee_id, dedupe_key)
    WHERE status IN ('open', 'claimed', 'snoozed')`,
  `CREATE INDEX IF NOT EXISTS tasks_dismissed_dedupe_idx
    ON tasks (business_id, assignee_kind, assignee_id, dedupe_key)
    WHERE status = 'dismissed'`,
  `CREATE INDEX IF NOT EXISTS tasks_assignee_idx
    ON tasks (business_id, assignee_kind, assignee_id)
    WHERE status IN ('open', 'claimed', 'snoozed')`,
];

const COLUMNS = `id, business_id, assignee_kind, assignee_id, dedupe_key, title, detail, action,
  blocking, priority, status, claimed_by, snoozed_until, remind_at, due_at, origin_agent_id,
  origin_run_id, subject_kind, subject_id, created_at, updated_at, closed_at`;

interface TaskRow {
  id: string;
  business_id: string;
  assignee_kind: TaskAssigneeKind;
  assignee_id: string;
  dedupe_key: string;
  title: string;
  detail: string | null;
  action: TaskAction;
  blocking: boolean;
  priority: number;
  status: TaskStatus;
  claimed_by: string | null;
  snoozed_until: Date | string | null;
  remind_at: Date | string | null;
  due_at: Date | string | null;
  origin_agent_id: string | null;
  origin_run_id: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  closed_at: Date | string | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function taskRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    assigneeKind: row.assignee_kind,
    assigneeId: row.assignee_id,
    dedupeKey: row.dedupe_key,
    title: row.title,
    ...(row.detail === null ? {} : { detail: row.detail }),
    action: typeof row.action === "string" ? JSON.parse(row.action) : row.action,
    blocking: row.blocking,
    priority: row.priority,
    status: row.status,
    ...(row.claimed_by === null ? {} : { claimedBy: row.claimed_by }),
    ...(row.snoozed_until === null ? {} : { snoozedUntil: toDate(row.snoozed_until) }),
    ...(row.remind_at === null ? {} : { remindAt: toDate(row.remind_at) }),
    ...(row.due_at === null ? {} : { dueAt: toDate(row.due_at) }),
    ...(row.origin_agent_id === null ? {} : { originAgentId: row.origin_agent_id }),
    ...(row.origin_run_id === null ? {} : { originRunId: row.origin_run_id }),
    ...(row.subject_kind === null || row.subject_id === null
      ? {}
      : { subject: { kind: row.subject_kind, id: row.subject_id } }),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    ...(row.closed_at === null ? {} : { closedAt: toDate(row.closed_at) }),
  };
}

/** Durable Task store: system-created human work items behind the Companion, `/tasks`, and home. */
export class TaskRepo implements TaskStore {
  constructor(private readonly transactions: TransactionPort) {}

  async upsertOpen(input: UpsertTaskInput, now: Date): Promise<TaskRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      const dismissed = await transaction.query<{ id: string }>(
        `SELECT id FROM tasks
          WHERE business_id = $1 AND assignee_kind = $2 AND assignee_id = $3
            AND dedupe_key = $4 AND status = 'dismissed'
          LIMIT 1`,
        [input.businessId, input.assigneeKind, input.assigneeId, input.dedupeKey]
      );
      if (dismissed.rows[0]) {
        throw new TaskStoreError(
          "dismissed_permanently",
          `task ${input.dedupeKey} was dismissed and will not be recreated`
        );
      }

      const result = await transaction.query<TaskRow>(
        `INSERT INTO tasks
           (id, business_id, assignee_kind, assignee_id, dedupe_key, title, detail, action,
            blocking, priority, remind_at, due_at, origin_agent_id, origin_run_id, subject_kind,
            subject_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)
         ON CONFLICT (business_id, assignee_kind, assignee_id, dedupe_key)
           WHERE status IN ('open', 'claimed', 'snoozed')
           DO UPDATE SET
             title = EXCLUDED.title,
             detail = EXCLUDED.detail,
             action = EXCLUDED.action,
             blocking = EXCLUDED.blocking,
             priority = EXCLUDED.priority,
             remind_at = EXCLUDED.remind_at,
             due_at = EXCLUDED.due_at,
             origin_agent_id = EXCLUDED.origin_agent_id,
             origin_run_id = EXCLUDED.origin_run_id,
             subject_kind = EXCLUDED.subject_kind,
             subject_id = EXCLUDED.subject_id,
             updated_at = EXCLUDED.updated_at
         RETURNING ${COLUMNS}`,
        [
          randomUUID(),
          input.businessId,
          input.assigneeKind,
          input.assigneeId,
          input.dedupeKey,
          input.title,
          input.detail ?? null,
          JSON.stringify(input.action),
          input.blocking ?? false,
          input.priority ?? 0,
          input.remindAt ?? null,
          input.dueAt ?? null,
          input.originAgentId ?? null,
          input.originRunId ?? null,
          input.subject?.kind ?? null,
          input.subject?.id ?? null,
          now,
        ]
      );
      const row = result.rows[0];
      if (!row) throw new TaskStoreError("not_found", "task vanished on insert");
      return taskRecord(row);
    });
  }

  async closeByDedupeKey(businessId: string, dedupeKey: string, now: Date): Promise<void> {
    await this.transactions.withTransaction((transaction) =>
      transaction.query(
        `UPDATE tasks
            SET status = 'done', claimed_by = NULL, snoozed_until = NULL,
                updated_at = $3, closed_at = $3
          WHERE business_id = $1 AND dedupe_key = $2 AND status IN ('open', 'claimed', 'snoozed')`,
        [businessId, dedupeKey, now]
      )
    );
  }

  async get(businessId: string, id: string): Promise<TaskRecord | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<TaskRow>(
        `SELECT ${COLUMNS} FROM tasks WHERE business_id = $1 AND id = $2`,
        [businessId, id]
      );
      const row = result.rows[0];
      return row ? taskRecord(row) : undefined;
    });
  }

  async listForPrincipal(
    businessId: string,
    userId: string,
    roles: readonly string[],
    includeSnoozed: boolean
  ): Promise<TaskRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const statuses = includeSnoozed ? "('open', 'claimed', 'snoozed')" : "('open', 'claimed')";
      const result = await transaction.query<TaskRow>(
        `SELECT ${COLUMNS} FROM tasks
          WHERE business_id = $1
            AND status IN ${statuses}
            AND (
              (assignee_kind = 'user' AND assignee_id = $2)
              OR (assignee_kind = 'role' AND assignee_id = ANY($3::text[]))
            )
          ORDER BY blocking DESC, priority DESC, created_at ASC`,
        [businessId, userId, [...roles]]
      );
      return result.rows.map(taskRecord);
    });
  }

  private async requireOpenOrClaimed(
    transaction: Queryable,
    businessId: string,
    id: string
  ): Promise<TaskRow> {
    const result = await transaction.query<TaskRow>(
      `SELECT ${COLUMNS} FROM tasks WHERE business_id = $1 AND id = $2`,
      [businessId, id]
    );
    const row = result.rows[0];
    if (!row) throw new TaskStoreError("not_found", `task ${id} does not exist`);
    return row;
  }

  async claim(businessId: string, id: string, userId: string, now: Date): Promise<TaskRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      await this.requireOpenOrClaimed(transaction, businessId, id);
      const result = await transaction.query<TaskRow>(
        `UPDATE tasks SET status = 'claimed', claimed_by = $3, updated_at = $4
          WHERE business_id = $1 AND id = $2 AND status = 'open'
          RETURNING ${COLUMNS}`,
        [businessId, id, userId, now]
      );
      const row = result.rows[0];
      if (!row) throw new TaskStoreError("not_found", `task ${id} is not open`);
      return taskRecord(row);
    });
  }

  async markDone(businessId: string, id: string, now: Date): Promise<TaskRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      await this.requireOpenOrClaimed(transaction, businessId, id);
      const result = await transaction.query<TaskRow>(
        `UPDATE tasks SET status = 'done', claimed_by = NULL, updated_at = $3, closed_at = $3
          WHERE business_id = $1 AND id = $2 AND status IN ('open', 'claimed')
          RETURNING ${COLUMNS}`,
        [businessId, id, now]
      );
      const row = result.rows[0];
      if (!row) throw new TaskStoreError("not_found", `task ${id} is not open or claimed`);
      return taskRecord(row);
    });
  }

  async snooze(businessId: string, id: string, until: Date, now: Date): Promise<TaskRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      await this.requireOpenOrClaimed(transaction, businessId, id);
      const result = await transaction.query<TaskRow>(
        `UPDATE tasks SET status = 'snoozed', claimed_by = NULL, snoozed_until = $3, updated_at = $4
          WHERE business_id = $1 AND id = $2 AND status IN ('open', 'claimed')
          RETURNING ${COLUMNS}`,
        [businessId, id, until, now]
      );
      const row = result.rows[0];
      if (!row) throw new TaskStoreError("not_found", `task ${id} is not open or claimed`);
      return taskRecord(row);
    });
  }

  async dismiss(businessId: string, id: string, now: Date): Promise<TaskRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      await this.requireOpenOrClaimed(transaction, businessId, id);
      const result = await transaction.query<TaskRow>(
        `UPDATE tasks
            SET status = 'dismissed', claimed_by = NULL, snoozed_until = NULL,
                updated_at = $3, closed_at = $3
          WHERE business_id = $1 AND id = $2 AND status IN ('open', 'claimed', 'snoozed')
          RETURNING ${COLUMNS}`,
        [businessId, id, now]
      );
      const row = result.rows[0];
      if (!row)
        throw new TaskStoreError("not_found", `task ${id} is not open, claimed, or snoozed`);
      return taskRecord(row);
    });
  }
}
