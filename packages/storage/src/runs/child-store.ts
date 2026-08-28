import type { Queryable, TransactionPort } from "../ports";

/**
 * Mirrors `ChildTerminalStatus` and `UnsignalledChildCompletion` in `@tulipfarm/run-kernel`, which
 * storage may not import. The sweeper's port is structural, so the shapes bind at the call site.
 */
type ChildTerminalStatus = "succeeded" | "failed" | "cancelled" | "expired";

export interface UnsignalledChildCompletion {
  readonly childRunId: string;
  readonly status: ChildTerminalStatus;
  readonly finishedAt: string;
}

/** The child Run statuses a parent parked on one is entitled to be woken by. */
const SWEEPABLE_CHILD_STATUSES: readonly string[] = ["succeeded", "failed", "cancelled"];

export interface ChildAuthorityRecord {
  readonly tools: readonly string[];
  readonly classifications: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
}

/**
 * What a link row claims about the child's authority.
 *
 * `delegated` — the row *granted* this authority, so the child's own Tool loop is intersected
 * with it. That is right when a model invented the child's task at runtime.
 *
 * `lineage` — the row only records who called whom, for depth, cancellation and audit. The child
 * is a published definition whose authority was reviewed when it was authored, so narrowing it
 * again by the caller would make a Routine behave differently as a child than it does alone.
 */
export type ChildAuthorityBinding = "delegated" | "lineage";

/** Absent on rows written before the column existed, all of which granted their authority. */
export const DEFAULT_CHILD_AUTHORITY_BINDING: ChildAuthorityBinding = "delegated";

/**
 * How a finished child resumes the parent parked on it.
 *
 * The token is minted once by `DurableWaitManager.register` and returned to the registrant only,
 * so it has to be persisted somewhere the *child's* completion can reach — the child knows its
 * parent through this row and nothing else. Approvals solve the same problem the same way, by
 * keeping the grant on the row whose settlement redeems it (`apps/api/src/approvals`).
 */
export interface ChildResumeGrant {
  readonly waitId: string;
  readonly token: string;
}

export interface PersistedChildLink {
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly authority: ChildAuthorityRecord;
  readonly authorityBinding: ChildAuthorityBinding;
  /** Absent for a detached child, which no parent is waiting on. */
  readonly resume: ChildResumeGrant | null;
  /** The parent Tool call that spawned this child; absent when nothing spawned it from a call. */
  readonly callId: string | null;
  readonly detachedAt: string | null;
  readonly createdAt: string;
}

export interface LinkChildInput {
  readonly businessId: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly authority: ChildAuthorityRecord;
  /** Defaults to `delegated`, so a caller that does not think about this cannot widen a child. */
  readonly authorityBinding?: ChildAuthorityBinding;
  readonly resume?: ChildResumeGrant;
  readonly callId?: string;
  /**
   * Write the link already closed, for a child that is detached from birth.
   *
   * `link` then `detach` leaves a window in which the row is open, so a cancel cascade or a crash
   * in between can reach a child the caller never waits on. Passing it here makes the two one
   * statement.
   */
  readonly detachedAt?: string;
  readonly createdAt: string;
}

