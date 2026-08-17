import { randomUUID } from "node:crypto";
import { emptyMemorySections, type MemorySectionKey, type MemorySections } from "@tulipfarm/schema";
import type { Queryable, TransactionPort } from "@tulipfarm/storage";
import {
  applyMemoryDelta,
  hashMemoryDocument,
  hashMemorySection,
  type MemoryDelta,
  parseMemoryDocument,
  renderMemoryDocument,
  replaceMemorySection,
} from "./document";

/** Who wrote a revision. Four writers share one document, so provenance is never inferred. */
export type MemoryWriter = "tool" | "curator" | "task" | "erasure";

/** Which of the two write shapes produced a revision. */
export type MemoryOperation = "delta" | "replace";

export interface MemoryDocumentRecord {
  readonly businessId: string;
  readonly userId: string;
  /** The stored Markdown page — the bytes a model is given, verbatim. */
  readonly document: string;
  /** Parsed from {@link document} for writers that patch one section. Never stored. */
  readonly sections: MemorySections;
  readonly version: number;
  readonly revisionId: string;
  readonly documentHash: string;
  readonly updatedAt: Date;
}

export interface MemoryDeltaRequest {
  readonly businessId: string;
  readonly userId: string;
  readonly delta: MemoryDelta;
  readonly writer: MemoryWriter;
  readonly writerRunId?: string;
  readonly now: Date;
}

/**
 * A whole-section overwrite. `expectedSectionHash` is mandatory and has no default: a replacement
 * is derived from a section read minutes earlier, across a model call, so without it the Curator
 * would silently destroy every edit made in between.
 */
export interface MemoryReplacementRequest {
  readonly businessId: string;
  readonly userId: string;
  readonly section: MemorySectionKey;
  readonly content: string;
  readonly expectedSectionHash: string;
  readonly writer: Exclude<MemoryWriter, "tool">;
  readonly writerRunId?: string;
  readonly now: Date;
}

export type MemoryWriteOutcome =
  | { readonly outcome: "applied"; readonly record: MemoryDocumentRecord }
  | { readonly outcome: "unchanged"; readonly record: MemoryDocumentRecord }
  | {
      readonly outcome: "conflict";
      readonly record: MemoryDocumentRecord;
      readonly section: MemorySectionKey;
      readonly currentContent: string;
      readonly currentHash: string;
    };

export interface MemoryDeltaOutcome {
  readonly record: MemoryDocumentRecord;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** Named for removal but absent. The caller must not report these as forgotten. */
  readonly unmatched: readonly string[];
}

/** Newest revisions kept per user; older ones are pruned on write so history cannot grow forever. */
export const MEMORY_REVISION_RETENTION = 50;

export const MEMORY_DOCUMENT_STORAGE_STATEMENTS: readonly string[] = [
  // One row per user, so a section patch takes exactly one `FOR UPDATE` lock. `document` is the
  // rendered Markdown itself, not a structured projection of it: the page is what every reader
  // wants, and the section grammar is already enforced before the write by
  // `assertWritableEntries`, which refuses any entry that is a heading. Storing the projection
  // instead would mean the bytes served to a model were assembled by whichever renderer version
  // happened to read the row.
  `CREATE TABLE IF NOT EXISTS user_memory (
    business_id   text NOT NULL,
    user_id       text NOT NULL,
    document      text NOT NULL,
    version       integer NOT NULL DEFAULT 1,
    revision_id   uuid NOT NULL,
    document_hash text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS user_memory_revisions (
    business_id   text NOT NULL,
    revision_id   uuid NOT NULL,
    user_id       text NOT NULL,
    version       integer NOT NULL,
    document      text NOT NULL,
    document_hash text NOT NULL,
    writer        text NOT NULL CHECK (writer IN ('tool', 'curator', 'task', 'erasure')),
    writer_run_id text,
    section_key   text,
    operation     text CHECK (operation IN ('delta', 'replace')),
    -- Only the Curator and erasure may overwrite a whole section; a model-issued write
    -- can name entries but never replace what it did not see.
    CONSTRAINT user_memory_revisions_tool_never_replaces
      CHECK (writer <> 'tool' OR operation = 'delta'),
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, revision_id)
  )`,
  `CREATE INDEX IF NOT EXISTS user_memory_revisions_user_idx
     ON user_memory_revisions (business_id, user_id, version DESC)`,
];

