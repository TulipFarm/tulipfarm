/**
 * The File entity and its table.
 *
 * A File is business-scoped and owned by a Principal, not by a Conversation and not by a User.
 * Conversations reference Files; they do not contain them. That is what makes the library,
 * re-attachment and sharing possible without a File having to be copied.
 *
 * There is no `pending` upload status. A row exists only once its bytes have landed, so there is no
 * half-uploaded state for a sweeper to clean up later. Archive is reversible lifecycle state;
 * permanent deletion removes the aggregate and durably queues its version blobs for cleanup.
 */

import { type BlobRef, type Queryable, withTransaction } from "@tulipfarm/storage";
import { BUSINESS_PRINCIPAL_ID } from "./limits";

export interface FileRecord {
  readonly id: string;
  readonly businessId: string;
  /** The Principal that owns this File. A Routine's output is owned by the business principal. */
  readonly ownerPrincipalId: string;
  readonly folderId: string | null;
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
  /**
   * The Run that produced this File, for a File an Agent authored.
   *
   * Always null for an upload: a person attaching a document is not a Run, and inventing one would
   * make "where did this come from" answer with machinery the person never saw. Set at creation
   * and never changed — unlike the Conversation, a generated File has exactly one author.
   */
  readonly sourceRunId: string | null;
  /** The stable Tool occurrence that created this File, used only to make retries idempotent. */
  readonly sourceToolCallId: string | null;
  /**
   * When the owner last asked for this File to be in Knowledge, or null if they have not.
   *
   * The durable half of the opt-in. Indexing happens on a queue, so "is this File in Knowledge"
   * cannot be answered by whether a Page exists yet — between the request and the Page there is a
   * window in which a removal would find nothing to remove and silently succeed, and the job would
   * then index the File anyway. This column is what both sides check instead.
   */
  readonly knowledgeRequestedAt: Date | null;
  readonly currentVersionId: string;
  readonly revision: number;
  readonly modifiedAt: Date;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
}

/** Who made a File. Nothing produces `generated` until Agents can create Files. */
export const FILE_ORIGINS = ["uploaded", "generated"] as const;
export type FileOrigin = (typeof FILE_ORIGINS)[number];

export interface NewFile {
  readonly id: string;
  readonly businessId: string;
  readonly ownerPrincipalId: string;
  readonly folderId?: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly claimedMediaType: string;
  readonly sizeBytes: number;
  readonly blob: BlobRef;
  readonly origin?: FileOrigin;
  /** The Run that authored this File. Only a generated File has one. */
  readonly sourceRunId?: string;
  /** The Tool occurrence that authored this File. Only a generated File has one. */
  readonly sourceToolCallId?: string;
  readonly versionActorKind?: FileVersionActorKind;
  readonly versionActorId?: string;
}

