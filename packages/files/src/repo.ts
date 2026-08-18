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
  readonly createdAt: Date;
}

export interface NewFile {
  readonly id: string;
  readonly businessId: string;
  readonly ownerPrincipalId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly claimedMediaType: string;
  readonly sizeBytes: number;
  readonly blob: BlobRef;
}

export interface FileRepo {
  create(file: NewFile): Promise<FileRecord>;
  get(businessId: string, id: string): Promise<FileRecord | null>;
  listByOwner(businessId: string, ownerPrincipalId: string, limit: number): Promise<FileRecord[]>;
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
     created_at          timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS files_owner
     ON files (business_id, owner_principal_id, created_at DESC)`,
  // Content-addressed storage means two Files can share one object, so every delete has to ask
  // whether it is the last reference before removing the bytes.
  `CREATE INDEX IF NOT EXISTS files_blob_hash ON files (blob_hash)`,
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
    createdAt: new Date(String(row.created_at)),
  };
}

export class PgFileRepo implements FileRepo {
  constructor(private readonly db: Queryable) {}

  async create(file: NewFile): Promise<FileRecord> {
    const result = await this.db.query(
      `INSERT INTO files
         (id, business_id, owner_principal_id, filename, media_type, claimed_media_type,
          size_bytes, blob_key, blob_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
    limit: number
  ): Promise<FileRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM files
       WHERE business_id = $1 AND owner_principal_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [businessId, ownerPrincipalId, limit]
    );
    return (result.rows as Array<Record<string, unknown>>).map(toRecord);
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