interface DocumentRow {
  business_id: string;
  user_id: string;
  document: string;
  version: number;
  revision_id: string;
  document_hash: string;
  updated_at: Date | string;
}

function toRecord(row: DocumentRow): MemoryDocumentRecord {
  return {
    businessId: row.business_id,
    userId: row.user_id,
    document: row.document,
    sections: parseMemoryDocument(row.document),
    version: row.version,
    revisionId: row.revision_id,
    documentHash: row.document_hash,
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

/** A user's Memory Document: read whole into every turn, written one section at a time. */
export class MemoryDocumentRepo {
  constructor(private readonly transactions: TransactionPort) {}

  async read(businessId: string, userId: string): Promise<MemoryDocumentRecord | undefined> {
    const result = await this.transactions.withTransaction((tx) =>
      tx.query<DocumentRow>(
        `SELECT business_id, user_id, document, version, revision_id, document_hash, updated_at
           FROM user_memory WHERE business_id = $1 AND user_id = $2`,
        [businessId, userId]
      )
    );
    const row = result.rows[0];
    return row ? toRecord(row) : undefined;
  }

  /**
   * The stored Markdown, served verbatim for context assembly. An absent document renders as
   * empty, never as an error. Returning the bytes rather than re-rendering them is what makes the
   * row auditable: what a reviewer reads in `psql` is exactly what the model was given.
   */
  async render(businessId: string, userId: string): Promise<string> {
    const record = await this.read(businessId, userId);
    return record?.document ?? "";
  }

  /**
   * The Tool write. Touches only the entries the caller names, so it takes no stale check and can
   * never destroy a concurrent writer's entry.
   */
  async applyDelta(request: MemoryDeltaRequest): Promise<MemoryDeltaOutcome> {
    return this.transactions.withTransaction(async (tx) => {
      const current = await this.lock(tx, request.businessId, request.userId, request.now);
      const result = applyMemoryDelta(current.sections, request.delta);
      const record = await this.commit(tx, {
        businessId: request.businessId,
        userId: request.userId,
        current,
        sections: result.sections,
        section: request.delta.section,
        operation: "delta",
        writer: request.writer,
        ...(request.writerRunId === undefined ? {} : { writerRunId: request.writerRunId }),
        now: request.now,
      });
      return {
        record,
        added: result.added,
        removed: result.removed,
        unmatched: result.unmatched,
      };
    });
  }

  /**
   * The privileged write: a whole-section overwrite, gated on the hash the writer read. No model
   * reaches this — `writer` cannot be `"tool"`, and the chat Tool only calls `applyDelta`.
   */
  async replaceSection(request: MemoryReplacementRequest): Promise<MemoryWriteOutcome> {
    return this.transactions.withTransaction(async (tx) => {
      const current = await this.lock(tx, request.businessId, request.userId, request.now);
      const currentContent = current.sections[request.section];
      const currentHash = hashMemorySection(currentContent);
      if (request.expectedSectionHash !== currentHash) {
        return {
          outcome: "conflict" as const,
          record: current,
          section: request.section,
          currentContent,
          currentHash,
        };
      }

      const sections = replaceMemorySection(current.sections, request.section, request.content);
      if (sections[request.section] === currentContent) {
        return { outcome: "unchanged" as const, record: current };
      }
      const record = await this.commit(tx, {
        businessId: request.businessId,
        userId: request.userId,
        current,
        sections,
        section: request.section,
        operation: "replace",
        writer: request.writer,
        ...(request.writerRunId === undefined ? {} : { writerRunId: request.writerRunId }),
        now: request.now,
      });
      return { outcome: "applied" as const, record };
    });
  }

  private async commit(
    tx: Queryable,
    input: {
      businessId: string;
      userId: string;
      current: MemoryDocumentRecord;
      sections: MemorySections;
      section: MemorySectionKey;
      operation: MemoryOperation;
      writer: MemoryWriter;
      writerRunId?: string;
      now: Date;
    }
  ): Promise<MemoryDocumentRecord> {
    if (input.sections[input.section] === input.current.sections[input.section]) {
      return input.current;
    }

    const revisionId = randomUUID();
    const version = input.current.version + 1;
    const documentHash = hashMemoryDocument(input.sections);
    const updated = await tx.query<DocumentRow>(
      `UPDATE user_memory
          SET document = $3, version = $4, revision_id = $5, document_hash = $6, updated_at = $7
        WHERE business_id = $1 AND user_id = $2
        RETURNING business_id, user_id, document, version, revision_id, document_hash, updated_at`,
      [
        input.businessId,
        input.userId,
        renderMemoryDocument(input.sections),
        version,
        revisionId,
        documentHash,
        input.now,
      ]
    );

    await tx.query(
      `INSERT INTO user_memory_revisions
         (business_id, revision_id, user_id, version, document, document_hash, writer,
          writer_run_id, section_key, operation, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        input.businessId,
        revisionId,
        input.userId,
        version,
        renderMemoryDocument(input.sections),
        documentHash,
        input.writer,
        input.writerRunId ?? null,
        input.section,
        input.operation,
        input.now,
      ]
    );
    await this.prune(tx, input.businessId, input.userId);

    const row = updated.rows[0];
    if (!row) throw new Error("memory document vanished mid-transaction");
    return toRecord(row);
  }

  /** Erasure regenerates from nothing: the document and its whole revision history go. */
  async erase(businessId: string, userId: string): Promise<void> {
    await this.transactions.withTransaction(async (tx) => {
      await tx.query("DELETE FROM user_memory_revisions WHERE business_id = $1 AND user_id = $2", [
        businessId,
        userId,
      ]);
      await tx.query("DELETE FROM user_memory WHERE business_id = $1 AND user_id = $2", [
        businessId,
        userId,
      ]);
    });
  }

  private async lock(
    tx: Queryable,
    businessId: string,
    userId: string,
    now: Date
  ): Promise<MemoryDocumentRecord> {
    // `FOR UPDATE` locks nothing when the row is absent, so materialize it first; the insert is
    // the serialization point for two concurrent first writes.
    const empty = emptyMemorySections();
    await tx.query(
      `INSERT INTO user_memory
         (business_id, user_id, document, version, revision_id, document_hash, created_at, updated_at)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $6)
       ON CONFLICT (business_id, user_id) DO NOTHING`,
      [
        businessId,
        userId,
        renderMemoryDocument(empty),
        randomUUID(),
        hashMemoryDocument(empty),
        now,
      ]
    );
    const locked = await tx.query<DocumentRow>(
      `SELECT business_id, user_id, document, version, revision_id, document_hash, updated_at
         FROM user_memory WHERE business_id = $1 AND user_id = $2 FOR UPDATE`,
      [businessId, userId]
    );
    const row = locked.rows[0];
    if (!row) throw new Error("memory document could not be materialized");
    return toRecord(row);
  }

  private async prune(tx: Queryable, businessId: string, userId: string): Promise<void> {
    await tx.query(
      `DELETE FROM user_memory_revisions
        WHERE business_id = $1 AND user_id = $2
          AND version <= (
            SELECT MIN(version) FROM (
              SELECT version FROM user_memory_revisions
               WHERE business_id = $1 AND user_id = $2
               ORDER BY version DESC LIMIT $3
            ) AS kept
          ) - 1`,
      [businessId, userId, MEMORY_REVISION_RETENTION]
    );
  }
}
