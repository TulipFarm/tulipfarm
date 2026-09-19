import { randomUUID } from "node:crypto";
import { type Queryable, withTransaction } from "@tulipfarm/storage";
import { FileError } from "./service";

export const FILE_CONVERTER_REVISION = "anydoc-0.2.4-projection-1";
export const FILE_KNOWLEDGE_STATUSES = [
  "queued",
  "processing",
  "succeeded",
  "refused",
  "failed",
] as const;
export type FileKnowledgeStatus = (typeof FILE_KNOWLEDGE_STATUSES)[number];

export interface FileKnowledgeReceipt {
  readonly requestId: string;
  readonly fileId: string;
  readonly versionId: string;
  readonly converterRevision: string;
  readonly status: FileKnowledgeStatus;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly reason: string | null;
  readonly indexedAt: string | null;
  readonly indexedConverterRevision: string | null;
  readonly truncated: boolean;
}

export interface FileKnowledgeRequest {
  readonly businessId: string;
  readonly fileId: string;
  readonly versionId: string;
  readonly ownerPrincipalId: string;
  readonly requestId?: string;
  readonly legacyJobId?: string;
}

export interface FileKnowledgeClaim extends FileKnowledgeRequest {
  readonly requestId: string;
  readonly attempt: number;
}

export const FILE_KNOWLEDGE_REQUEST_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS file_knowledge_requests (
    business_id text NOT NULL,
    file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    version_id uuid NOT NULL REFERENCES file_versions(id) ON DELETE CASCADE,
    request_id uuid NOT NULL UNIQUE,
    owner_principal_id text NOT NULL,
    converter_revision text NOT NULL,
    status text NOT NULL CHECK (status IN ('queued','processing','succeeded','refused','failed')),
    attempt integer NOT NULL DEFAULT 0,
    requested_at timestamptz(3) NOT NULL DEFAULT now(),
    completed_at timestamptz(3),
    reason text,
    indexed_at timestamptz(3),
    indexed_converter_revision text,
    truncated boolean NOT NULL DEFAULT false,
    PRIMARY KEY (file_id, version_id)
  )`,
] as const;

interface ReceiptRow {
  request_id: string;
  file_id: string;
  version_id: string;
  converter_revision: string;
  status: FileKnowledgeStatus;
  requested_at: Date | string;
  completed_at: Date | string | null;
  reason: string | null;
  indexed_at: Date | string | null;
  indexed_converter_revision: string | null;
  truncated: boolean;
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function receipt(row: ReceiptRow): FileKnowledgeReceipt {
  return {
    requestId: row.request_id,
    fileId: row.file_id,
    versionId: row.version_id,
    converterRevision: row.converter_revision,
    status: row.status,
    requestedAt: new Date(row.requested_at).toISOString(),
    completedAt: iso(row.completed_at),
    reason: row.reason,
    indexedAt: iso(row.indexed_at),
    indexedConverterRevision: row.indexed_converter_revision,
    truncated: row.truncated,
  };
}

/** Request creation and queue insertion share a transaction; publication fences on the same File. */
export class FileKnowledgeIndexRepo {
  constructor(private readonly db: Queryable) {}

  async current(
    businessId: string,
    fileIds: readonly string[]
  ): Promise<ReadonlyMap<string, FileKnowledgeReceipt>> {
    if (fileIds.length === 0) return new Map();
    const result = await this.db.query<ReceiptRow>(
      `SELECT r.* FROM file_knowledge_requests r
       JOIN files f ON f.id = r.file_id AND f.current_version_id = r.version_id
       WHERE f.business_id = $1 AND f.id = ANY($2::uuid[])`,
      [businessId, fileIds]
    );
    return new Map(result.rows.map((row) => [row.file_id, receipt(row)]));
  }

  async request(
    request: FileKnowledgeRequest,
    enqueue: (tx: Queryable, receipt: FileKnowledgeReceipt) => Promise<void>
  ): Promise<FileKnowledgeReceipt> {
    return withTransaction(this.db, async (tx) => {
      if (!(await this.lockCurrent(tx, request))) {
        throw new FileError("conflict", "The File changed. Reload it before adding to Knowledge.");
      }
      const existing = await tx.query<ReceiptRow>(
        `SELECT * FROM file_knowledge_requests
         WHERE business_id = $1 AND file_id = $2 AND version_id = $3`,
        [request.businessId, request.fileId, request.versionId]
      );
      const previous = existing.rows[0];
      if (previous?.status === "queued" || previous?.status === "processing") {
        return receipt(previous);
      }
      const result = await tx.query<ReceiptRow>(
        `INSERT INTO file_knowledge_requests
          (business_id, file_id, version_id, request_id, owner_principal_id, converter_revision, status)
         VALUES ($1,$2,$3,$4,$5,$6,'queued')
         ON CONFLICT (file_id, version_id) DO UPDATE SET
           request_id = EXCLUDED.request_id, owner_principal_id = EXCLUDED.owner_principal_id,
           converter_revision = EXCLUDED.converter_revision, status = 'queued',
           attempt = 0, requested_at = now(), completed_at = NULL, reason = NULL
         RETURNING *`,
        [
          request.businessId,
          request.fileId,
          request.versionId,
          randomUUID(),
          request.ownerPrincipalId,
          FILE_CONVERTER_REVISION,
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error("File Knowledge request was not persisted");
      const created = receipt(row);
      await enqueue(tx, created);
      return created;
    });
  }

  async claim(request: FileKnowledgeRequest): Promise<FileKnowledgeClaim | null> {
    return withTransaction(this.db, async (tx) => {
      if (!(await this.lockCurrent(tx, request))) return null;
      let requestId = request.requestId;
      if (!requestId) {
        /** Pre-upgrade jobs may adopt a receipt only when no newer request exists. */
        const adopted = await tx.query<{ request_id: string }>(
          `INSERT INTO file_knowledge_requests
            (business_id,file_id,version_id,request_id,owner_principal_id,converter_revision,status)
           VALUES ($1,$2,$3,$4,$5,$6,'queued')
           ON CONFLICT (file_id,version_id) DO NOTHING RETURNING request_id`,
          [
            request.businessId,
            request.fileId,
            request.versionId,
            request.legacyJobId ?? randomUUID(),
            request.ownerPrincipalId,
            FILE_CONVERTER_REVISION,
          ]
        );
        requestId = adopted.rows[0]?.request_id ?? request.legacyJobId;
        if (!requestId) return null;
      }
      const result = await tx.query<{ request_id: string; attempt: number }>(
        `UPDATE file_knowledge_requests SET status = 'processing', attempt = attempt + 1, reason = NULL
         WHERE business_id = $1 AND file_id = $2 AND version_id = $3
           AND owner_principal_id = $4 AND status IN ('queued','processing')
           AND request_id = $5
         RETURNING request_id, attempt`,
        [request.businessId, request.fileId, request.versionId, request.ownerPrincipalId, requestId]
      );
      const row = result.rows[0];
      return row ? { ...request, requestId: row.request_id, attempt: row.attempt } : null;
    });
  }

  async publish<T extends { pageId: string; truncated: boolean }>(
    claim: FileKnowledgeClaim,
    publish: (tx: Queryable) => Promise<T>
  ): Promise<T | null> {
    return withTransaction(this.db, async (tx) => {
      if (!(await this.lockClaim(tx, claim))) return null;
      const result = await publish(tx);
      await tx.query(
        `UPDATE file_knowledge_requests
         SET status = 'succeeded', completed_at = now(), reason = NULL,
             indexed_at = now(), indexed_converter_revision = converter_revision, truncated = $3
         WHERE request_id = $1 AND attempt = $2`,
        [claim.requestId, claim.attempt, result.truncated]
      );
      return result;
    });
  }

  async settle(
    claim: FileKnowledgeClaim,
    status: "queued" | "refused" | "failed",
    reason: string
  ): Promise<void> {
    await withTransaction(this.db, async (tx) => {
      if (!(await this.lockClaim(tx, claim))) return;
      await tx.query(
        `UPDATE file_knowledge_requests
         SET status = $3, reason = $4,
             completed_at = CASE WHEN $3 = 'queued' THEN NULL ELSE now() END
         WHERE request_id = $1 AND attempt = $2`,
        [claim.requestId, claim.attempt, status, reason]
      );
    });
  }

  async settleExhausted(businessId: string, receipt: FileKnowledgeReceipt): Promise<void> {
    await withTransaction(this.db, async (tx) => {
      const current = await tx.query(
        `SELECT id FROM files WHERE business_id = $1 AND id = $2 AND current_version_id = $3 FOR UPDATE`,
        [businessId, receipt.fileId, receipt.versionId]
      );
      if (current.rows.length === 0) return;
      await tx.query(
        `UPDATE file_knowledge_requests SET status = 'failed', reason = 'index_failed', completed_at = now()
         WHERE request_id = $1 AND status IN ('queued','processing')`,
        [receipt.requestId]
      );
    });
  }

  private async lockCurrent(tx: Queryable, request: FileKnowledgeRequest): Promise<boolean> {
    const result = await tx.query(
      `SELECT id FROM files WHERE business_id = $1 AND id = $2 AND current_version_id = $3
       AND archived_at IS NULL AND knowledge_requested_at IS NOT NULL FOR UPDATE`,
      [request.businessId, request.fileId, request.versionId]
    );
    return result.rows.length === 1;
  }

  private async lockClaim(tx: Queryable, claim: FileKnowledgeClaim): Promise<boolean> {
    if (!(await this.lockCurrent(tx, claim))) return false;
    const result = await tx.query(
      `SELECT request_id FROM file_knowledge_requests
       WHERE request_id = $1 AND attempt = $2 AND status = 'processing' FOR UPDATE`,
      [claim.requestId, claim.attempt]
    );
    return result.rows.length === 1;
  }
}