export interface FileDraftRecord {
  readonly id: string;
  readonly businessId: string;
  readonly creatorPrincipalId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly blob: BlobRef;
  readonly authoredByAgentId: string | null;
  readonly sourceRunId: string;
  readonly sourceToolCallId: string;
  readonly savedFileId: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface NewFileDraft {
  readonly id: string;
  readonly businessId: string;
  readonly creatorPrincipalId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly blob: BlobRef;
  readonly authoredByAgentId?: string;
  readonly sourceRunId: string;
  readonly sourceToolCallId: string;
  readonly expiresAt: Date;
}

export interface NewFileVersion {
  readonly id: string;
  readonly businessId: string;
  readonly fileId: string;
  readonly expectedRevision: number;
  readonly mediaType: string;
  readonly claimedMediaType: string;
  readonly sizeBytes: number;
  readonly blob: BlobRef;
  readonly actorKind: FileVersionActorKind;
  readonly actorId: string;
  readonly reason: "replaced";
}

export interface RestoreFileVersion {
  readonly id: string;
  readonly businessId: string;
  readonly fileId: string;
  readonly versionId: string;
  readonly expectedRevision: number;
  readonly actorKind: FileVersionActorKind;
  readonly actorId: string;
}

export interface ClaimedFileBlobCleanup {
  readonly blob: BlobRef;
  readonly attempts: number;
}

export const FILE_VERSION_ACTOR_KINDS = ["principal", "agent", "routine", "system"] as const;
export type FileVersionActorKind = (typeof FILE_VERSION_ACTOR_KINDS)[number];

export const FILE_VERSION_REASONS = ["created", "replaced", "restored"] as const;
export type FileVersionReason = (typeof FILE_VERSION_REASONS)[number];

export interface FileVersionRecord {
  readonly id: string;
  readonly businessId: string;
  readonly fileId: string;
  readonly versionNumber: number;
  readonly mediaType: string;
  readonly claimedMediaType: string;
  readonly sizeBytes: number;
  readonly blob: BlobRef;
  readonly actorKind: FileVersionActorKind;
  readonly actorId: string;
  readonly reason: FileVersionReason;
  readonly sourceConversationId: string | null;
  readonly sourceRunId: string | null;
  readonly restoredFromVersionId: string | null;
  readonly createdAt: Date;
}

/**
 * Who a File is shared with.
 *
 * A grantee is a Principal *or* a Role, never an expanded list of Role members. Expanding a Role at
 * share time would go stale in the direction that matters: someone removed from the Role would keep
 * the File. Resolving the reader's Roles on every read is what makes revocation immediate.
 */
export const FILE_GRANTEE_KINDS = ["user", "role"] as const;
export type FileGranteeKind = (typeof FILE_GRANTEE_KINDS)[number];

export interface FileGrantee {
  readonly kind: FileGranteeKind;
  readonly id: string;
}

export type FileReader = FileGrantee | { readonly kind: "team"; readonly id: string };

export interface FileShare extends FileGrantee {
  readonly fileId: string;
  /** The Principal that granted this share. Only a File's owner ever can. */
  readonly grantedBy: string;
  readonly createdAt: Date;
}

export interface FileFolderRecord {
  readonly id: string;
  readonly businessId: string;
  readonly ownerPrincipalId: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly createdAt: Date;
  readonly modifiedAt: Date;
}

export interface NewFileFolder {
  readonly id: string;
  readonly businessId: string;
  readonly ownerPrincipalId: string;
  readonly parentId?: string;
  readonly name: string;
}

export interface FileRepo {
  withBlobLock<T>(hash: string, task: (repo: FileRepo) => Promise<T>): Promise<T>;
  create(file: NewFile): Promise<FileRecord>;
  createGenerated(file: NewFile): Promise<{ file: FileRecord; created: boolean }>;
  createDraft(draft: NewFileDraft): Promise<{ draft: FileDraftRecord; created: boolean }>;
  getDraft(
    businessId: string,
    id: string,
    creatorPrincipalId: string
  ): Promise<FileDraftRecord | null>;
  saveDraft(
    businessId: string,
    id: string,
    creatorPrincipalId: string,
    fileId: string
  ): Promise<FileRecord | null>;
  expireDrafts(limit: number): Promise<number>;
  get(businessId: string, id: string): Promise<FileRecord | null>;
  getMany(businessId: string, ids: readonly string[]): Promise<FileRecord[]>;
  createFolder(folder: NewFileFolder): Promise<FileFolderRecord | null>;
  getFolder(businessId: string, id: string): Promise<FileFolderRecord | null>;
  listFolders(businessId: string, ownerPrincipalId: string): Promise<FileFolderRecord[]>;
  renameFolder(
    businessId: string,
    id: string,
    ownerPrincipalId: string,
    name: string
  ): Promise<FileFolderRecord | null>;
  /** Removes an empty folder. Resolves false when it still holds a File or a child folder. */
  deleteFolder(businessId: string, id: string, ownerPrincipalId: string): Promise<boolean>;
  moveFile(
    businessId: string,
    id: string,
    ownerPrincipalId: string,
    folderId: string | null,
    expectedRevision: number
  ): Promise<FileRecord | null>;
  listByOwner(
    businessId: string,
    ownerPrincipalId: string,
    limit: number,
    after?: FileCursor
  ): Promise<FileRecord[]>;
  listArchivedByOwner(
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
  replaceVersion(version: NewFileVersion): Promise<FileRecord | null>;
  restoreVersion(version: RestoreFileVersion): Promise<FileRecord | null>;
  setArchived(
    businessId: string,
    id: string,
    expectedRevision: number,
    archived: boolean
  ): Promise<FileRecord | null>;
  deleteArchived(
    businessId: string,
    id: string,
    expectedRevision: number
  ): Promise<FileRecord | null>;
  /**
   * Records, or withdraws, the owner's standing request that this File be in Knowledge.
   *
   * Written before the job is enqueued and cleared before a Page is removed, so that the worker
   * has something to re-read that outlives the queue message.
   */
  setKnowledgeRequested(businessId: string, id: string, at: Date | null): Promise<void>;
  /**
   * Which of `ids` this Principal may currently read, as owner or as a share recipient.
   *
   * The batched form of the same question `read` asks one File at a time. A transcript can name a
   * dozen Files, and asking per attachment would make rendering an old Chat cost a query per
   * image — so this exists to keep "is this File still there for me" affordable enough that every
   * render can ask it rather than assuming.
   *
   * `teamReadableIds` carries the Team half of that answer, already decided elsewhere: this table
   * knows nothing about Teams, so a File a Team owns would otherwise be one its members can open
   * by link and never see rendered in a transcript.
   */
  readableIds(
    businessId: string,
    principalId: string,
    grantees: readonly FileGrantee[],
    ids: readonly string[],
    teamReadableIds?: readonly string[]
  ): Promise<readonly string[]>;
  /**
   * Whether any File anywhere still points at these bytes.
   *
   * The blob store is content-addressed, so two uploads of identical bytes share one object. Any
   * caller about to delete that object has to ask this first, or refusing one upload would delete
   * the bytes out from under an accepted File that happened to be byte-identical. Deliberately
   * not business-scoped, because the store is not either.
   */
  anyReferencesBlob(hash: string): Promise<boolean>;

  /** Idempotent: sharing the same File with the same grantee twice is one share. */
  share(businessId: string, fileId: string, grantee: FileGrantee, grantedBy: string): Promise<void>;
  /** Returns whether a share existed, so a route can tell a revocation from a no-op. */
  unshare(businessId: string, fileId: string, grantee: FileGrantee): Promise<boolean>;
  listShares(businessId: string, fileId: string): Promise<FileShare[]>;
  /**
   * How many grants each of `fileIds` carries, keyed by File id and omitting the unshared.
   *
   * One aggregate rather than a `listShares` per row: the library shows this on every row it
   * paints, and a per-row query would make the listing cost scale with the page size.
   */
  countShares(businessId: string, fileIds: readonly string[]): Promise<Map<string, number>>;
  /**
   * The Files shared with any of `grantees`, newest first. Excludes Files the caller owns, which
   * `listByOwner` already returns.
   *
   * `teamReadableIds` widens the same page with the Files a Team reaches, so "Shared with me" is
   * the one place a member looks for anything they did not upload themselves.
   */
  listSharedWith(
    businessId: string,
    ownerPrincipalId: string,
    grantees: readonly FileGrantee[],
    limit: number,
    after?: FileCursor,
    teamReadableIds?: readonly string[]
  ): Promise<FileRecord[]>;
  /** Readable Files whose filename contains `query`, newest first. */
  searchReadable(
    businessId: string,
    principalId: string,
    grantees: readonly FileGrantee[],
    query: string,
    limit: number,
    teamReadableIds?: readonly string[]
  ): Promise<FileRecord[]>;
  getVersion(
    businessId: string,
    fileId: string,
    versionId: string
  ): Promise<FileVersionRecord | null>;
  listVersions(businessId: string, fileId: string): Promise<FileVersionRecord[]>;
  claimBlobCleanup(
    owner: string,
    limit: number,
    leaseMs: number
  ): Promise<readonly ClaimedFileBlobCleanup[]>;
  completeBlobCleanup(blob: BlobRef, owner: string): Promise<void>;
  retryBlobCleanup(blob: BlobRef, owner: string, error: string): Promise<void>;
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

export const FILE_FOLDER_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS file_folders (
     id                  uuid PRIMARY KEY,
     business_id         text NOT NULL,
     owner_principal_id  text NOT NULL,
     parent_id           uuid REFERENCES file_folders (id) ON DELETE RESTRICT,
     name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
     created_at          timestamptz(3) NOT NULL DEFAULT now(),
     modified_at         timestamptz(3) NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS file_folders_sibling_name
     ON file_folders (
       business_id,
       owner_principal_id,
       COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
       lower(name)
     )`,
  `CREATE INDEX IF NOT EXISTS file_folders_parent
     ON file_folders (business_id, owner_principal_id, parent_id, name)`,
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS folder_id uuid
     REFERENCES file_folders (id) ON DELETE SET NULL`,
  `CREATE INDEX IF NOT EXISTS files_folder
     ON files (business_id, owner_principal_id, folder_id, created_at DESC)`,
] as const;

/** Added after the table shipped: where a File came from, for the library to show. */
export const FILE_ORIGIN_STATEMENTS = [
  // Keyset paging resumes from `(created_at, id)`, and a cursor carries `created_at` as a JS Date,
  // which has no microseconds. Storing more precision than the cursor can express would silently
  // skip rows at a page boundary, so the column is narrowed to what round-trips exactly.
  `ALTER TABLE files ALTER COLUMN created_at TYPE timestamptz(3)`,
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'uploaded'`,
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS source_conversation_id uuid`,
  // Not a foreign key: a File outlives the Run that wrote it, and a retention sweep over `runs`
  // must not take the library's provenance with it. A dangling id reads as "made by a Run that is
  // no longer here", which is true and useful; a cascade would read as "nobody made this".
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS source_run_id uuid`,
  `ALTER TABLE files DROP CONSTRAINT IF EXISTS files_origin_known`,
  `ALTER TABLE files ADD CONSTRAINT files_origin_known
     CHECK (origin IN (${FILE_ORIGINS.map((o) => `'${o}'`).join(", ")}))`,
];

/** Added with Files-into-Knowledge: the durable opt-in a queued index job can re-read. */
export const FILE_KNOWLEDGE_STATEMENTS = [
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS knowledge_requested_at timestamptz(3)`,
];

/** Added with sharing: a File is private to its owner until a row here says otherwise. */
export const FILE_SHARE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS file_shares (
     business_id   text NOT NULL,
     file_id       uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE,
     grantee_kind  text NOT NULL CHECK (grantee_kind IN (${FILE_GRANTEE_KINDS.map((k) => `'${k}'`).join(", ")})),
     grantee_id    text NOT NULL,
     granted_by    text NOT NULL,
     created_at    timestamptz(3) NOT NULL DEFAULT now(),
     PRIMARY KEY (file_id, grantee_kind, grantee_id)
   )`,
  // Every authorized read of a File the caller does not own hits this, keyed by the reader's
  // identities rather than by the File.
  `CREATE INDEX IF NOT EXISTS file_shares_grantee
     ON file_shares (business_id, grantee_kind, grantee_id)`,
];

/** Stable File lifecycle columns and immutable content history. */
export const FILE_VERSION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS file_versions (
     id                         uuid PRIMARY KEY,
     business_id                text NOT NULL,
     file_id                    uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE,
     version_number             integer NOT NULL CHECK (version_number > 0),
     media_type                 text NOT NULL,
     claimed_media_type         text NOT NULL,
     size_bytes                 bigint NOT NULL,
     blob_key                   text NOT NULL,
     blob_hash                  text NOT NULL,
     actor_kind                 text NOT NULL CHECK (actor_kind IN (${FILE_VERSION_ACTOR_KINDS.map((kind) => `'${kind}'`).join(", ")})),
     actor_id                   text NOT NULL,
     reason                     text NOT NULL CHECK (reason IN (${FILE_VERSION_REASONS.map((reason) => `'${reason}'`).join(", ")})),
     source_conversation_id     uuid,
     source_run_id              uuid,
     restored_from_version_id   uuid REFERENCES file_versions (id),
     created_at                 timestamptz(3) NOT NULL DEFAULT now(),
     UNIQUE (file_id, version_number)
   )`,
  `INSERT INTO file_versions
     (id, business_id, file_id, version_number, media_type, claimed_media_type, size_bytes,
      blob_key, blob_hash, actor_kind, actor_id, reason, source_conversation_id, source_run_id,
      created_at)
   SELECT id, business_id, id, 1, media_type, claimed_media_type, size_bytes, blob_key, blob_hash,
     CASE WHEN origin = 'generated' THEN 'system' ELSE 'principal' END,
     CASE WHEN origin = 'generated' THEN 'business' ELSE owner_principal_id END,
     'created', source_conversation_id, source_run_id, created_at
   FROM files
   ON CONFLICT (id) DO NOTHING`,
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS current_version_id uuid`,
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1`,
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS modified_at timestamptz(3)`,
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS archived_at timestamptz(3)`,
  `UPDATE files
   SET current_version_id = id,
       modified_at = created_at
   WHERE current_version_id IS NULL OR modified_at IS NULL`,
  `ALTER TABLE files ALTER COLUMN current_version_id SET NOT NULL`,
  `ALTER TABLE files ALTER COLUMN modified_at SET NOT NULL`,
  `DO $file_version_fk$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'files_current_version_fk'
     ) THEN
       ALTER TABLE files ADD CONSTRAINT files_current_version_fk
          FOREIGN KEY (current_version_id) REFERENCES file_versions (id)
          DEFERRABLE INITIALLY DEFERRED;
     END IF;
   END $file_version_fk$`,
  `CREATE INDEX IF NOT EXISTS file_versions_file
     ON file_versions (business_id, file_id, version_number DESC)`,
  `CREATE INDEX IF NOT EXISTS file_versions_blob_hash ON file_versions (blob_hash)`,
  `CREATE TABLE IF NOT EXISTS file_blob_cleanup (
     blob_key         text NOT NULL,
     blob_hash        text NOT NULL,
     attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
     next_attempt_at  timestamptz NOT NULL DEFAULT now(),
     lease_owner      text,
     lease_until      timestamptz,
     last_error       text,
     created_at       timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (blob_key, blob_hash),
     CHECK (
        (lease_owner IS NULL AND lease_until IS NULL)
        OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS file_blob_cleanup_claim
     ON file_blob_cleanup (next_attempt_at, created_at)
     WHERE lease_owner IS NULL`,
] as const;

/** Temporary generated outputs and the stable Tool occurrence used to deduplicate them. */
export const FILE_DRAFT_STATEMENTS = [
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS source_tool_call_id text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS files_generated_tool_call
     ON files (business_id, source_run_id, source_tool_call_id)
     WHERE source_run_id IS NOT NULL AND source_tool_call_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS file_generation_drafts (
     id                     uuid PRIMARY KEY,
     business_id            text NOT NULL,
     creator_principal_id   text NOT NULL,
     filename               text NOT NULL,
     media_type             text NOT NULL,
     size_bytes             bigint NOT NULL,
     blob_key               text NOT NULL,
     blob_hash              text NOT NULL,
     authored_by_agent_id   text,
     source_run_id          uuid NOT NULL,
     source_tool_call_id    text NOT NULL,
     saved_file_id          uuid REFERENCES files (id) ON DELETE CASCADE,
     saved_at               timestamptz(3),
     created_at             timestamptz(3) NOT NULL DEFAULT now(),
     expires_at             timestamptz(3) NOT NULL,
     UNIQUE (business_id, source_run_id, source_tool_call_id),
     CHECK (
       (saved_file_id IS NULL AND saved_at IS NULL)
       OR (saved_file_id IS NOT NULL AND saved_at IS NOT NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS file_generation_drafts_expiry
     ON file_generation_drafts (expires_at)
     WHERE saved_file_id IS NULL`,
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toRecord(row: Record<string, unknown>): FileRecord {
  return {
    id: String(row.id),
    businessId: String(row.business_id),
    ownerPrincipalId: String(row.owner_principal_id),
    folderId: row.folder_id == null ? null : String(row.folder_id),
    filename: String(row.filename),
    mediaType: String(row.media_type),
    claimedMediaType: String(row.claimed_media_type),
    sizeBytes: Number(row.size_bytes),
    blob: { key: String(row.blob_key), hash: String(row.blob_hash) },
    origin: row.origin === "generated" ? "generated" : "uploaded",
    sourceConversationId:
      row.source_conversation_id == null ? null : String(row.source_conversation_id),
    sourceRunId: row.source_run_id == null ? null : String(row.source_run_id),
    sourceToolCallId: row.source_tool_call_id == null ? null : String(row.source_tool_call_id),
    knowledgeRequestedAt:
      row.knowledge_requested_at == null
        ? null
        : row.knowledge_requested_at instanceof Date
          ? row.knowledge_requested_at
          : new Date(String(row.knowledge_requested_at)),
    currentVersionId: String(row.current_version_id),
    revision: Number(row.revision),
    modifiedAt:
      row.modified_at instanceof Date ? row.modified_at : new Date(String(row.modified_at)),
    archivedAt:
      row.archived_at == null
        ? null
        : row.archived_at instanceof Date
          ? row.archived_at
          : new Date(String(row.archived_at)),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
  };
}

function toFolderRecord(row: Record<string, unknown>): FileFolderRecord {
  return {
    id: String(row.id),
    businessId: String(row.business_id),
    ownerPrincipalId: String(row.owner_principal_id),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    name: String(row.name),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
    modifiedAt:
      row.modified_at instanceof Date ? row.modified_at : new Date(String(row.modified_at)),
  };
}

function toDraftRecord(row: Record<string, unknown>): FileDraftRecord {
  return {
    id: String(row.id),
    businessId: String(row.business_id),
    creatorPrincipalId: String(row.creator_principal_id),
    filename: String(row.filename),
    mediaType: String(row.media_type),
    sizeBytes: Number(row.size_bytes),
    blob: { key: String(row.blob_key), hash: String(row.blob_hash) },
    authoredByAgentId: row.authored_by_agent_id == null ? null : String(row.authored_by_agent_id),
    sourceRunId: String(row.source_run_id),
    sourceToolCallId: String(row.source_tool_call_id),
    savedFileId: row.saved_file_id == null ? null : String(row.saved_file_id),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(String(row.expires_at)),
  };
}

function toVersionRecord(row: Record<string, unknown>): FileVersionRecord {
  return {
    id: String(row.id),
    businessId: String(row.business_id),
    fileId: String(row.file_id),
    versionNumber: Number(row.version_number),
    mediaType: String(row.media_type),
    claimedMediaType: String(row.claimed_media_type),
    sizeBytes: Number(row.size_bytes),
    blob: { key: String(row.blob_key), hash: String(row.blob_hash) },
    actorKind:
      row.actor_kind === "agent" || row.actor_kind === "routine" || row.actor_kind === "system"
        ? row.actor_kind
        : "principal",
    actorId: String(row.actor_id),
    reason: row.reason === "replaced" || row.reason === "restored" ? row.reason : "created",
    sourceConversationId:
      row.source_conversation_id == null ? null : String(row.source_conversation_id),
    sourceRunId: row.source_run_id == null ? null : String(row.source_run_id),
    restoredFromVersionId:
      row.restored_from_version_id == null ? null : String(row.restored_from_version_id),
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
  constructor(
    private readonly db: Queryable,
    private readonly ambientTransaction = false
  ) {}

  private async transaction<T>(task: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.ambientTransaction ? await task(this.db) : await withTransaction(this.db, task);
  }

  async withBlobLock<T>(hash: string, task: (repo: FileRepo) => Promise<T>): Promise<T> {
    return await this.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [hash]);
      return await task(new PgFileRepo(tx, true));
    });
  }

  async create(file: NewFile): Promise<FileRecord> {
    const result = await this.db.query(
      `WITH inserted_file AS (
         INSERT INTO files
           (id, business_id, owner_principal_id, filename, media_type, claimed_media_type,
            size_bytes, blob_key, blob_hash, origin, source_run_id, source_tool_call_id,
            current_version_id, modified_at, folder_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $1, now(), $15)
         RETURNING *
       ),
       inserted_version AS (
         INSERT INTO file_versions
           (id, business_id, file_id, version_number, media_type, claimed_media_type, size_bytes,
            blob_key, blob_hash, actor_kind, actor_id, reason, source_run_id)
         SELECT id, business_id, id, 1, media_type, claimed_media_type, size_bytes, blob_key,
           blob_hash, $13, $14, 'created', source_run_id
         FROM inserted_file
         RETURNING id, file_id
       )
       SELECT inserted_file.*
       FROM inserted_file
       JOIN inserted_version ON inserted_version.file_id = inserted_file.id`,
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
        file.sourceRunId ?? null,
        file.sourceToolCallId ?? null,
        file.versionActorKind ?? "principal",
        file.versionActorId ?? file.ownerPrincipalId,
        file.folderId ?? null,
      ]
    );
    return toRecord(result.rows[0] as Record<string, unknown>);
  }

  async createGenerated(file: NewFile): Promise<{ file: FileRecord; created: boolean }> {
    const result = await this.db.query(
      `WITH inserted_file AS (
         INSERT INTO files
           (id, business_id, owner_principal_id, filename, media_type, claimed_media_type,
            size_bytes, blob_key, blob_hash, origin, source_run_id, source_tool_call_id,
            current_version_id, modified_at, folder_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'generated', $10, $11, $1, now(), $14)
         ON CONFLICT (business_id, source_run_id, source_tool_call_id)
           WHERE source_run_id IS NOT NULL AND source_tool_call_id IS NOT NULL
         DO NOTHING
         RETURNING *
       ),
       inserted_version AS (
         INSERT INTO file_versions
           (id, business_id, file_id, version_number, media_type, claimed_media_type, size_bytes,
            blob_key, blob_hash, actor_kind, actor_id, reason, source_run_id)
         SELECT id, business_id, id, 1, media_type, claimed_media_type, size_bytes, blob_key,
           blob_hash, $12, $13, 'created', source_run_id
         FROM inserted_file
         RETURNING file_id
       )
       SELECT inserted_file.*, true AS was_created
       FROM inserted_file
       JOIN inserted_version ON inserted_version.file_id = inserted_file.id
       UNION ALL
       SELECT files.*, false AS was_created
       FROM files
       WHERE business_id = $2 AND source_run_id = $10 AND source_tool_call_id = $11
         AND NOT EXISTS (SELECT 1 FROM inserted_file)
       LIMIT 1`,
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
        file.sourceRunId ?? null,
        file.sourceToolCallId ?? null,
        file.versionActorKind ?? "system",
        file.versionActorId ?? file.ownerPrincipalId,
        file.folderId ?? null,
      ]
    );
    const row =
      (result.rows[0] as Record<string, unknown> | undefined) ??
      (
        await this.db.query(
          `SELECT *, false AS was_created FROM files
           WHERE business_id = $1 AND source_run_id = $2 AND source_tool_call_id = $3`,
          [file.businessId, file.sourceRunId ?? null, file.sourceToolCallId ?? null]
        )
      ).rows[0];
    if (row === undefined) throw new Error("generated File idempotency lookup returned no row");
    return { file: toRecord(row), created: row.was_created === true };
  }

  async createDraft(draft: NewFileDraft): Promise<{ draft: FileDraftRecord; created: boolean }> {
    const result = await this.db.query(
      `WITH inserted AS (
         INSERT INTO file_generation_drafts
           (id, business_id, creator_principal_id, filename, media_type, size_bytes, blob_key,
            blob_hash, authored_by_agent_id, source_run_id, source_tool_call_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (business_id, source_run_id, source_tool_call_id) DO NOTHING
         RETURNING *
       )
       SELECT inserted.*, true AS was_created FROM inserted
       UNION ALL
       SELECT drafts.*, false AS was_created
       FROM file_generation_drafts drafts
       WHERE business_id = $2 AND source_run_id = $10 AND source_tool_call_id = $11
         AND NOT EXISTS (SELECT 1 FROM inserted)
       LIMIT 1`,
      [
        draft.id,
        draft.businessId,
        draft.creatorPrincipalId,
        draft.filename,
        draft.mediaType,
        draft.sizeBytes,
        draft.blob.key,
        draft.blob.hash,
        draft.authoredByAgentId ?? null,
        draft.sourceRunId,
        draft.sourceToolCallId,
        draft.expiresAt,
      ]
    );
    const row =
      (result.rows[0] as Record<string, unknown> | undefined) ??
      (
        await this.db.query(
          `SELECT *, false AS was_created FROM file_generation_drafts
           WHERE business_id = $1 AND source_run_id = $2 AND source_tool_call_id = $3`,
          [draft.businessId, draft.sourceRunId, draft.sourceToolCallId]
        )
      ).rows[0];
    if (row === undefined) throw new Error("File draft idempotency lookup returned no row");
    return { draft: toDraftRecord(row), created: row.was_created === true };
  }

  async getDraft(
    businessId: string,
    id: string,
    creatorPrincipalId: string
  ): Promise<FileDraftRecord | null> {
    const result = await this.db.query(
      `SELECT * FROM file_generation_drafts
       WHERE business_id = $1 AND id = $2 AND creator_principal_id = $3`,
      [businessId, id, creatorPrincipalId]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? null : toDraftRecord(row);
  }

  async saveDraft(
    businessId: string,
    id: string,
    creatorPrincipalId: string,
    fileId: string
  ): Promise<FileRecord | null> {
    return await this.transaction(async (tx) => {
      const selected = await tx.query(
        `SELECT * FROM file_generation_drafts
         WHERE business_id = $1 AND id = $2 AND creator_principal_id = $3
         FOR UPDATE`,
        [businessId, id, creatorPrincipalId]
      );
      const draft = selected.rows[0] as Record<string, unknown> | undefined;
      if (draft === undefined) return null;
      if (draft.saved_file_id != null) {
        const existing = await tx.query("SELECT * FROM files WHERE business_id = $1 AND id = $2", [
          businessId,
          draft.saved_file_id,
        ]);
        const row = existing.rows[0] as Record<string, unknown> | undefined;
        return row === undefined ? null : toRecord(row);
      }
      const expiresAt =
        draft.expires_at instanceof Date ? draft.expires_at : new Date(String(draft.expires_at));
      if (expiresAt.getTime() <= Date.now()) return null;

      const actorKind = draft.authored_by_agent_id == null ? "system" : "agent";
      const actorId = draft.authored_by_agent_id ?? BUSINESS_PRINCIPAL_ID;
      const inserted = await tx.query(
        `WITH inserted_file AS (
           INSERT INTO files
             (id, business_id, owner_principal_id, filename, media_type, claimed_media_type,
              size_bytes, blob_key, blob_hash, origin, source_run_id, source_tool_call_id,
              current_version_id, modified_at)
           VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, 'generated', $9, $10, $1, now())
           RETURNING *
         ),
         inserted_version AS (
           INSERT INTO file_versions
             (id, business_id, file_id, version_number, media_type, claimed_media_type, size_bytes,
              blob_key, blob_hash, actor_kind, actor_id, reason, source_run_id)
           SELECT id, business_id, id, 1, media_type, claimed_media_type, size_bytes, blob_key,
             blob_hash, $11, $12, 'created', source_run_id
           FROM inserted_file
           RETURNING file_id
         )
         SELECT inserted_file.*
         FROM inserted_file
         JOIN inserted_version ON inserted_version.file_id = inserted_file.id`,
        [
          fileId,
          businessId,
          // The saver, not the business. `saveDraft` also gives them personal ownership, and a
          // business-owned row contradicts it: the File would sit under "Shared with me" and hide
          // sharing, replacement, versions and deletion from the one person who owns it.
          creatorPrincipalId,
          draft.filename,
          draft.media_type,
          draft.size_bytes,
          draft.blob_key,
          draft.blob_hash,
          draft.source_run_id,
          draft.source_tool_call_id,
          actorKind,
          actorId,
        ]
      );
      await tx.query(
        `UPDATE file_generation_drafts
         SET saved_file_id = $4, saved_at = now()
         WHERE business_id = $1 AND id = $2 AND creator_principal_id = $3`,
        [businessId, id, creatorPrincipalId, fileId]
      );
      return toRecord(inserted.rows[0] as Record<string, unknown>);
    });
  }

  async expireDrafts(limit: number): Promise<number> {
    const result = await this.transaction(async (tx) =>
      tx.query(
        `WITH candidates AS (
           SELECT id, blob_key, blob_hash, saved_file_id
           FROM file_generation_drafts
           WHERE expires_at <= now() AND saved_file_id IS NULL
           ORDER BY expires_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         ),
         queued AS (
           INSERT INTO file_blob_cleanup (blob_key, blob_hash)
           SELECT blob_key, blob_hash FROM candidates
           ON CONFLICT (blob_key, blob_hash) DO NOTHING
         ),
         deleted AS (
           DELETE FROM file_generation_drafts drafts
           USING candidates
           WHERE drafts.id = candidates.id
           RETURNING drafts.id
         )
         SELECT count(*)::int AS count FROM deleted`,
        [limit]
      )
    );
    return Number((result.rows[0] as Record<string, unknown> | undefined)?.count ?? 0);
  }

  async get(businessId: string, id: string): Promise<FileRecord | null> {
    const result = await this.db.query("SELECT * FROM files WHERE business_id = $1 AND id = $2", [
      businessId,
      id,
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? null : toRecord(row);
  }

  async getMany(businessId: string, ids: readonly string[]): Promise<FileRecord[]> {
    if (ids.length === 0) return [];
    const result = await this.db.query(
      `SELECT * FROM files
       WHERE business_id = $1 AND id::text = ANY($2::text[])`,
      [businessId, [...ids]]
    );
    const byId = new Map(
      (result.rows as Array<Record<string, unknown>>).map((row) => {
        const record = toRecord(row);
        return [record.id, record] as const;
      })
    );
    return ids.flatMap((id) => {
      const record = byId.get(id);
      return record === undefined ? [] : [record];
    });
  }

  async createFolder(folder: NewFileFolder): Promise<FileFolderRecord | null> {
    const result = await this.db.query(
      `INSERT INTO file_folders (id, business_id, owner_principal_id, parent_id, name)
       SELECT $1, $2, $3, $4, $5
       WHERE $4::uuid IS NULL OR EXISTS (
         SELECT 1 FROM file_folders
         WHERE id = $4 AND business_id = $2 AND owner_principal_id = $3
       )
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [folder.id, folder.businessId, folder.ownerPrincipalId, folder.parentId ?? null, folder.name]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? null : toFolderRecord(row);
  }

  async getFolder(businessId: string, id: string): Promise<FileFolderRecord | null> {
    const result = await this.db.query(
      "SELECT * FROM file_folders WHERE business_id = $1 AND id = $2",
      [businessId, id]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? null : toFolderRecord(row);
  }

  async listFolders(businessId: string, ownerPrincipalId: string): Promise<FileFolderRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM file_folders
       WHERE business_id = $1 AND owner_principal_id = $2
       ORDER BY lower(name), id`,
      [businessId, ownerPrincipalId]
    );
    return (result.rows as Array<Record<string, unknown>>).map(toFolderRecord);
  }

  async renameFolder(
    businessId: string,
    id: string,
    ownerPrincipalId: string,
    name: string
  ): Promise<FileFolderRecord | null> {
    // ON CONFLICT cannot fire on a partial-index collision expressed this way, so the sibling
    // check rides in the WHERE clause: a name already taken next door leaves zero rows, which the
    // caller reports as a name clash rather than a missing folder.
    const result = await this.db.query(
      `UPDATE file_folders SET name = $4, modified_at = now()
       WHERE business_id = $1 AND id = $2 AND owner_principal_id = $3
         AND NOT EXISTS (
           SELECT 1 FROM file_folders sibling
           WHERE sibling.business_id = $1
             AND sibling.owner_principal_id = $3
             AND sibling.id <> $2
             AND sibling.parent_id IS NOT DISTINCT FROM file_folders.parent_id
             AND lower(sibling.name) = lower($4)
         )
       RETURNING *`,
      [businessId, id, ownerPrincipalId, name]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? null : toFolderRecord(row);
  }

  async deleteFolder(businessId: string, id: string, ownerPrincipalId: string): Promise<boolean> {
    // Emptiness is asserted inside the delete rather than read first, so a File landing between a
    // check and a delete cannot orphan itself into the root.
    const result = await this.db.query(
      `DELETE FROM file_folders
       WHERE business_id = $1 AND id = $2 AND owner_principal_id = $3
         AND NOT EXISTS (SELECT 1 FROM files WHERE folder_id = $2)
         AND NOT EXISTS (SELECT 1 FROM file_folders child WHERE child.parent_id = $2)
       RETURNING id`,
      [businessId, id, ownerPrincipalId]
    );
    return result.rows.length > 0;
  }

  async moveFile(
    businessId: string,
    id: string,
    ownerPrincipalId: string,
    folderId: string | null,
    expectedRevision: number
  ): Promise<FileRecord | null> {
    const result = await this.db.query(
      `UPDATE files
       SET folder_id = $4, revision = revision + 1, modified_at = now()
       WHERE business_id = $1 AND id = $2 AND owner_principal_id = $3
         AND revision = $5 AND archived_at IS NULL
         AND (
           $4::uuid IS NULL OR EXISTS (
             SELECT 1 FROM file_folders
             WHERE id = $4 AND business_id = $1 AND owner_principal_id = $3
           )
         )
       RETURNING *`,
      [businessId, id, ownerPrincipalId, folderId, expectedRevision]
    );
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
       WHERE business_id = $1 AND owner_principal_id = $2 AND archived_at IS NULL
         AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [businessId, ownerPrincipalId, limit, after?.createdAt ?? null, after?.id ?? null]
    );
    return (result.rows as Array<Record<string, unknown>>).map(toRecord);
  }

  async listArchivedByOwner(
    businessId: string,
    ownerPrincipalId: string,
    limit: number,
    after?: FileCursor
  ): Promise<FileRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM files
       WHERE business_id = $1 AND owner_principal_id = $2 AND archived_at IS NOT NULL
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
       WHERE business_id = $1 AND id = ANY($2::uuid[]) AND source_conversation_id IS NULL
         AND archived_at IS NULL`,
      [businessId, [...fileIds], conversationId]
    );
  }

  async replaceVersion(version: NewFileVersion): Promise<FileRecord | null> {
    return await this.transaction(async (tx) => {
      const locked = await tx.query(
        `SELECT id FROM files
         WHERE business_id = $1 AND id = $2 AND revision = $3 AND archived_at IS NULL
         FOR UPDATE`,
        [version.businessId, version.fileId, version.expectedRevision]
      );
      if (locked.rows.length === 0) return null;

      await tx.query(
        `INSERT INTO file_versions
           (id, business_id, file_id, version_number, media_type, claimed_media_type, size_bytes,
            blob_key, blob_hash, actor_kind, actor_id, reason)
         SELECT $1, $2, $3, COALESCE(max(version_number), 0) + 1, $4, $5, $6, $7, $8,
           $9, $10, $11
         FROM file_versions
         WHERE business_id = $2 AND file_id = $3`,
        [
          version.id,
          version.businessId,
          version.fileId,
          version.mediaType,
          version.claimedMediaType,
          version.sizeBytes,
          version.blob.key,
          version.blob.hash,
          version.actorKind,
          version.actorId,
          version.reason,
        ]
      );
      const updated = await tx.query(
        `UPDATE files
         SET media_type = $3, claimed_media_type = $4, size_bytes = $5,
             blob_key = $6, blob_hash = $7, current_version_id = $8,
             revision = revision + 1, modified_at = now()
         WHERE business_id = $1 AND id = $2
         RETURNING *`,
        [
          version.businessId,
          version.fileId,
          version.mediaType,
          version.claimedMediaType,
          version.sizeBytes,
          version.blob.key,
          version.blob.hash,
          version.id,
        ]
      );
      return toRecord(updated.rows[0] as Record<string, unknown>);
    });
  }

  async restoreVersion(version: RestoreFileVersion): Promise<FileRecord | null> {
    return await this.transaction(async (tx) => {
      const locked = await tx.query(
        `SELECT id FROM files
         WHERE business_id = $1 AND id = $2 AND revision = $3 AND archived_at IS NULL
         FOR UPDATE`,
        [version.businessId, version.fileId, version.expectedRevision]
      );
      if (locked.rows.length === 0) return null;

      const source = await tx.query(
        `SELECT * FROM file_versions
         WHERE business_id = $1 AND file_id = $2 AND id = $3`,
        [version.businessId, version.fileId, version.versionId]
      );
      const row = source.rows[0] as Record<string, unknown> | undefined;
      if (row === undefined) return null;

      await tx.query(
        `INSERT INTO file_versions
           (id, business_id, file_id, version_number, media_type, claimed_media_type, size_bytes,
            blob_key, blob_hash, actor_kind, actor_id, reason, restored_from_version_id)
         SELECT $1, $2, $3, COALESCE(max(version_number), 0) + 1, $4, $5, $6, $7, $8,
           $9, $10, 'restored', $11
         FROM file_versions
         WHERE business_id = $2 AND file_id = $3`,
        [
          version.id,
          version.businessId,
          version.fileId,
          row.media_type,
          row.claimed_media_type,
          row.size_bytes,
          row.blob_key,
          row.blob_hash,
          version.actorKind,
          version.actorId,
          version.versionId,
        ]
      );
      const updated = await tx.query(
        `UPDATE files
         SET media_type = $3, claimed_media_type = $4, size_bytes = $5,
             blob_key = $6, blob_hash = $7, current_version_id = $8,
             revision = revision + 1, modified_at = now()
         WHERE business_id = $1 AND id = $2
         RETURNING *`,
        [
          version.businessId,
          version.fileId,
          row.media_type,
          row.claimed_media_type,
          row.size_bytes,
          row.blob_key,
          row.blob_hash,
          version.id,
        ]
      );
      return toRecord(updated.rows[0] as Record<string, unknown>);
    });
  }

  async setArchived(
    businessId: string,
    id: string,
    expectedRevision: number,
    archived: boolean
  ): Promise<FileRecord | null> {
    const result = await this.db.query(
      `UPDATE files
       SET archived_at = CASE WHEN $4 THEN now() ELSE NULL END,
           revision = revision + 1
       WHERE business_id = $1 AND id = $2 AND revision = $3
         AND (($4 AND archived_at IS NULL) OR (NOT $4 AND archived_at IS NOT NULL))
       RETURNING *`,
      [businessId, id, expectedRevision, archived]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? null : toRecord(row);
  }

  async anyReferencesBlob(hash: string): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM file_versions WHERE blob_hash = $1
       UNION ALL
       SELECT 1 FROM file_generation_drafts WHERE blob_hash = $1
       LIMIT 1`,
      [hash]
    );
    return result.rows.length > 0;
  }

  async deleteArchived(
    businessId: string,
    id: string,
    expectedRevision: number
  ): Promise<FileRecord | null> {
    return await this.transaction(async (tx) => {
      const selected = await tx.query(
        `SELECT * FROM files
         WHERE business_id = $1 AND id = $2 AND revision = $3 AND archived_at IS NOT NULL
         FOR UPDATE`,
        [businessId, id, expectedRevision]
      );
      const row = selected.rows[0] as Record<string, unknown> | undefined;
      if (row === undefined) return null;

      await tx.query(
        `INSERT INTO file_blob_cleanup (blob_key, blob_hash)
         SELECT DISTINCT blob_key, blob_hash
         FROM file_versions
         WHERE business_id = $1 AND file_id = $2
         ON CONFLICT (blob_key, blob_hash) DO NOTHING`,
        [businessId, id]
      );
      await tx.query("DELETE FROM files WHERE business_id = $1 AND id = $2", [businessId, id]);
      return toRecord(row);
    });
  }

  async setKnowledgeRequested(businessId: string, id: string, at: Date | null): Promise<void> {
    await this.db.query(
      `UPDATE files SET knowledge_requested_at = $3
       WHERE business_id = $1 AND id = $2 AND archived_at IS NULL`,
      [businessId, id, at]
    );
  }

  async readableIds(
    businessId: string,
    principalId: string,
    grantees: readonly FileGrantee[],
    ids: readonly string[],
    teamReadableIds: readonly string[] = []
  ): Promise<readonly string[]> {
    // A Message part's file id is free text on the wire, and `files.id` is a uuid: handing
    // Postgres a malformed one raises rather than returning no rows, which would turn one corrupt
    // transcript reference into a failed render of the entire Chat. An id that cannot name a File
    // is simply not a readable one.
    const candidates = ids.filter((id) => UUID.test(id));
    if (candidates.length === 0) return [];
    const result = await this.db.query(
      `SELECT f.id FROM files f
       WHERE f.business_id = $1
         AND f.id = ANY($2::uuid[])
         AND (
           f.owner_principal_id = $3
           OR f.id = ANY($6::uuid[])
           OR EXISTS (
             SELECT 1 FROM file_shares s
             WHERE s.file_id = f.id
               AND (s.grantee_kind, s.grantee_id) IN (
                 SELECT * FROM unnest($4::text[], $5::text[])
               )
           )
         )`,
      [
        businessId,
        candidates,
        principalId,
        grantees.map((g) => g.kind),
        grantees.map((g) => g.id),
        teamReadableIds.filter((id) => UUID.test(id)),
      ]
    );
    return (result.rows as Array<Record<string, unknown>>).map((row) => String(row.id));
  }

  async share(
    businessId: string,
    fileId: string,
    grantee: FileGrantee,
    grantedBy: string
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO file_shares (business_id, file_id, grantee_kind, grantee_id, granted_by)
       SELECT $1, $2, $3, $4, $5
       FROM files
       WHERE business_id = $1 AND id = $2 AND archived_at IS NULL
       ON CONFLICT (file_id, grantee_kind, grantee_id) DO NOTHING`,
      [businessId, fileId, grantee.kind, grantee.id, grantedBy]
    );
  }

  async unshare(businessId: string, fileId: string, grantee: FileGrantee): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM file_shares
       WHERE business_id = $1 AND file_id = $2 AND grantee_kind = $3 AND grantee_id = $4
         AND EXISTS (
           SELECT 1 FROM files
           WHERE business_id = $1 AND id = $2 AND archived_at IS NULL
         )
       RETURNING file_id`,
      [businessId, fileId, grantee.kind, grantee.id]
    );
    return result.rows.length > 0;
  }

  async countShares(businessId: string, fileIds: readonly string[]): Promise<Map<string, number>> {
    if (fileIds.length === 0) return new Map();
    const result = await this.db.query(
      `SELECT file_id, count(*)::int AS grants FROM file_shares
       WHERE business_id = $1 AND file_id = ANY($2::uuid[])
       GROUP BY file_id`,
      [businessId, [...fileIds]]
    );
    return new Map(
      (result.rows as Array<Record<string, unknown>>).map((row) => [
        String(row.file_id),
        Number(row.grants),
      ])
    );
  }

  async listShares(businessId: string, fileId: string): Promise<FileShare[]> {
    const result = await this.db.query(
      `SELECT * FROM file_shares
       WHERE business_id = $1 AND file_id = $2
       ORDER BY created_at ASC, grantee_kind ASC, grantee_id ASC`,
      [businessId, fileId]
    );
    return (result.rows as Array<Record<string, unknown>>).map((row) => ({
      fileId: String(row.file_id),
      kind: row.grantee_kind === "role" ? "role" : "user",
      id: String(row.grantee_id),
      grantedBy: String(row.granted_by),
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
    }));
  }

  async listSharedWith(
    businessId: string,
    ownerPrincipalId: string,
    grantees: readonly FileGrantee[],
    limit: number,
    after?: FileCursor,
    teamReadableIds: readonly string[] = []
  ): Promise<FileRecord[]> {
    const teamIds = teamReadableIds.filter((id) => UUID.test(id));
    if (grantees.length === 0 && teamIds.length === 0) return [];
    // The grantee set is variable-length, so it goes in as two parallel arrays rather than a
    // generated `IN` list — a query whose text depends on how many Roles the reader holds would
    // defeat the statement cache and invite an injection every time someone edits it.
    const result = await this.db.query(
      // EXISTS, not a join: a File shared both with the reader directly and with a Role they hold
      // matches two share rows, and a join would emit it twice — showing it twice on one page and
      // pushing a genuinely different File off the end of the cursor.
      `SELECT f.* FROM files f
       WHERE f.business_id = $1
         AND f.owner_principal_id <> $2
         AND f.archived_at IS NULL
         AND (
           f.id = ANY($8::uuid[])
           OR EXISTS (
             SELECT 1 FROM file_shares s
             WHERE s.file_id = f.id
               AND (s.grantee_kind, s.grantee_id) IN (
                 SELECT * FROM unnest($4::text[], $5::text[])
               )
           )
         )
         AND ($6::timestamptz IS NULL OR (f.created_at, f.id) < ($6::timestamptz, $7::uuid))
       ORDER BY f.created_at DESC, f.id DESC
       LIMIT $3`,
      [
        businessId,
        ownerPrincipalId,
        limit,
        grantees.map((g) => g.kind),
        grantees.map((g) => g.id),
        after?.createdAt ?? null,
        after?.id ?? null,
        teamIds,
      ]
    );
    return (result.rows as Array<Record<string, unknown>>).map(toRecord);
  }

  async searchReadable(
    businessId: string,
    principalId: string,
    grantees: readonly FileGrantee[],
    query: string,
    limit: number,
    teamReadableIds: readonly string[] = []
  ): Promise<FileRecord[]> {
    const result = await this.db.query(
      `SELECT f.* FROM files f
       WHERE f.business_id = $1
         AND f.archived_at IS NULL
         AND lower(f.filename) LIKE '%' || lower($4) || '%'
         AND (
           f.owner_principal_id = $2
           OR f.id = ANY($7::uuid[])
           OR EXISTS (
             SELECT 1 FROM file_shares s
             WHERE s.file_id = f.id
               AND (s.grantee_kind, s.grantee_id) IN (
                 SELECT * FROM unnest($5::text[], $6::text[])
               )
           )
         )
       ORDER BY f.created_at DESC, f.id DESC
       LIMIT $3`,
      [
        businessId,
        principalId,
        limit,
        query,
        grantees.map((grantee) => grantee.kind),
        grantees.map((grantee) => grantee.id),
        teamReadableIds.filter((id) => UUID.test(id)),
      ]
    );
    return (result.rows as Array<Record<string, unknown>>).map(toRecord);
  }

  async listVersions(businessId: string, fileId: string): Promise<FileVersionRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM file_versions
       WHERE business_id = $1 AND file_id = $2
       ORDER BY version_number DESC`,
      [businessId, fileId]
    );
    return (result.rows as Array<Record<string, unknown>>).map(toVersionRecord);
  }