/** Child Run authority is immutable and un-widenable; detach cannot be undone. */
export const CHILD_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS run_child_links (
    business_id     text NOT NULL,
    parent_run_id   uuid NOT NULL,
    child_run_id    uuid NOT NULL,
    authority       jsonb NOT NULL CHECK (jsonb_typeof(authority) = 'object'),
    detached_at     timestamptz,
    created_at      timestamptz NOT NULL,
    PRIMARY KEY (business_id, parent_run_id, child_run_id),
    FOREIGN KEY (business_id, parent_run_id) REFERENCES runs(business_id, id),
    FOREIGN KEY (business_id, child_run_id) REFERENCES runs(business_id, id),
    CHECK (parent_run_id <> child_run_id)
  )`,
  "ALTER TABLE run_child_links ADD COLUMN IF NOT EXISTS resume jsonb",
  "ALTER TABLE run_child_links ADD COLUMN IF NOT EXISTS call_id text",
  // Backfills to `delegated`, which is what every row written before this column meant.
  `ALTER TABLE run_child_links
     ADD COLUMN IF NOT EXISTS authority_binding text NOT NULL DEFAULT 'delegated'`,
  `ALTER TABLE run_child_links DROP CONSTRAINT IF EXISTS run_child_links_binding_known`,
  `ALTER TABLE run_child_links
     ADD CONSTRAINT run_child_links_binding_known
     CHECK (authority_binding IN ('delegated', 'lineage'))`,
  `CREATE OR REPLACE FUNCTION reject_run_child_link_change()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.authority IS DISTINCT FROM NEW.authority THEN
        RAISE EXCEPTION 'run_child_link_authority_immutable';
      END IF;
      IF OLD.authority_binding IS DISTINCT FROM NEW.authority_binding THEN
        RAISE EXCEPTION 'run_child_link_authority_immutable';
      END IF;
      IF OLD.resume IS DISTINCT FROM NEW.resume THEN
        RAISE EXCEPTION 'run_child_link_resume_immutable';
      END IF;
      IF OLD.call_id IS DISTINCT FROM NEW.call_id THEN
        RAISE EXCEPTION 'run_child_link_call_immutable';
      END IF;
      IF OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'run_child_link_authority_immutable';
      END IF;
      IF OLD.detached_at IS NOT NULL AND NEW.detached_at IS DISTINCT FROM OLD.detached_at THEN
        RAISE EXCEPTION 'run_child_link_detach_final';
      END IF;
      RETURN NEW;
    END;
    $$`,
  "DROP TRIGGER IF EXISTS run_child_links_immutable ON run_child_links",
  `CREATE TRIGGER run_child_links_immutable
    BEFORE UPDATE ON run_child_links
    FOR EACH ROW EXECUTE FUNCTION reject_run_child_link_change()`,
  `CREATE INDEX IF NOT EXISTS run_child_links_child_idx
    ON run_child_links (business_id, child_run_id)`,
  // One Tool call spawns at most one child, which is what lets a replayed call find the child it
  // already made instead of spawning a second one.
  `CREATE UNIQUE INDEX IF NOT EXISTS run_child_links_call_idx
    ON run_child_links (business_id, parent_run_id, call_id)
    WHERE call_id IS NOT NULL`,
];

interface ChildLinkRow {
  parent_run_id: string;
  child_run_id: string;
  authority: ChildAuthorityRecord;
  authority_binding: string | null;
  resume: ChildResumeGrant | null;
  call_id: string | null;
  detached_at: Date | string | null;
  created_at: Date | string;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function persistedChildLink(row: ChildLinkRow): PersistedChildLink {
  return {
    parentRunId: row.parent_run_id,
    childRunId: row.child_run_id,
    authority: row.authority,
    authorityBinding:
      row.authority_binding === "lineage" ? "lineage" : DEFAULT_CHILD_AUTHORITY_BINDING,
    resume: row.resume ?? null,
    callId: row.call_id ?? null,
    detachedAt: row.detached_at === null ? null : timestamp(row.detached_at),
    createdAt: timestamp(row.created_at),
  };
}

const CHILD_LINK_COLUMNS =
  "parent_run_id, child_run_id, authority, authority_binding, resume, call_id, detached_at, created_at";

/**
 * Reverse lookup over the link table: what one Run was granted when it was delegated.
 *
 * Read-only and outside the transaction port, because every host that executes a child Run has to
 * bound it by its grant — the control plane and the co-located Tool host alike — and neither may
 * carry its own copy of this query.
 */
export class ChildLinkAncestryStore {
  constructor(private readonly q: Queryable) {}

  /**
   * Children that are durably terminal while the parent parked on them is still waiting.
   *
   * Joining `runs` to `run_waits` is what makes this a reconciliation rather than a queue: it asks
   * the two durable facts directly, so a completion whose signal was lost to a crash, or one no
   * signalling path owns at all, is found by the same query on the next sweep.
   */
  async listUnsignalledCompletions(
    businessId: string,
    limit: number
  ): Promise<readonly UnsignalledChildCompletion[]> {
    const { rows } = await this.q.query<{
      child_run_id: string;
      status: string;
      finished_at: Date | string;
    }>(
      `SELECT link.child_run_id, child.status, child.finished_at
         FROM run_child_links link
         JOIN runs child
           ON child.business_id = link.business_id
          AND child.id = link.child_run_id
         JOIN run_waits wait
           ON wait.business_id = link.business_id
          AND wait.id = (link.resume ->> 'waitId')::uuid
        WHERE link.business_id = $1
          AND link.detached_at IS NULL
          AND link.resume IS NOT NULL
          AND child.status = ANY($2::text[])
          AND child.finished_at IS NOT NULL
          AND wait.status = 'pending'
        ORDER BY child.finished_at, link.child_run_id
        LIMIT $3`,
      [businessId, [...SWEEPABLE_CHILD_STATUSES], limit]
    );
    return rows.map((row) => ({
      childRunId: row.child_run_id,
      status: row.status as ChildTerminalStatus,
      finishedAt: timestamp(row.finished_at),
    }));
  }

  async parentLink(businessId: string, childRunId: string): Promise<PersistedChildLink | null> {
    const { rows } = await this.q.query<ChildLinkRow>(
      `SELECT ${CHILD_LINK_COLUMNS}
         FROM run_child_links
        WHERE business_id = $1 AND child_run_id = $2
        ORDER BY created_at
        LIMIT 1`,
      [businessId, childRunId]
    );
    const row = rows[0];
    return row === undefined ? null : persistedChildLink(row);
  }

  /**
   * The child a given parent Tool call already spawned, if any.
   *
   * A parked Tool call is re-dispatched when its Run resumes, so without this a replay would
   * spawn a second child and wait on it forever. `call_id` is stable across the replay; the
   * child Run id is not.
   */
  async callLink(
    businessId: string,
    parentRunId: string,
    callId: string
  ): Promise<PersistedChildLink | null> {
    const { rows } = await this.q.query<ChildLinkRow>(
      `SELECT ${CHILD_LINK_COLUMNS}
         FROM run_child_links
        WHERE business_id = $1 AND parent_run_id = $2 AND call_id = $3`,
      [businessId, parentRunId, callId]
    );
    const row = rows[0];
    return row === undefined ? null : persistedChildLink(row);
  }
}

/** Durable parent/child Run links driven by `@tulipfarm/run-kernel`'s `ChildRunManager`. */
export class ChildLinkStore {
  constructor(private readonly transactions: TransactionPort) {}

  /** Links a child under narrowed authority; re-linking never widens it. */
  async link(input: LinkChildInput): Promise<PersistedChildLink> {
    return this.transactions.withTransaction(async (transaction) => {
      const inserted = await transaction.query<ChildLinkRow>(
        `INSERT INTO run_child_links (
           business_id, parent_run_id, child_run_id, authority, authority_binding,
           resume, call_id, created_at, detached_at
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8::timestamptz, $9::timestamptz)
         ON CONFLICT (business_id, parent_run_id, child_run_id) DO NOTHING
         RETURNING ${CHILD_LINK_COLUMNS}`,
        [
          input.businessId,
          input.parentRunId,
          input.childRunId,
          JSON.stringify(input.authority),
          input.authorityBinding ?? DEFAULT_CHILD_AUTHORITY_BINDING,
          input.resume === undefined ? null : JSON.stringify(input.resume),
          input.callId ?? null,
          input.createdAt,
          input.detachedAt ?? null,
        ]
      );
      const row = inserted.rows[0];
      if (row) return persistedChildLink(row);

      const existing = await transaction.query<ChildLinkRow>(
        `SELECT ${CHILD_LINK_COLUMNS}
           FROM run_child_links
          WHERE business_id = $1 AND parent_run_id = $2 AND child_run_id = $3`,
        [input.businessId, input.parentRunId, input.childRunId]
      );
      return persistedChildLink(existing.rows[0]);
    });
  }

  /** Detaches a child from parent cancellation; repeated detach is a no-op. */
  async detach(
    businessId: string,
    parentRunId: string,
    childRunId: string,
    detachedAt: string
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ child_run_id: string }>(
        `UPDATE run_child_links
            SET detached_at = $4::timestamptz
          WHERE business_id = $1
            AND parent_run_id = $2
            AND child_run_id = $3
            AND detached_at IS NULL
        RETURNING child_run_id`,
        [businessId, parentRunId, childRunId, detachedAt]
      );
      return result.rows.length === 1;
    });
  }

  async listChildren(
    businessId: string,
    parentRunId: string
  ): Promise<readonly PersistedChildLink[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<ChildLinkRow>(
        `SELECT ${CHILD_LINK_COLUMNS}
           FROM run_child_links
          WHERE business_id = $1 AND parent_run_id = $2
          ORDER BY created_at, child_run_id`,
        [businessId, parentRunId]
      );
      return result.rows.map(persistedChildLink);
    });
  }
}
