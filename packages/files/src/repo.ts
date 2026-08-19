/**
 * The File entity and its table.
 *
 * A File is business-scoped and owned by a Principal, not by a Conversation and not by a User.
 * Conversations reference Files; they do not contain them. That is what makes the library,
 * re-attachment and sharing possible without a File having to be copied.
 *
 * There is no `pending` status and no soft delete. A row exists only once its bytes have landed,
 * so there is no half-uploaded state for a sweeper to clean up later, and deletion removes both
 * the row and the bytes, so every read path has a genuine missing-File branch.
 */

import type { BlobRef, Queryable } from "@tulipfarm/storage";

export interface FileRecord {
  readonly id: string;
  readonly businessId: string;
  /** The Principal that owns this File. A Routine's output is owned by the business principal. */
  readonly ownerPrincipalId: string;
  readonly filename: string;
  /** The type resolved from the object's magic bytes. The only one safe to serve back. */
  readonly mediaType: string;
  /** What the client said it was. Kept because a disagreement with `mediaType` is a signal. */
  readonly claimedMediaType: string;
  readonly sizeBytes: number;
  readonly blob: BlobRef;
  /** Whether a person uploaded this File or an Agent produced it. */
  readonly origin: FileOrigin;
  /**
   * The Conversation this File was first sent in, if it has ever been sent in one.
   *
   * A File is uploaded before any Chat is chosen, so this is null at creation and set once, by the
   * first message that carries it. First rather than latest because the question it answers is
   * "where did this come from", which re-attaching it elsewhere does not change.
   */
  readonly sourceConversationId: string | null;
  readonly createdAt: Date;
}

/** Who made a File. Nothing produces `generated` until Agents can create Files. */
export const FILE_ORIGINS = ["uploaded", "generated"] as const;
export type FileOrigin = (typeof FILE_ORIGINS)[number];

export interface NewFile {
  readonly id: string;
  readonly businessId: string;
  readonly ownerPrincipalId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly claimedMediaType: string;
  readonly sizeBytes: number;
  readonly blob: BlobRef;
  readonly origin?: FileOrigin;
}

export interface FileRepo {
  create(file: NewFile): Promise<FileRecord>;
  get(businessId: string, id: string): Promise<FileRecord | null>;
  listByOwner(
    businessId: string,
    ownerPrincipalId: string,
    limit: number,
    after?: FileCursor
  ): Promise<FileRecord[]>;
  /**
   * Record the Conversation a File was first sent in, leaving an already-recorded one alone.
   *
   * Idempotent by design: a retried send, or the same File attached to a second Chat, must not
   * rewrite where it came from.
   */
  recordFirstConversation(
    businessId: string,
    fileIds: readonly string[],
    conversationId: string
  ): Promise<void>;
  delete(businessId: string, id: string): Promise<boolean>;
  /**
   * Whether any File anywhere still points at these bytes.
   *
   * The blob store is content-addressed, so two uploads of identical bytes share one object. Any
   * caller about to delete that object has to ask this first, or refusing one upload would delete
   * the bytes out from under an accepted File that happened to be byte-identical. Deliberately
   * not business-scoped, because the store is not either.
   */
  anyReferencesBlob(hash: string): Promise<boolean>;
}

