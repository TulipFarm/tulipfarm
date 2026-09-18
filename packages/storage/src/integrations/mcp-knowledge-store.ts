import {
  type McpKnowledgeCheckpointDocument,
  type McpKnowledgeSelectionDocument,
  validateMcpKnowledgeCheckpointDocument,
  validateMcpKnowledgeSelectionDocument,
} from "@tulipfarm/schema";
import type { Queryable, TransactionPort } from "../ports/transaction";

export const MCP_KNOWLEDGE_STORAGE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS mcp_knowledge_selections (
    business_id text NOT NULL, id text NOT NULL, integration_key text NOT NULL,
    account_id text NOT NULL, owner_principal_id text NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0), document jsonb NOT NULL,
    enabled boolean NOT NULL, checkpoint jsonb,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    requested_generation bigint NOT NULL DEFAULT 0,
    lease_id text, lease_until timestamptz, lease_generation bigint,
    last_attempt_at timestamptz, last_completed_at timestamptz, last_error text,
    PRIMARY KEY (business_id, id), UNIQUE (business_id, account_id)
  )`,
  `CREATE INDEX IF NOT EXISTS mcp_knowledge_due_idx
     ON mcp_knowledge_selections (next_attempt_at) WHERE enabled`,
  `CREATE TABLE IF NOT EXISTS mcp_knowledge_source_links (
    business_id text NOT NULL, source_id text NOT NULL, selection_id text NOT NULL,
    page_id uuid NOT NULL, selection_revision bigint NOT NULL,
    cleanup_pending boolean NOT NULL DEFAULT false,
    PRIMARY KEY (business_id, source_id),
    UNIQUE (business_id, page_id),
    FOREIGN KEY (business_id, selection_id)
      REFERENCES mcp_knowledge_selections (business_id, id)
  )`,
] as const;

export interface McpKnowledgeStoredSelection {
  readonly selection: McpKnowledgeSelectionDocument;
  readonly revision: number;
  readonly checkpoint: McpKnowledgeCheckpointDocument | null;
  readonly lastAttemptAt: string | null;
  readonly lastCompletedAt: string | null;
  readonly nextAttemptAt: string;
  readonly errorCode: string | null;
  readonly cleanupPending: number;
}
export interface McpKnowledgeClaim {
  readonly leaseId: string;
  readonly selection: McpKnowledgeSelectionDocument;
}
export interface McpKnowledgeSourceLink {
  readonly businessId: string;
  readonly sourceId: string;
  readonly selectionId: string;
  readonly pageId: string;
  readonly selectionRevision: number;
  readonly cleanupPending: boolean;
}
type SelectionRow = {
  document: unknown;
  revision: number | string;
  checkpoint: unknown;
  last_attempt_at: Date | string | null;
  last_completed_at: Date | string | null;
  next_attempt_at: Date | string;
  last_error: string | null;
  cleanup_pending?: string | number;
};
function date(value: Date | string): string {
  return new Date(value).toISOString();
}
function stored(row: SelectionRow): McpKnowledgeStoredSelection {
  return {
    selection: validateMcpKnowledgeSelectionDocument(row.document),
    revision: Number(row.revision),
    checkpoint:
      row.checkpoint === null ? null : validateMcpKnowledgeCheckpointDocument(row.checkpoint),
    lastAttemptAt: row.last_attempt_at === null ? null : date(row.last_attempt_at),
    lastCompletedAt: row.last_completed_at === null ? null : date(row.last_completed_at),
    nextAttemptAt: date(row.next_attempt_at),
    errorCode: row.last_error,
    cleanupPending: Number(row.cleanup_pending ?? 0),
  };
}
export class McpKnowledgeFenceError extends Error {
  constructor() {
    super("knowledge_selection_changed");
  }
}

export class McpKnowledgeStore {
  constructor(
    private readonly db: Queryable,
    private readonly transactions: TransactionPort
  ) {}

  async get(
    businessId: string,
    accountId: string
  ): Promise<McpKnowledgeStoredSelection | undefined> {
    const { rows } = await this.db.query<SelectionRow>(
      `SELECT s.*, (SELECT count(*) FROM mcp_knowledge_source_links l
         WHERE l.business_id=s.business_id AND l.selection_id=s.id AND l.cleanup_pending) cleanup_pending
       FROM mcp_knowledge_selections s WHERE business_id=$1 AND account_id=$2`,
      [businessId, accountId]
    );
    return rows[0] ? stored(rows[0]) : undefined;
  }

  async selectionById(
    businessId: string,
    selectionId: string
  ): Promise<McpKnowledgeSelectionDocument | undefined> {
    const { rows } = await this.db.query<{ document: unknown }>(
      `SELECT document FROM mcp_knowledge_selections WHERE business_id=$1 AND id=$2`,
      [businessId, selectionId]
    );
    return rows[0] ? validateMcpKnowledgeSelectionDocument(rows[0].document) : undefined;
  }

  async save(selection: McpKnowledgeSelectionDocument, expectedRevision?: number): Promise<void> {
    validateMcpKnowledgeSelectionDocument(selection);
    if (!Number.isSafeInteger(Number(selection.revision))) throw new McpKnowledgeFenceError();
    await this.transactions.withTransaction(async (tx) => {
      const current = await tx.query<SelectionRow>(
        `SELECT * FROM mcp_knowledge_selections WHERE business_id=$1 AND account_id=$2 FOR UPDATE`,
        [selection.binding.businessId, selection.binding.accountId]
      );
      if (current.rows[0]) {
        const prior = stored(current.rows[0]);
        if (
          prior.revision !== expectedRevision ||
          selection.id !== prior.selection.id ||
          selection.binding.ownerUserId !== prior.selection.binding.ownerUserId ||
          selection.binding.integrationId !== prior.selection.binding.integrationId ||
          Number(selection.revision) !== prior.revision + 1
        )
          throw new McpKnowledgeFenceError();
        await tx.query(
          `UPDATE mcp_knowledge_selections SET revision=$3,document=$4::jsonb,enabled=$5,
             checkpoint=NULL,next_attempt_at=now(),requested_generation=requested_generation+1,
             lease_id=NULL,lease_until=NULL,last_error=NULL
           WHERE business_id=$1 AND account_id=$2`,
          [
            selection.binding.businessId,
            selection.binding.accountId,
            Number(selection.revision),
            JSON.stringify(selection),
            selection.enabled,
          ]
        );
        // Old copies stay unreadable through the live selection revision check until refreshed.
        await tx.query(
          `UPDATE mcp_knowledge_source_links SET cleanup_pending=true
           WHERE business_id=$1 AND selection_id=$2`,
          [selection.binding.businessId, selection.id]
        );
      } else {
        if (expectedRevision !== undefined || selection.revision !== "1")
          throw new McpKnowledgeFenceError();
        const inserted = await tx.query(
          `INSERT INTO mcp_knowledge_selections
             (business_id,id,integration_key,account_id,owner_principal_id,revision,document,enabled)
           VALUES ($1,$2,$3,$4,$5,1,$6::jsonb,$7)
           ON CONFLICT (business_id,account_id) DO NOTHING RETURNING id`,
          [
            selection.binding.businessId,
            selection.id,
            selection.binding.integrationId,
            selection.binding.accountId,
            selection.binding.ownerUserId,
            JSON.stringify(selection),
            selection.enabled,
          ]
        );
        if (inserted.rows.length !== 1) throw new McpKnowledgeFenceError();
      }
    });
  }

  async requestSync(
    businessId: string,
    accountId: string,
    expectedRevision: number
  ): Promise<void> {
    const { rows } = await this.db.query(
      `UPDATE mcp_knowledge_selections SET next_attempt_at=now(),
         requested_generation=requested_generation+1
       WHERE business_id=$1 AND account_id=$2 AND revision=$3 AND enabled RETURNING id`,
      [businessId, accountId, expectedRevision]
    );
    if (rows.length !== 1) throw new McpKnowledgeFenceError();
  }

  async disable(businessId: string, accountId: string, expectedRevision: number): Promise<void> {
    const current = await this.get(businessId, accountId);
    if (!current || current.revision !== expectedRevision) throw new McpKnowledgeFenceError();
    await this.save(
      { ...current.selection, enabled: false, revision: String(expectedRevision + 1) },
      expectedRevision
    );
  }

  async linkForPage(
    businessId: string,
    pageId: string
  ): Promise<McpKnowledgeSourceLink | undefined> {
    const { rows } = await this.db.query<{
      business_id: string;
      source_id: string;
      selection_id: string;
      page_id: string;
      selection_revision: string | number;
      cleanup_pending: boolean;
    }>(`SELECT * FROM mcp_knowledge_source_links WHERE business_id=$1 AND page_id=$2`, [
      businessId,
      pageId,
    ]);
    const row = rows[0];
    return row
      ? {
          businessId: row.business_id,
          sourceId: row.source_id,
          selectionId: row.selection_id,
          pageId: row.page_id,
          selectionRevision: Number(row.selection_revision),
          cleanupPending: row.cleanup_pending,
        }
      : undefined;
  }

  async claimDue(
    businessId: string,
    leaseId: string,
    now: Date
  ): Promise<McpKnowledgeClaim | undefined> {
    return this.transactions.withTransaction(async (tx) => {
      const { rows } = await tx.query<SelectionRow & { id: string }>(
        `SELECT * FROM mcp_knowledge_selections WHERE business_id=$1 AND enabled
           AND next_attempt_at <= $2 AND (lease_until IS NULL OR lease_until <= $2)
           AND NOT EXISTS (SELECT 1 FROM mcp_knowledge_source_links l
             WHERE l.business_id=mcp_knowledge_selections.business_id
               AND l.selection_id=mcp_knowledge_selections.id AND l.cleanup_pending)
         ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [businessId, now]
      );
      const row = rows[0];
      if (!row) return undefined;
      await tx.query(
        `UPDATE mcp_knowledge_selections SET lease_id=$3,lease_until=$4,
           lease_generation=requested_generation,last_attempt_at=$5
         WHERE business_id=$1 AND id=$2`,
        [businessId, row.id, leaseId, new Date(now.getTime() + 120_000), now]
      );
      return { leaseId, selection: validateMcpKnowledgeSelectionDocument(row.document) };
    });
  }

  async withLease<T>(
    claim: McpKnowledgeClaim,
    now: Date,
    work: (tx: Queryable) => Promise<T>
  ): Promise<T> {
    return this.transactions.withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT id FROM mcp_knowledge_selections
         WHERE business_id=$1 AND id=$2 AND revision=$3 AND enabled
           AND lease_id=$4 AND lease_until>$5 FOR UPDATE`,
        [
          claim.selection.binding.businessId,
          claim.selection.id,
          Number(claim.selection.revision),
          claim.leaseId,
          now,
        ]
      );
      if (rows.length !== 1) throw new McpKnowledgeFenceError();
      const result = await work(tx);
      const fence = await tx.query(
        `SELECT id FROM mcp_knowledge_selections
         WHERE business_id=$1 AND id=$2 AND revision=$3 AND enabled
           AND lease_id=$4 AND lease_until>clock_timestamp()`,
        [
          claim.selection.binding.businessId,
          claim.selection.id,
          Number(claim.selection.revision),
          claim.leaseId,
        ]
      );
      if (fence.rows.length !== 1) throw new McpKnowledgeFenceError();
      return result;
    });
  }

  async checkpoint(
    claim: McpKnowledgeClaim,
    checkpoint: McpKnowledgeCheckpointDocument,
    now: Date
  ): Promise<void> {
    validateMcpKnowledgeCheckpointDocument(checkpoint);
    if (checkpoint.selectionRevision !== claim.selection.revision)
      throw new McpKnowledgeFenceError();
    await this.withLease(claim, now, async (tx) => {
      await tx.query(
        `UPDATE mcp_knowledge_selections SET checkpoint=$3::jsonb WHERE business_id=$1 AND id=$2`,
        [claim.selection.binding.businessId, claim.selection.id, JSON.stringify(checkpoint)]
      );
    });
  }

  async finish(
    claim: McpKnowledgeClaim,
    now: Date,
    nextAttemptAt: Date,
    errorCode: string | null,
    completed: boolean
  ): Promise<void> {
    await this.transactions.withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE mcp_knowledge_selections SET
           next_attempt_at=CASE WHEN requested_generation>lease_generation THEN $3 ELSE $4 END,
           last_error=$5,last_completed_at=CASE WHEN $6 THEN $3 ELSE last_completed_at END,
           lease_id=NULL,lease_until=NULL,lease_generation=NULL
         WHERE business_id=$1 AND id=$2 AND enabled AND revision=$7
           AND lease_id=$8 AND lease_until>$3 RETURNING id`,
        [
          claim.selection.binding.businessId,
          claim.selection.id,
          now,
          nextAttemptAt,
          errorCode,
          completed,
          Number(claim.selection.revision),
          claim.leaseId,
        ]
      );
      if (rows.length !== 1) throw new McpKnowledgeFenceError();
    });
  }

  async assertCurrent(selection: McpKnowledgeSelectionDocument): Promise<void> {
    const row = await this.get(selection.binding.businessId, selection.binding.accountId);
    if (
      !row?.selection.enabled ||
      row.selection.id !== selection.id ||
      row.selection.revision !== selection.revision
    )
      throw new McpKnowledgeFenceError();
  }

  async listEnabled(businessId: string): Promise<McpKnowledgeSelectionDocument[]> {
    const { rows } = await this.db.query<{ document: unknown }>(
      `SELECT document FROM mcp_knowledge_selections WHERE business_id=$1 AND enabled`,
      [businessId]
    );
    return rows.map((row) => validateMcpKnowledgeSelectionDocument(row.document));
  }

  async markAccountCleanup(businessId: string, accountId: string): Promise<void> {
    await this.transactions.withTransaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE mcp_knowledge_selections SET enabled=false,
           revision=revision+1,
           document=jsonb_set(jsonb_set(document,'{enabled}','false'::jsonb),
             '{revision}',to_jsonb((revision+1)::text)),
           lease_id=NULL,lease_until=NULL,last_error='account_unavailable'
         WHERE business_id=$1 AND account_id=$2 AND enabled RETURNING id`,
        [businessId, accountId]
      );
      for (const row of rows) {
        await tx.query(
          `UPDATE mcp_knowledge_source_links SET cleanup_pending=true
           WHERE business_id=$1 AND selection_id=$2`,
          [businessId, row.id]
        );
      }
    });
  }

  async linkSource(
    tx: Queryable,
    claim: McpKnowledgeClaim,
    sourceId: string,
    pageId: string
  ): Promise<void> {
    await tx.query(
      `INSERT INTO mcp_knowledge_source_links
         (business_id,source_id,selection_id,page_id,selection_revision,cleanup_pending)
       VALUES ($1,$2,$3,$4,$5,false)
       ON CONFLICT (business_id,source_id) DO UPDATE SET
         page_id=EXCLUDED.page_id,selection_revision=EXCLUDED.selection_revision,
         cleanup_pending=false`,
      [
        claim.selection.binding.businessId,
        sourceId,
        claim.selection.id,
        pageId,
        Number(claim.selection.revision),
      ]
    );
  }

  async sourceLinks(businessId: string, selectionId: string): Promise<McpKnowledgeSourceLink[]> {
    const { rows } = await this.db.query<{
      business_id: string;
      source_id: string;
      selection_id: string;
      page_id: string;
      selection_revision: string | number;
      cleanup_pending: boolean;
    }>(
      `SELECT * FROM mcp_knowledge_source_links WHERE business_id=$1 AND selection_id=$2 ORDER BY source_id`,
      [businessId, selectionId]
    );
    return rows.map((row) => ({
      businessId: row.business_id,
      sourceId: row.source_id,
      selectionId: row.selection_id,
      pageId: row.page_id,
      selectionRevision: Number(row.selection_revision),
      cleanupPending: row.cleanup_pending,
    }));
  }

  async cleanupBatch<T>(
    businessId: string,
    work: (tx: Queryable, link: McpKnowledgeSourceLink) => Promise<T>
  ): Promise<number> {
    return this.transactions.withTransaction(async (tx) => {
      const { rows } = await tx.query<{
        business_id: string;
        source_id: string;
        selection_id: string;
        page_id: string;
        selection_revision: string | number;
        cleanup_pending: boolean;
      }>(
        `SELECT * FROM mcp_knowledge_source_links WHERE business_id=$1 AND cleanup_pending
         AND NOT EXISTS (SELECT 1 FROM mcp_knowledge_selections s
           WHERE s.business_id=mcp_knowledge_source_links.business_id
             AND s.id=mcp_knowledge_source_links.selection_id AND s.lease_until>clock_timestamp())
         ORDER BY source_id LIMIT 20 FOR UPDATE SKIP LOCKED`,
        [businessId]
      );
      for (const row of rows) {
        await work(tx, {
          businessId: row.business_id,
          sourceId: row.source_id,
          selectionId: row.selection_id,
          pageId: row.page_id,
          selectionRevision: Number(row.selection_revision),
          cleanupPending: true,
        });
        await tx.query(
          `DELETE FROM mcp_knowledge_source_links WHERE business_id=$1 AND source_id=$2`,
          [businessId, row.source_id]
        );
      }
      return rows.length;
    });
  }
}
