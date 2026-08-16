import type { Queryable, TransactionPort } from "../ports";

export interface ChildAuthorityRecord {
  readonly tools: readonly string[];
  readonly classifications: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
}

export interface PersistedChildLink {
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly authority: ChildAuthorityRecord;
  readonly detachedAt: string | null;
  readonly createdAt: string;
}

export interface LinkChildInput {
  readonly businessId: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly authority: ChildAuthorityRecord;
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
  `CREATE OR REPLACE FUNCTION reject_run_child_link_change()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.authority IS DISTINCT FROM NEW.authority THEN
        RAISE EXCEPTION 'run_child_link_authority_immutable';
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
];

interface ChildLinkRow {
  parent_run_id: string;
  child_run_id: string;
  authority: ChildAuthorityRecord;
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
    detachedAt: row.detached_at === null ? null : timestamp(row.detached_at),
    createdAt: timestamp(row.created_at),
  };
}

const CHILD_LINK_COLUMNS = "parent_run_id, child_run_id, authority, detached_at, created_at";

/**
 * Reverse lookup over the link table: what one Run was granted when it was delegated.
 *
 * Read-only and outside the transaction port, because every host that executes a child Run has to
 * bound it by its grant — the control plane and the co-located Tool host alike — and neither may
 * carry its own copy of this query.
 */
export class ChildLinkAncestryStore {
  constructor(private readonly q: Queryable) {}

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
}

/** Durable parent/child Run links driven by `@tulipfarm/run-kernel`'s `ChildRunManager`. */
export class ChildLinkStore {
  constructor(private readonly transactions: TransactionPort) {}

  /** Links a child under narrowed authority; re-linking never widens it. */
  async link(input: LinkChildInput): Promise<PersistedChildLink> {
    return this.transactions.withTransaction(async (transaction) => {
      const inserted = await transaction.query<ChildLinkRow>(
        `INSERT INTO run_child_links (
           business_id, parent_run_id, child_run_id, authority, created_at
         ) VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)
         ON CONFLICT (business_id, parent_run_id, child_run_id) DO NOTHING
         RETURNING ${CHILD_LINK_COLUMNS}`,
        [
          input.businessId,
          input.parentRunId,
          input.childRunId,
          JSON.stringify(input.authority),
          input.createdAt,
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