export const FILE_STORAGE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS files (
     id                  uuid PRIMARY KEY,
     business_id         text NOT NULL,
     owner_principal_id  text NOT NULL,
     filename            text NOT NULL,
     media_type          text NOT NULL,
     claimed_media_type  text NOT NULL,
     size_bytes          bigint NOT NULL,
     blob_key            text NOT NULL,
     blob_hash           text NOT NULL,
     created_at          timestamptz(3) NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS files_owner
     ON files (business_id, owner_principal_id, created_at DESC)`,
  // Content-addressed storage means two Files can share one object, so every delete has to ask
  // whether it is the last reference before removing the bytes.
  `CREATE INDEX IF NOT EXISTS files_blob_hash ON files (blob_hash)`,
];

/** Added after the table shipped: where a File came from, for the library to show. */
export const FILE_ORIGIN_STATEMENTS = [
  // Keyset paging resumes from `(created_at, id)`, and a cursor carries `created_at` as a JS Date,
  // which has no microseconds. Storing more precision than the cursor can express would silently
  // skip rows at a page boundary, so the column is narrowed to what round-trips exactly.
  `ALTER TABLE files ALTER COLUMN created_at TYPE timestamptz(3)`,
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'uploaded'`,
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS source_conversation_id uuid`,
  `ALTER TABLE files DROP CONSTRAINT IF EXISTS files_origin_known`,
  `ALTER TABLE files ADD CONSTRAINT files_origin_known
     CHECK (origin IN (${FILE_ORIGINS.map((o) => `'${o}'`).join(", ")}))`,
];

function toRecord(row: Record<string, unknown>): FileRecord {
  return {
    id: String(row.id),
    businessId: String(row.business_id),
    ownerPrincipalId: String(row.owner_principal_id),
    filename: String(row.filename),
    mediaType: String(row.media_type),
    claimedMediaType: String(row.claimed_media_type),
    sizeBytes: Number(row.size_bytes),
    blob: { key: String(row.blob_key), hash: String(row.blob_hash) },
    origin: row.origin === "generated" ? "generated" : "uploaded",
    sourceConversationId:
      row.source_conversation_id == null ? null : String(row.source_conversation_id),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
  };
}

/** Where a page of Files resumes: the sort key of the last row already returned. */
export interface FileCursor {
  readonly createdAt: string;
  readonly id: string;
}
/**
 * The opaque cursor that resumes a listing after `file`.
 *
 * Opaque because it is a sort key, not an identifier: encoding it keeps a client from constructing
 * one by hand and depending on a sort order we would then be unable to change.
 */
export function encodeFileCursor(file: FileRecord): string {
  return Buffer.from(`${file.createdAt.toISOString()}|${file.id}`, "utf8").toString("base64url");
}

/** The cursor `raw` encodes, or `null` if it is not one this instance issued. */
export function decodeFileCursor(raw: string): FileCursor | null {
  const [createdAt, id, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (createdAt === undefined || id === undefined || rest.length > 0) return null;
  if (Number.isNaN(Date.parse(createdAt)) || id.length === 0) return null;
  return { createdAt, id };
}

export class PgFileRepo implements FileRepo {
  constructor(private readonly db: Queryable) {}

  async create(file: NewFile): Promise<FileRecord> {
    const result = await this.db.query(
      `INSERT INTO files
         (id, business_id, owner_principal_id, filename, media_type, claimed_media_type,
          size_bytes, blob_key, blob_hash, origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        file.id,
        file.businessId,
        file.ownerPrincipalId,
        file.filename,
        file.mediaType,
        file.claimedMediaType,
        file.sizeBytes,
        file.blob.key,
        file.blob.hash,
        file.origin ?? "uploaded",
      ]
    );
    return toRecord(result.rows[0] as Record<string, unknown>);
  }

  async get(businessId: string, id: string): Promise<FileRecord | null> {
    const result = await this.db.query("SELECT * FROM files WHERE business_id = $1 AND id = $2", [
      businessId,
      id,
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? null : toRecord(row);
  }

  async listByOwner(
    businessId: string,
    ownerPrincipalId: string,
    limit: number,
    after?: FileCursor
  ): Promise<FileRecord[]> {
    // Keyset, not OFFSET: a File uploaded while someone is paging would shift every later row and
    // duplicate one across pages. `(created_at, id)` is the sort, so it is also the key.
    const result = await this.db.query(
      `SELECT * FROM files
       WHERE business_id = $1 AND owner_principal_id = $2
         AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [businessId, ownerPrincipalId, limit, after?.createdAt ?? null, after?.id ?? null]
    );
    return (result.rows as Array<Record<string, unknown>>).map(toRecord);
  }

  async recordFirstConversation(
    businessId: string,
    fileIds: readonly string[],
    conversationId: string
  ): Promise<void> {
    if (fileIds.length === 0) return;
    await this.db.query(
      `UPDATE files SET source_conversation_id = $3
       WHERE business_id = $1 AND id = ANY($2::uuid[]) AND source_conversation_id IS NULL`,
      [businessId, [...fileIds], conversationId]
    );
  }

  async anyReferencesBlob(hash: string): Promise<boolean> {
    const result = await this.db.query("SELECT 1 FROM files WHERE blob_hash = $1 LIMIT 1", [hash]);
    return result.rows.length > 0;
  }

  async delete(businessId: string, id: string): Promise<boolean> {
    const result = await this.db.query(
      "DELETE FROM files WHERE business_id = $1 AND id = $2 RETURNING id",
      [businessId, id]
    );
    return result.rows.length > 0;
  }
}