  async getVersion(
    businessId: string,
    fileId: string,
    versionId: string
  ): Promise<FileVersionRecord | null> {
    const result = await this.db.query(
      `SELECT * FROM file_versions
       WHERE business_id = $1 AND file_id = $2 AND id = $3`,
      [businessId, fileId, versionId]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? null : toVersionRecord(row);
  }

  async claimBlobCleanup(
    owner: string,
    limit: number,
    leaseMs: number
  ): Promise<readonly ClaimedFileBlobCleanup[]> {
    const result = await this.transaction(async (tx) =>
      tx.query(
        `WITH candidates AS (
           SELECT blob_key, blob_hash
           FROM file_blob_cleanup
           WHERE next_attempt_at <= now()
             AND (lease_owner IS NULL OR lease_until <= now())
           ORDER BY next_attempt_at, created_at, blob_hash
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         UPDATE file_blob_cleanup AS cleanup
         SET attempts = cleanup.attempts + 1,
             lease_owner = $2,
             lease_until = now() + ($3 * interval '1 millisecond')
         FROM candidates
         WHERE cleanup.blob_key = candidates.blob_key
           AND cleanup.blob_hash = candidates.blob_hash
         RETURNING cleanup.blob_key, cleanup.blob_hash, cleanup.attempts`,
        [limit, owner, leaseMs]
      )
    );
    return (result.rows as Array<Record<string, unknown>>).map((row) => ({
      blob: { key: String(row.blob_key), hash: String(row.blob_hash) },
      attempts: Number(row.attempts),
    }));
  }

  async completeBlobCleanup(blob: BlobRef, owner: string): Promise<void> {
    await this.db.query(
      `DELETE FROM file_blob_cleanup
       WHERE blob_key = $1 AND blob_hash = $2 AND lease_owner = $3`,
      [blob.key, blob.hash, owner]
    );
  }

  async retryBlobCleanup(blob: BlobRef, owner: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE file_blob_cleanup
       SET next_attempt_at =
             now() + LEAST(3600, power(2, LEAST(attempts, 12))) * interval '1 second',
           lease_owner = NULL, lease_until = NULL, last_error = left($4, 1000)
       WHERE blob_key = $1 AND blob_hash = $2 AND lease_owner = $3`,
      [blob.key, blob.hash, owner, error]
    );
  }
}
