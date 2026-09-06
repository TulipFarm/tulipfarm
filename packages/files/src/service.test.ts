import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BlobRef, FileSystemBlobPort } from "@tulipfarm/storage";
import { Jimp } from "jimp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imageSize } from "./dimensions";
import { BUSINESS_PRINCIPAL_ID, MAX_FILE_BYTES } from "./limits";
import type {
  FileDraftRecord,
  FileFolderRecord,
  FileGrantee,
  FileRecord,
  FileRepo,
  FileShare,
  FileVersionRecord,
  NewFile,
  NewFileDraft,
  NewFileFolder,
  NewFileVersion,
  RestoreFileVersion,
} from "./repo";
import { type FileAssetOwnership, FileError, type FileOwnershipPort, FileService } from "./service";

/**
 * Teardown retries because a test that fails mid-upload can leave a write in flight, and a
 * directory that grows while it is being removed raises ENOTEMPTY. Without this, a teardown crash
 * is reported alongside the real failure and reads like a second, unrelated bug.
 */
const PURGE = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 } as const;

const BUSINESS = "biz";
const OWNER = "principal-a";
const STRANGER = "principal-b";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/**
 * The three listing answers, derived from whatever records and read gate a fake already has.
 *
 * A fake that answered these independently could disagree with its own `accessFor`, which is the
 * exact class of bug these listings exist to close — so they are derived, never restated.
 */
function listingAnswers(
  records: Map<string, FileAssetOwnership>,
  accessFor: FileOwnershipPort["accessFor"]
): Pick<FileOwnershipPort, "teamReadableFileIds" | "teamGrantCounts" | "unreadableAmong"> {
  return {
    async teamReadableFileIds() {
      return [];
    },
    async teamGrantCounts(_businessId, fileIds) {
      const counts = new Map<string, number>();
      for (const fileId of fileIds) {
        const record = records.get(fileId);
        if (record === undefined) continue;
        const teams = new Set(record.shares.map((share) => share.teamId));
        for (const owner of record.owners) if (owner.kind === "team") teams.add(owner.teamId);
        if (teams.size > 0) counts.set(fileId, teams.size);
      }
      return counts;
    },
    async unreadableAmong(_businessId, principalId, principalKind, fileIds) {
      const denied = new Set<string>();
      for (const fileId of fileIds) {
        const record = records.get(fileId);
        if (record === undefined) continue;
        const projection = await accessFor(record, principalId, principalKind);
        if (!projection.levels.includes("view")) denied.add(fileId);
      }
      return denied;
    },
  };
}

/** An in-memory repo, so these tests are about the pipeline rather than about SQL. */
class MemoryFileRepo implements FileRepo {
  readonly rows: FileRecord[] = [];
  readonly versions: FileVersionRecord[] = [];
  readonly drafts: FileDraftRecord[] = [];
  readonly cleanup: BlobRef[] = [];
  readonly folders: FileFolderRecord[] = [];

  async withBlobLock<T>(_hash: string, task: (repo: FileRepo) => Promise<T>): Promise<T> {
    return await task(this);
  }

  async create(file: NewFile): Promise<FileRecord> {
    const createdAt = new Date();
    const record: FileRecord = {
      ...file,
      folderId: file.folderId ?? null,
      origin: file.origin ?? "uploaded",
      sourceConversationId: null,
      sourceRunId: file.sourceRunId ?? null,
      sourceToolCallId: file.sourceToolCallId ?? null,
      knowledgeRequestedAt: null,
      currentVersionId: file.id,
      revision: 1,
      modifiedAt: createdAt,
      archivedAt: null,
      createdAt,
    };
    this.rows.push(record);
    this.versions.push({
      id: file.id,
      businessId: file.businessId,
      fileId: file.id,
      versionNumber: 1,
      mediaType: file.mediaType,
      claimedMediaType: file.claimedMediaType,
      sizeBytes: file.sizeBytes,
      blob: file.blob,
      actorKind: file.versionActorKind ?? "principal",
      actorId: file.versionActorId ?? file.ownerPrincipalId,
      reason: "created",
      sourceConversationId: null,
      sourceRunId: file.sourceRunId ?? null,
      restoredFromVersionId: null,
      createdAt,
    });
    return record;
  }

  async createGenerated(file: NewFile): Promise<{ file: FileRecord; created: boolean }> {
    const existing = this.rows.find(
      (row) =>
        row.businessId === file.businessId &&
        row.sourceRunId === file.sourceRunId &&
        row.sourceToolCallId === file.sourceToolCallId
    );
    if (existing !== undefined) return { file: existing, created: false };
    return { file: await this.create(file), created: true };
  }

  async createDraft(draft: NewFileDraft): Promise<{ draft: FileDraftRecord; created: boolean }> {
    const existing = this.drafts.find(
      (row) =>
        row.businessId === draft.businessId &&
        row.sourceRunId === draft.sourceRunId &&
        row.sourceToolCallId === draft.sourceToolCallId
    );
    if (existing !== undefined) return { draft: existing, created: false };
    const record: FileDraftRecord = {
      ...draft,
      authoredByAgentId: draft.authoredByAgentId ?? null,
      savedFileId: null,
      createdAt: new Date(),
    };
    this.drafts.push(record);
    return { draft: record, created: true };
  }

  async getDraft(
    businessId: string,
    id: string,
    creatorPrincipalId: string
  ): Promise<FileDraftRecord | null> {
    return (
      this.drafts.find(
        (draft) =>
          draft.businessId === businessId &&
          draft.id === id &&
          draft.creatorPrincipalId === creatorPrincipalId
      ) ?? null
    );
  }

  async saveDraft(
    businessId: string,
    id: string,
    creatorPrincipalId: string,
    fileId: string
  ): Promise<FileRecord | null> {
    const index = this.drafts.findIndex(
      (draft) =>
        draft.businessId === businessId &&
        draft.id === id &&
        draft.creatorPrincipalId === creatorPrincipalId
    );
    const draft = this.drafts[index];
    if (draft === undefined || draft.expiresAt.getTime() <= Date.now()) return null;
    if (draft.savedFileId !== null) return await this.get(businessId, draft.savedFileId);
    const file = await this.create({
      id: fileId,
      businessId,
      ownerPrincipalId: creatorPrincipalId,
      filename: draft.filename,
      mediaType: draft.mediaType,
      claimedMediaType: draft.mediaType,
      sizeBytes: draft.sizeBytes,
      blob: draft.blob,
      origin: "generated",
      sourceRunId: draft.sourceRunId,
      sourceToolCallId: draft.sourceToolCallId,
      versionActorKind: draft.authoredByAgentId === null ? "system" : "agent",
      versionActorId: draft.authoredByAgentId ?? BUSINESS_PRINCIPAL_ID,
    });
    this.drafts[index] = { ...draft, savedFileId: file.id };
    return file;
  }

  async expireDrafts(_limit: number): Promise<number> {
    const before = this.drafts.length;
    const now = Date.now();
    for (let index = this.drafts.length - 1; index >= 0; index -= 1) {
      const draft = this.drafts[index];
      if (
        (draft?.expiresAt.getTime() ?? Number.POSITIVE_INFINITY) <= now &&
        draft?.savedFileId === null
      ) {
        if (
          !this.cleanup.some((blob) => blob.key === draft.blob.key && blob.hash === draft.blob.hash)
        ) {
          this.cleanup.push(draft.blob);
        }
        this.drafts.splice(index, 1);
      }
    }
    return before - this.drafts.length;
  }

  async get(businessId: string, id: string): Promise<FileRecord | null> {
    return this.rows.find((r) => r.businessId === businessId && r.id === id) ?? null;
  }

  async getMany(businessId: string, ids: readonly string[]): Promise<FileRecord[]> {
    const wanted = new Set(ids);
    return this.rows.filter((row) => row.businessId === businessId && wanted.has(row.id));
  }

  async createFolder(folder: NewFileFolder): Promise<FileFolderRecord | null> {
    if (
      this.folders.some(
        (candidate) =>
          candidate.businessId === folder.businessId &&
          candidate.ownerPrincipalId === folder.ownerPrincipalId &&
          candidate.parentId === (folder.parentId ?? null) &&
          candidate.name.toLowerCase() === folder.name.toLowerCase()
      )
    ) {
      return null;
    }
    if (
      folder.parentId !== undefined &&
      !this.folders.some(
        (candidate) =>
          candidate.id === folder.parentId &&
          candidate.businessId === folder.businessId &&
          candidate.ownerPrincipalId === folder.ownerPrincipalId
      )
    ) {
      return null;
    }
    const now = new Date();
    const record: FileFolderRecord = {
      ...folder,
      parentId: folder.parentId ?? null,
      createdAt: now,
      modifiedAt: now,
    };
    this.folders.push(record);
    return record;
  }

  async getFolder(businessId: string, id: string): Promise<FileFolderRecord | null> {
    return (
      this.folders.find((folder) => folder.businessId === businessId && folder.id === id) ?? null
    );
  }

  async listFolders(businessId: string, ownerPrincipalId: string): Promise<FileFolderRecord[]> {
    return this.folders.filter(
      (folder) => folder.businessId === businessId && folder.ownerPrincipalId === ownerPrincipalId
    );
  }

  async renameFolder(
    businessId: string,
    id: string,
    ownerPrincipalId: string,
    name: string
  ): Promise<FileFolderRecord | null> {
    const index = this.folders.findIndex(
      (folder) =>
        folder.businessId === businessId &&
        folder.id === id &&
        folder.ownerPrincipalId === ownerPrincipalId
    );
    if (index === -1) return null;
    const folder = this.folders[index];
    if (
      this.folders.some(
        (sibling) =>
          sibling.businessId === businessId &&
          sibling.ownerPrincipalId === ownerPrincipalId &&
          sibling.id !== id &&
          sibling.parentId === folder.parentId &&
          sibling.name.toLowerCase() === name.toLowerCase()
      )
    ) {
      return null;
    }
    const renamed = { ...folder, name, modifiedAt: new Date() };
    this.folders[index] = renamed;
    return renamed;
  }

  async deleteFolder(businessId: string, id: string, ownerPrincipalId: string): Promise<boolean> {
    const index = this.folders.findIndex(
      (folder) =>
        folder.businessId === businessId &&
        folder.id === id &&
        folder.ownerPrincipalId === ownerPrincipalId
    );
    if (index === -1) return false;
    if (this.rows.some((row) => row.folderId === id)) return false;
    if (this.folders.some((folder) => folder.parentId === id)) return false;
    this.folders.splice(index, 1);
    return true;
  }

  async moveFile(
    businessId: string,
    id: string,
    ownerPrincipalId: string,
    folderId: string | null,
    expectedRevision: number
  ): Promise<FileRecord | null> {
    const index = this.rows.findIndex(
      (row) =>
        row.businessId === businessId &&
        row.id === id &&
        row.ownerPrincipalId === ownerPrincipalId &&
        row.revision === expectedRevision &&
        row.archivedAt === null
    );
    const current = this.rows[index];
    if (current === undefined) return null;
    const updated = {
      ...current,
      folderId,
      revision: current.revision + 1,
      modifiedAt: new Date(),
    };
    this.rows[index] = updated;
    return updated;
  }

  async listByOwner(businessId: string, owner: string, limit: number): Promise<FileRecord[]> {
    return this.rows
      .filter(
        (r) => r.businessId === businessId && r.ownerPrincipalId === owner && r.archivedAt === null
      )
      .slice(0, limit);
  }

  async listArchivedByOwner(
    businessId: string,
    owner: string,
    limit: number
  ): Promise<FileRecord[]> {
    return this.rows
      .filter(
        (r) => r.businessId === businessId && r.ownerPrincipalId === owner && r.archivedAt !== null
      )
      .slice(0, limit);
  }

  async replaceVersion(version: NewFileVersion): Promise<FileRecord | null> {
    const index = this.rows.findIndex(
      (row) =>
        row.businessId === version.businessId &&
        row.id === version.fileId &&
        row.revision === version.expectedRevision &&
        row.archivedAt === null
    );
    const current = this.rows[index];
    if (current === undefined) return null;
    const createdAt = new Date();
    const next: FileVersionRecord = {
      id: version.id,
      businessId: version.businessId,
      fileId: version.fileId,
      versionNumber: this.versions.filter((item) => item.fileId === version.fileId).length + 1,
      mediaType: version.mediaType,
      claimedMediaType: version.claimedMediaType,
      sizeBytes: version.sizeBytes,
      blob: version.blob,
      actorKind: version.actorKind,
      actorId: version.actorId,
      reason: "replaced",
      sourceConversationId: null,
      sourceRunId: null,
      restoredFromVersionId: null,
      createdAt,
    };
    this.versions.push(next);
    const updated = {
      ...current,
      mediaType: next.mediaType,
      claimedMediaType: next.claimedMediaType,
      sizeBytes: next.sizeBytes,
      blob: next.blob,
      currentVersionId: next.id,
      revision: current.revision + 1,
      modifiedAt: createdAt,
    };
    this.rows[index] = updated;
    return updated;
  }

  async restoreVersion(version: RestoreFileVersion): Promise<FileRecord | null> {
    const source = this.versions.find(
      (item) =>
        item.businessId === version.businessId &&
        item.fileId === version.fileId &&
        item.id === version.versionId
    );
    if (source === undefined) return null;
    return await this.replaceVersion({
      id: version.id,
      businessId: version.businessId,
      fileId: version.fileId,
      expectedRevision: version.expectedRevision,
      mediaType: source.mediaType,
      claimedMediaType: source.claimedMediaType,
      sizeBytes: source.sizeBytes,
      blob: source.blob,
      actorKind: version.actorKind,
      actorId: version.actorId,
      reason: "replaced",
    }).then((file) => {
      const restored = this.versions.at(-1);
      if (file && restored) {
        this.versions[this.versions.length - 1] = {
          ...restored,
          reason: "restored",
          restoredFromVersionId: version.versionId,
        };
      }
      return file;
    });
  }

  async setArchived(
    businessId: string,
    id: string,
    expectedRevision: number,
    archived: boolean
  ): Promise<FileRecord | null> {
    const index = this.rows.findIndex(
      (row) =>
        row.businessId === businessId &&
        row.id === id &&
        row.revision === expectedRevision &&
        (archived ? row.archivedAt === null : row.archivedAt !== null)
    );
    const current = this.rows[index];
    if (current === undefined) return null;
    const updated = {
      ...current,
      archivedAt: archived ? new Date() : null,
      revision: current.revision + 1,
    };
    this.rows[index] = updated;
    return updated;
  }

  readonly shares: FileShare[] = [];

  async share(
    _businessId: string,
    fileId: string,
    grantee: FileGrantee,
    grantedBy: string
  ): Promise<void> {
    if (
      this.shares.some((s) => s.fileId === fileId && s.kind === grantee.kind && s.id === grantee.id)
    ) {
      return;
    }
    this.shares.push({ fileId, ...grantee, grantedBy, createdAt: new Date() });
  }

  async unshare(_businessId: string, fileId: string, grantee: FileGrantee): Promise<boolean> {
    const index = this.shares.findIndex(
      (s) => s.fileId === fileId && s.kind === grantee.kind && s.id === grantee.id
    );
    if (index === -1) return false;
    this.shares.splice(index, 1);
    return true;
  }

  async countShares(_businessId: string, fileIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const id of fileIds) {
      const grants = this.shares.filter((share) => share.fileId === id).length;
      if (grants > 0) counts.set(id, grants);
    }
    return counts;
  }

  async listShares(_businessId: string, fileId: string): Promise<FileShare[]> {
    return this.shares.filter((s) => s.fileId === fileId);
  }

  async listSharedWith(
    businessId: string,
    ownerPrincipalId: string,
    grantees: readonly FileGrantee[],
    limit: number
  ): Promise<FileRecord[]> {
    const shared = new Set(
      this.shares
        .filter((s) => grantees.some((g) => g.kind === s.kind && g.id === s.id))
        .map((s) => s.fileId)
    );
    return this.rows
      .filter(
        (r) =>
          r.businessId === businessId &&
          r.ownerPrincipalId !== ownerPrincipalId &&
          shared.has(r.id) &&
          r.archivedAt === null
      )
      .slice(0, limit);
  }

  async searchReadable(
    businessId: string,
    principalId: string,
    grantees: readonly FileGrantee[],
    query: string,
    limit: number
  ): Promise<FileRecord[]> {
    return this.rows
      .filter(
        (row) =>
          row.businessId === businessId &&
          row.archivedAt === null &&
          row.filename.toLowerCase().includes(query.toLowerCase()) &&
          (row.ownerPrincipalId === principalId ||
            this.shares.some(
              (share) =>
                share.fileId === row.id &&
                grantees.some((grantee) => grantee.kind === share.kind && grantee.id === share.id)
            ))
      )
      .slice(0, limit);
  }

  async listVersions(businessId: string, fileId: string): Promise<FileVersionRecord[]> {
    return this.versions
      .filter((version) => version.businessId === businessId && version.fileId === fileId)
      .sort((a, b) => b.versionNumber - a.versionNumber);
  }

  async getVersion(
    businessId: string,
    fileId: string,
    versionId: string
  ): Promise<FileVersionRecord | null> {
    return (
      this.versions.find(
        (version) =>
          version.businessId === businessId && version.fileId === fileId && version.id === versionId
      ) ?? null
    );
  }

  async recordFirstConversation(
    businessId: string,
    fileIds: readonly string[],
    conversationId: string
  ): Promise<void> {
    for (const [index, row] of this.rows.entries()) {
      if (row.businessId !== businessId) continue;
      if (!fileIds.includes(row.id) || row.sourceConversationId !== null) continue;
      this.rows[index] = { ...row, sourceConversationId: conversationId };
    }
  }

  async setKnowledgeRequested(businessId: string, id: string, at: Date | null): Promise<void> {
    const i = this.rows.findIndex((r) => r.businessId === businessId && r.id === id);
    const row = this.rows[i];
    if (row !== undefined) this.rows[i] = { ...row, knowledgeRequestedAt: at };
  }

  async deleteArchived(
    businessId: string,
    id: string,
    expectedRevision: number
  ): Promise<FileRecord | null> {
    const index = this.rows.findIndex((r) => r.businessId === businessId && r.id === id);
    const file = this.rows[index];
    if (file === undefined || file.revision !== expectedRevision || file.archivedAt === null) {
      return null;
    }
    for (const version of this.versions.filter((item) => item.fileId === id)) {
      if (!this.cleanup.some((blob) => blob.key === version.blob.key)) {
        this.cleanup.push(version.blob);
      }
    }
    this.rows.splice(index, 1);
    for (let i = this.versions.length - 1; i >= 0; i--) {
      if (this.versions[i]?.fileId === id) this.versions.splice(i, 1);
    }
    // Mirrors `file_shares.file_id ... ON DELETE CASCADE`. A memory repo that kept the shares
    // would be a repo in which revocation-by-deletion appears to work and does not.
    for (let i = this.shares.length - 1; i >= 0; i--) {
      if (this.shares[i]?.fileId === id) this.shares.splice(i, 1);
    }
    return file;
  }

  async readableIds(
    businessId: string,
    principalId: string,
    grantees: readonly FileGrantee[],
    ids: readonly string[]
  ): Promise<readonly string[]> {
    return this.rows
      .filter(
        (r) =>
          r.businessId === businessId &&
          ids.includes(r.id) &&
          (r.ownerPrincipalId === principalId ||
            this.shares.some(
              (s) => s.fileId === r.id && grantees.some((g) => g.kind === s.kind && g.id === s.id)
            ))
      )
      .map((r) => r.id);
  }

  async anyReferencesBlob(hash: string): Promise<boolean> {
    return (
      this.versions.some((version) => version.blob.hash === hash) ||
      this.drafts.some((draft) => draft.blob.hash === hash)
    );
  }

  async claimBlobCleanup(): Promise<readonly { blob: BlobRef; attempts: number }[]> {
    return this.cleanup.map((blob) => ({ blob, attempts: 1 }));
  }

  async completeBlobCleanup(blob: BlobRef): Promise<void> {
    const index = this.cleanup.findIndex(
      (candidate) => candidate.key === blob.key && candidate.hash === blob.hash
    );
    if (index !== -1) this.cleanup.splice(index, 1);
  }

  async retryBlobCleanup(): Promise<void> {}
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

describe("FileService.upload", () => {
  let root: string;
  let blobs: FileSystemBlobPort;
  let repo: MemoryFileRepo;
  let service: FileService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tulip-files-"));
    blobs = new FileSystemBlobPort(root);
    repo = new MemoryFileRepo();
    service = new FileService({ repo, blobs, newId: () => randomUUID() });
  });

  afterEach(async () => {
    await rm(root, PURGE);
  });

  function upload(overrides: Partial<Parameters<FileService["upload"]>[0]> = {}) {
    return service.upload({
      businessId: BUSINESS,
      ownerPrincipalId: OWNER,
      filename: "shot.png",
      claimedMediaType: "image/png",
      declaredBytes: PNG.byteLength,
      body: once(PNG),
      ...overrides,
    });
  }

  it("stores the sniffed type, the claimed type, and the real size", async () => {
    const file = await upload({ claimedMediaType: "image/jpeg" });
    expect(file.mediaType).toBe("image/png");
    expect(file.claimedMediaType).toBe("image/jpeg");
    expect(file.sizeBytes).toBe(PNG.byteLength);
  });

  it("owns the File by the uploading Principal", async () => {
    const file = await upload();
    expect(file.ownerPrincipalId).toBe(OWNER);
  });

  describe("Team ownership", () => {
    function teamOwnership(
      access: Map<string, { levels: Array<"view" | "use" | "edit">; manage: boolean }>,
      onConsume?: (operationId: string) => void
    ): FileOwnershipPort {
      const records = new Map<string, FileAssetOwnership>();
      const accessFor: FileOwnershipPort["accessFor"] = async (_ownership, principalId) => {
        const projected = access.get(principalId);
        return {
          levels: projected?.levels ?? [],
          canManageOwnership: projected?.manage ?? false,
        };
      };
      return {
        ...listingAnswers(records, accessFor),
        async createPersonal(businessId, fileId, principalId) {
          records.set(fileId, {
            businessId,
            assetType: "file",
            assetId: fileId,
            owners: [{ kind: "principal", principalId, principalKind: "user" }],
            shares: [],
            revision: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        },
        async get(_businessId, fileId) {
          return records.get(fileId);
        },
        accessFor,
        async consumeDestructiveApproval(ownership, action, operationId) {
          const joint = ownership.owners.filter((owner) => owner.kind === "team").length > 1;
          if (joint && operationId !== `${action}-operation`) {
            throw new FileError("invalid_state", "joint owner Approval required");
          }
          if (operationId) onConsume?.(operationId);
        },
      };
    }

    async function teamOwnedFile(
      access: Map<string, { levels: Array<"view" | "use" | "edit">; manage: boolean }>,
      owners?: FileAssetOwnership["owners"],
      onConsume?: (operationId: string) => void
    ) {
      const file = await upload();
      const ownership = teamOwnership(access, onConsume);
      const record: FileAssetOwnership = {
        businessId: BUSINESS,
        assetType: "file",
        assetId: file.id,
        owners: owners ?? [{ kind: "team", teamId: "team-owner" }],
        shares: [],
        revision: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const originalGet = ownership.get;
      ownership.get = async (businessId, fileId) =>
        fileId === file.id ? record : originalGet(businessId, fileId);
      service = new FileService({
        repo,
        blobs,
        newId: () => randomUUID(),
        ownership,
      });
      return file;
    }

    it("projects owner members, exact admins, descendants, and explicit Edit into existing gates", async () => {
      const access = new Map([
        ["member", { levels: ["view", "use"] as Array<"view" | "use">, manage: false }],
        ["owner-admin", { levels: ["view", "use", "edit"] as const, manage: true }],
        ["child-admin", { levels: ["view", "use"] as Array<"view" | "use">, manage: false }],
        ["shared-editor", { levels: ["view", "use", "edit"] as const, manage: false }],
      ]);
      const file = await teamOwnedFile(
        access as Map<string, { levels: Array<"view" | "use" | "edit">; manage: boolean }>
      );

      await expect(service.read(BUSINESS, file.id, "member")).resolves.toMatchObject({
        id: file.id,
      });
      await expect(service.read(BUSINESS, file.id, "child-admin")).resolves.toMatchObject({
        id: file.id,
      });
      await expect(
        service.replace({
          businessId: BUSINESS,
          ownerPrincipalId: "shared-editor",
          fileId: file.id,
          expectedRevision: file.revision,
          claimedMediaType: "image/png",
          declaredBytes: PNG.byteLength,
          body: once(PNG),
        })
      ).resolves.toMatchObject({ revision: 2 });
      await expect(
        service.share(BUSINESS, file.id, "shared-editor", { kind: "user", id: STRANGER })
      ).rejects.toMatchObject({ reason: "not_found" });
    });

    it("applies Team revocation to the next read without cached membership", async () => {
      const access = new Map<string, { levels: Array<"view" | "use" | "edit">; manage: boolean }>([
        ["member", { levels: ["view", "use"], manage: false }],
      ]);
      const file = await teamOwnedFile(access);
      await expect(service.read(BUSINESS, file.id, "member")).resolves.toMatchObject({
        id: file.id,
      });
      access.delete("member");
      await expect(service.read(BUSINESS, file.id, "member")).rejects.toMatchObject({
        reason: "not_found",
      });
    });

    it("keeps a personal File private", async () => {
      const ownership = teamOwnership(
        new Map([[OWNER, { levels: ["view", "use", "edit"], manage: true }]])
      );
      service = new FileService({ repo, blobs, newId: () => randomUUID(), ownership });
      const file = await upload();
      await expect(service.read(BUSINESS, file.id, OWNER)).resolves.toMatchObject({ id: file.id });
      await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
        reason: "not_found",
      });
    });

    it("consumes a pending T11 Approval as part of a joint-owner archive", async () => {
      const access = new Map<string, { levels: Array<"view" | "use" | "edit">; manage: boolean }>([
        ["owner-admin", { levels: ["view", "use", "edit"], manage: true }],
      ]);
      const consumed: string[] = [];
      const file = await teamOwnedFile(
        access,
        [
          { kind: "team", teamId: "team-a" },
          { kind: "team", teamId: "team-b" },
        ],
        (operationId) => consumed.push(operationId)
      );
      await expect(
        service.archive(BUSINESS, file.id, "owner-admin", file.revision)
      ).rejects.toMatchObject({ reason: "invalid_state" });
      await expect(
        service.archive(
          BUSINESS,
          file.id,
          "owner-admin",
          file.revision,
          undefined,
          "archive-operation"
        )
      ).resolves.toMatchObject({ archivedAt: expect.any(Date) });
      expect(consumed).toEqual(["archive-operation"]);
    });

    it("consumes the exact pending Approval before a joint-owner permanent delete", async () => {
      const access = new Map<string, { levels: Array<"view" | "use" | "edit">; manage: boolean }>([
        ["owner-admin", { levels: ["view", "use", "edit"], manage: true }],
      ]);
      const consumed: string[] = [];
      const file = await teamOwnedFile(
        access,
        [
          { kind: "team", teamId: "team-a" },
          { kind: "team", teamId: "team-b" },
        ],
        (operationId) => consumed.push(operationId)
      );
      const archived = await service.archive(
        BUSINESS,
        file.id,
        "owner-admin",
        file.revision,
        undefined,
        "archive-operation"
      );

      await expect(
        service.delete(BUSINESS, file.id, "owner-admin", archived.revision, "delete-operation")
      ).resolves.toMatchObject({ id: file.id });
      expect(consumed).toEqual(["archive-operation", "delete-operation"]);
    });
  });

  // The order is the point: a declared length over the cap must cost a header, not a write.
  it("refuses an oversized upload before anything reaches storage", async () => {
    let consumed = false;
    const body = (async function* () {
      consumed = true;
      yield PNG;
    })();

    await expect(upload({ declaredBytes: MAX_FILE_BYTES + 1, body })).rejects.toThrow(FileError);
    expect(consumed).toBe(false);
    expect(repo.rows).toHaveLength(0);
  });

  // A client can declare any length it likes, so the stream itself has to enforce the cap.
  it("refuses a body that exceeds the cap despite an honest-looking declared length", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    chunk.set(PNG, 0);
    const body = (async function* () {
      for (let i = 0; i <= MAX_FILE_BYTES / chunk.byteLength; i += 1) yield chunk;
    })();

    await expect(upload({ declaredBytes: 10, body })).rejects.toMatchObject({
      reason: "too_large",
    });
    expect(repo.rows).toHaveLength(0);
  });

  it("refuses a file whose real type contradicts its claim", async () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    await expect(
      upload({ claimedMediaType: "image/png", body: once(html), filename: "x.png" })
    ).rejects.toMatchObject({ reason: "disallowed_type" });
    expect(repo.rows).toHaveLength(0);
  });

  it("refuses SVG", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(
      upload({ claimedMediaType: "image/svg+xml", body: once(svg), filename: "x.svg" })
    ).rejects.toMatchObject({ reason: "disallowed_type" });
  });

  it("refuses an empty body rather than storing a zero-byte File", async () => {
    const body = (async function* (): AsyncIterable<Uint8Array> {})();
    await expect(upload({ body, declaredBytes: 0 })).rejects.toMatchObject({ reason: "empty" });
    expect(repo.rows).toHaveLength(0);
  });

  it("normalises a traversal-shaped filename and never lets it reach the storage key", async () => {
    const file = await upload({ filename: "../../etc/shadow.png" });
    expect(file.filename).toBe("shadow.png");
    expect(file.blob.key).toBe(file.blob.hash);
    expect(file.blob.key).not.toContain("/");
    expect(file.blob.key).not.toContain("shadow");
  });

  // Content-addressed storage means one refused upload must not take an accepted File's bytes.
  it("keeps the bytes of an accepted File when a byte-identical upload is refused", async () => {
    const text = new TextEncoder().encode("hello, world");
    const accepted = await upload({
      claimedMediaType: "text/plain",
      filename: "note.txt",
      body: once(text),
      declaredBytes: text.byteLength,
    });

    await expect(
      upload({
        claimedMediaType: "text/html",
        filename: "note.html",
        body: once(text),
        declaredBytes: text.byteLength,
      })
    ).rejects.toMatchObject({ reason: "disallowed_type" });

    expect(await blobs.head(accepted.blob)).not.toBeNull();
  });

  it("removes the bytes of a refused upload nothing else references", async () => {
    const html = new TextEncoder().encode("<html>not a png at all</html>");
    const hash = createHash("sha256").update(html).digest("hex");

    await expect(upload({ claimedMediaType: "image/png", body: once(html) })).rejects.toMatchObject(
      { reason: "disallowed_type" }
    );

    expect(await blobs.head({ key: hash, hash })).toBeNull();
    expect(repo.rows).toHaveLength(0);
  });
});

describe("FileService.read", () => {
  let root: string;
  let service: FileService;
  let repo: MemoryFileRepo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tulip-files-"));
    repo = new MemoryFileRepo();
    service = new FileService({
      repo,
      blobs: new FileSystemBlobPort(root),
      newId: () => randomUUID(),
    });
  });

  afterEach(async () => {
    await rm(root, PURGE);
  });

  async function seed(): Promise<FileRecord> {
    return await service.upload({
      businessId: BUSINESS,
      ownerPrincipalId: OWNER,
      filename: "shot.png",
      claimedMediaType: "image/png",
      declaredBytes: PNG.byteLength,
      body: once(PNG),
    });
  }

  it("returns the File to its owner", async () => {
    const file = await seed();
    expect((await service.read(BUSINESS, file.id, OWNER)).id).toBe(file.id);
  });

  it("refuses a second Principal, since a File is private by default", async () => {
    const file = await seed();
    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toBeInstanceOf(FileError);
  });

  // Distinguishing "not yours" from "does not exist" turns the route into an existence oracle.
  it("tells a stranger the same thing it tells someone guessing an id", async () => {
    const file = await seed();
    const denied = await service.read(BUSINESS, file.id, STRANGER).catch((e: FileError) => e);
    const missing = await service.read(BUSINESS, randomUUID(), STRANGER).catch((e: FileError) => e);
    expect((denied as FileError).reason).toBe((missing as FileError).reason);
  });

  // The identical message is only half the defence. If a hidden File costs more queries than a
  // missing one, the difference is measurable and the oracle is back, just in the timing.
  it("does the same work for a File that is hidden as for one that is not there", async () => {
    const file = await seed();
    const counted: string[] = [];
    const repo = service as unknown as {
      deps: { repo: { listShares: (...a: never[]) => unknown }; rolesOf?: unknown };
    };
    const realListShares = repo.deps.repo.listShares.bind(repo.deps.repo);
    repo.deps.repo.listShares = (...args: never[]) => {
      counted.push("listShares");
      return realListShares(...args);
    };
    repo.deps.rolesOf = async () => {
      counted.push("rolesOf");
      return [];
    };

    await service.read(BUSINESS, file.id, STRANGER).catch(() => undefined);
    const hidden = [...counted];
    counted.length = 0;
    await service.read(BUSINESS, randomUUID(), STRANGER).catch(() => undefined);

    expect(counted).toEqual(hidden);
  });

  it("does not leak a File across businesses", async () => {
    const file = await seed();
    await expect(service.read("other-biz", file.id, OWNER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("streams back the stored bytes", async () => {
    const file = await seed();
    const { body } = await service.content(BUSINESS, file.id, OWNER);
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(Buffer.from(PNG))).toBe(true);
  });
});

/** A 200px ceiling, for the reason given in `bound.test.ts`. */
const DOWNSCALE_TO = { maxImageDimension: 200, downscaleImages: true } as const;

describe("FileService.upload — image bounding", () => {
  let root: string;
  let blobs: FileSystemBlobPort;
  let repo: MemoryFileRepo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tulip-bound-"));
    blobs = new FileSystemBlobPort(root);
    repo = new MemoryFileRepo();
  });

  afterEach(async () => {
    await rm(root, PURGE);
  });

  const rasters = new Map<string, Promise<Uint8Array>>();

  /** Real PNG bytes for a size, encoded at most once; see `bound.test.ts` for why. */
  function realPng(width: number, height: number): Promise<Uint8Array> {
    const key = `${width}x${height}`;
    const cached = rasters.get(key);
    if (cached !== undefined) return cached;
    const encoding = new Jimp({ width, height, color: 0x336699ff })
      .getBuffer("image/png")
      .then((buffer) => new Uint8Array(buffer));
    rasters.set(key, encoding);
    return encoding;
  }

  function serviceWith(policy?: () => { maxImageDimension?: number; downscaleImages?: boolean }) {
    return new FileService({
      repo,
      blobs,
      newId: () => randomUUID(),
      ...(policy === undefined ? {} : { imagePolicy: policy }),
    });
  }

  function put(service: FileService, bytes: Uint8Array) {
    return service.upload({
      businessId: BUSINESS,
      ownerPrincipalId: OWNER,
      filename: "shot.png",
      claimedMediaType: "image/png",
      declaredBytes: bytes.byteLength,
      body: once(bytes),
    });
  }

  it("accepts an image inside the pixel limit", async () => {
    const file = await put(serviceWith(), await realPng(320, 200));

    expect(file.mediaType).toBe("image/png");
  });

  it("stores an oversized image when the operator configured no image policy", async () => {
    const service = serviceWith();

    await expect(put(service, await realPng(1_600, 8))).resolves.toMatchObject({
      mediaType: "image/png",
    });
  });

  it("downscales instead of refusing when the operator turned it on", async () => {
    const service = serviceWith(() => DOWNSCALE_TO);

    const file = await put(service, await realPng(400, 200));

    expect(file.mediaType).toBe("image/png");
    expect(file.sizeBytes).toBeGreaterThan(0);
  });

  it("stores the downscaled bytes, so what is served back is what the model was given", async () => {
    const service = serviceWith(() => DOWNSCALE_TO);

    const file = await put(service, await realPng(400, 200));
    const { body } = await service.content(BUSINESS, file.id, OWNER);
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);

    expect(imageSize(new Uint8Array(Buffer.concat(chunks)), "image/png")).toEqual({
      width: 200,
      height: 100,
    });
  });

  it("records the downscaled byte length, not the length that was uploaded", async () => {
    const original = await realPng(400, 200);
    const service = serviceWith(() => DOWNSCALE_TO);

    const file = await put(service, original);

    expect(file.sizeBytes).not.toBe(original.byteLength);
  });

  it("honours the business's own pixel limit over the default", async () => {
    const service = serviceWith(() => ({ maxImageDimension: 100 }));

    await expect(put(service, await realPng(320, 200))).rejects.toMatchObject({
      reason: "image_too_large",
    });
  });

  it("names the actual size when an operator-configured limit refuses an image", async () => {
    const service = serviceWith(() => ({ maxImageDimension: 100 }));

    await expect(put(service, await realPng(320, 200))).rejects.toThrow(/320×200/);
    expect(repo.rows).toHaveLength(0);
  });

  it("does not bound a PDF, whose cost the byte cap already governs", async () => {
    const pdf = new Uint8Array(64);
    pdf.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0);
    const service = serviceWith(() => ({ maxImageDimension: 1 }));

    const file = await service.upload({
      businessId: BUSINESS,
      ownerPrincipalId: OWNER,
      filename: "doc.pdf",
      claimedMediaType: "application/pdf",
      declaredBytes: pdf.byteLength,
      body: once(pdf),
    });

    expect(file.mediaType).toBe("application/pdf");
  });

  it("reads a JPEG's dimensions from behind its metadata, not just its first bytes", async () => {
    const image = new Jimp({ width: 1_600, height: 8, color: 0x336699ff });
    const jpeg = new Uint8Array(await image.getBuffer("image/jpeg"));
    const service = serviceWith(() => ({ maxImageDimension: 100 }));

    await expect(
      service.upload({
        businessId: BUSINESS,
        ownerPrincipalId: OWNER,
        filename: "photo.jpg",
        claimedMediaType: "image/jpeg",
        declaredBytes: jpeg.byteLength,
        body: once(jpeg),
      })
    ).rejects.toMatchObject({ reason: "image_too_large" });
  });
});

describe("sharing a File", () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  let root: string;
  let repo: MemoryFileRepo;
  let service: FileService;
  let roles: Map<string, string[]>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tulip-files-share-"));
    repo = new MemoryFileRepo();
    roles = new Map();
    service = new FileService({
      repo,
      blobs: new FileSystemBlobPort(root),
      newId: () => randomUUID(),
      rolesOf: async (_business, principalId) => roles.get(principalId) ?? [],
    });
  });

  afterEach(async () => {
    await rm(root, PURGE);
  });

  async function uploaded() {
    return await service.upload({
      businessId: BUSINESS,
      ownerPrincipalId: OWNER,
      filename: "shot.png",
      claimedMediaType: "image/png",
      declaredBytes: PNG_BYTES.byteLength,
      body: (async function* () {
        yield PNG_BYTES;
      })(),
    });
  }

  it("is private to its owner until someone shares it", async () => {
    const file = await uploaded();

    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("lets a named person read it once shared", async () => {
    const file = await uploaded();

    await service.share(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER });

    expect((await service.read(BUSINESS, file.id, STRANGER)).id).toBe(file.id);
  });

  it("stops working on the very next read once revoked", async () => {
    const file = await uploaded();
    await service.share(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER });

    expect(await service.unshare(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER })).toBe(
      true
    );

    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("resolves a Role share against the reader's Roles as they are right now", async () => {
    const file = await uploaded();
    await service.share(BUSINESS, file.id, OWNER, { kind: "role", id: "support" });

    // Not yet in the Role.
    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });

    roles.set(STRANGER, ["support"]);
    expect((await service.read(BUSINESS, file.id, STRANGER)).id).toBe(file.id);

    // Leaving the Role revokes the File, with no share row touched and nothing to invalidate.
    roles.set(STRANGER, []);
    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("refuses to let a recipient re-share, which is what keeps a revoke final", async () => {
    const file = await uploaded();
    await service.share(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER });

    await expect(
      service.share(BUSINESS, file.id, STRANGER, { kind: "user", id: "principal-c" })
    ).rejects.toMatchObject({ reason: "not_found" });
    await expect(
      service.unshare(BUSINESS, file.id, STRANGER, { kind: "user", id: STRANGER })
    ).rejects.toMatchObject({ reason: "not_found" });
    await expect(service.shares(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("refuses a stranger who shares nothing with the File, without saying it exists", async () => {
    const file = await uploaded();
    await service.share(BUSINESS, file.id, OWNER, { kind: "user", id: "principal-c" });

    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("lists what has been shared with the reader, and never what they already own", async () => {
    const mine = await uploaded();
    const theirs = await service.upload({
      businessId: BUSINESS,
      ownerPrincipalId: STRANGER,
      filename: "theirs.png",
      claimedMediaType: "image/png",
      declaredBytes: PNG_BYTES.byteLength,
      body: (async function* () {
        yield PNG_BYTES;
      })(),
    });
    await service.share(BUSINESS, theirs.id, STRANGER, { kind: "user", id: OWNER });

    const page = await service.listSharedWithMe(BUSINESS, OWNER, 10);

    expect(page.files.map((f) => f.id)).toEqual([theirs.id]);
    expect(page.files.map((f) => f.id)).not.toContain(mine.id);
  });

  it("lists archived Files only for their owner", async () => {
    const mine = await uploaded();
    const theirs = await service.upload({
      businessId: BUSINESS,
      ownerPrincipalId: STRANGER,
      filename: "theirs.png",
      claimedMediaType: "image/png",
      declaredBytes: PNG_BYTES.byteLength,
      body: (async function* () {
        yield PNG_BYTES;
      })(),
    });
    await service.archive(BUSINESS, mine.id, OWNER, mine.revision);
    await service.archive(BUSINESS, theirs.id, STRANGER, theirs.revision);

    const page = await service.listArchivedPage(BUSINESS, OWNER, 10);

    expect(page.files.map((file) => file.id)).toEqual([mine.id]);
    expect(page.shareCounts).toEqual(new Map());
  });

  it("treats sharing twice as one share, so a revoke is not half a revoke", async () => {
    const file = await uploaded();

    await service.share(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER });
    await service.share(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER });

    expect(await service.shares(BUSINESS, file.id, OWNER)).toHaveLength(1);
    await service.unshare(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER });
    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("refuses to share a File with its own owner rather than storing a no-op row", async () => {
    const file = await uploaded();

    await expect(
      service.share(BUSINESS, file.id, OWNER, { kind: "user", id: OWNER })
    ).rejects.toMatchObject({ reason: "invalid_share" });
  });

  it("never lets a Role named like a person stand in for that person, or the reverse", async () => {
    const file = await uploaded();
    // A Role whose id happens to equal the stranger's principal id. Matching on the id alone would
    // silently hand every Role-holder a File shared with one person, and vice versa.
    await service.share(BUSINESS, file.id, OWNER, { kind: "role", id: STRANGER });

    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });

    const second = await uploaded();
    await service.share(BUSINESS, second.id, OWNER, { kind: "user", id: "support" });
    roles.set(STRANGER, ["support"]);

    await expect(service.read(BUSINESS, second.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("shares nothing when no Role port is wired, rather than everything", async () => {
    const withoutRoles = new FileService({
      repo,
      blobs: new FileSystemBlobPort(root),
      newId: () => randomUUID(),
    });
    const file = await uploaded();
    await service.share(BUSINESS, file.id, OWNER, { kind: "role", id: "support" });
    roles.set(STRANGER, ["support"]);

    await expect(withoutRoles.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });
});

describe("deleting a File", () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  let root: string;
  let blobs: FileSystemBlobPort;
  let repo: MemoryFileRepo;
  let service: FileService;
  let roles: Map<string, string[]>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tulip-files-delete-"));
    blobs = new FileSystemBlobPort(root);
    repo = new MemoryFileRepo();
    roles = new Map();
    service = new FileService({
      repo,
      blobs,
      newId: () => randomUUID(),
      rolesOf: async (_business, principalId) => roles.get(principalId) ?? [],
    });
  });

  afterEach(async () => {
    await rm(root, PURGE);
  });

  async function uploaded(owner = OWNER, filename = "shot.png") {
    return await service.upload({
      businessId: BUSINESS,
      ownerPrincipalId: owner,
      filename,
      claimedMediaType: "image/png",
      declaredBytes: PNG_BYTES.byteLength,
      body: (async function* () {
        yield PNG_BYTES;
      })(),
    });
  }

  async function archived(file: FileRecord) {
    return await service.archive(BUSINESS, file.id, file.ownerPrincipalId, file.revision);
  }

  it("requires archive before permanent deletion", async () => {
    const file = await uploaded();

    await expect(service.delete(BUSINESS, file.id, OWNER, file.revision)).rejects.toMatchObject({
      reason: "invalid_state",
    });
  });

  it("removes the row and schedules every version blob for cleanup", async () => {
    const file = await archived(await uploaded());
    expect((await blobs.head(file.blob)) !== null).toBe(true);

    await service.delete(BUSINESS, file.id, OWNER, file.revision);

    expect(await repo.get(BUSINESS, file.id)).toBeNull();
    expect((await blobs.head(file.blob)) !== null).toBe(false);
  });

  it("hands back what was destroyed, so the deletion can be audited", async () => {
    const file = await archived(await uploaded(OWNER, "invoice.png"));

    const destroyed = await service.delete(BUSINESS, file.id, OWNER, file.revision);

    expect(destroyed.filename).toBe("invoice.png");
    expect(destroyed.sizeBytes).toBe(PNG_BYTES.byteLength);
    expect(destroyed.blob.hash).toBe(file.blob.hash);
  });

  it("refuses a stranger, and leaves the File intact", async () => {
    const file = await archived(await uploaded());

    await expect(service.delete(BUSINESS, file.id, STRANGER, file.revision)).rejects.toMatchObject({
      reason: "not_found",
    });
    expect(await repo.get(BUSINESS, file.id)).not.toBeNull();
  });

  it("refuses someone the File was shared with", async () => {
    const file = await uploaded();
    await service.share(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER });
    expect((await service.read(BUSINESS, file.id, STRANGER)).id).toBe(file.id);
    const archivedFile = await archived(file);

    await expect(
      service.delete(BUSINESS, file.id, STRANGER, archivedFile.revision)
    ).rejects.toMatchObject({ reason: "not_found" });
    expect((await blobs.head(file.blob)) !== null).toBe(true);
  });

  it("takes every share with it, so a recipient loses access immediately", async () => {
    const file = await uploaded();
    await service.share(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER });
    const archivedFile = await archived(file);

    await service.delete(BUSINESS, file.id, OWNER, archivedFile.revision);

    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
    expect(await repo.listShares(BUSINESS, file.id)).toHaveLength(0);
  });

  it("keeps the bytes of a byte-identical File someone else still owns", async () => {
    const mine = await archived(await uploaded(OWNER));
    const theirs = await uploaded(STRANGER);
    expect(theirs.blob.hash).toBe(mine.blob.hash);

    await service.delete(BUSINESS, mine.id, OWNER, mine.revision);

    expect((await blobs.head(theirs.blob)) !== null).toBe(true);
    expect((await service.read(BUSINESS, theirs.id, STRANGER)).id).toBe(theirs.id);
  });

  it("is idempotent enough to refuse a second attempt rather than delete twice", async () => {
    const file = await archived(await uploaded());
    await service.delete(BUSINESS, file.id, OWNER, file.revision);

    await expect(service.delete(BUSINESS, file.id, OWNER, file.revision)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("keeps durable cleanup work when the blob store is temporarily unavailable", async () => {
    const file = await archived(await uploaded());
    const failing = new FileService({
      repo,
      blobs: {
        put: (body, type) => blobs.put(body, type),
        get: (ref, range) => blobs.get(ref, range),
        head: (ref) => blobs.head(ref),
        delete: async () => {
          throw new Error("bucket said no");
        },
      },
      newId: () => randomUUID(),
    });

    await expect(failing.delete(BUSINESS, file.id, OWNER, file.revision)).resolves.toMatchObject({
      id: file.id,
    });
    expect(repo.cleanup).toEqual([file.blob]);
    expect(await blobs.head(file.blob)).not.toBeNull();
  });
});

describe("File lifecycle", () => {
  let root: string;
  let blobs: FileSystemBlobPort;
  let repo: MemoryFileRepo;
  let service: FileService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tulip-files-lifecycle-"));
    blobs = new FileSystemBlobPort(root);
    repo = new MemoryFileRepo();
    service = new FileService({ repo, blobs, newId: () => randomUUID() });
  });

  afterEach(async () => {
    await rm(root, PURGE);
  });

  async function uploadText(content = "one") {
    const bytes = new TextEncoder().encode(content);
    return await service.upload({
      businessId: BUSINESS,
      ownerPrincipalId: OWNER,
      filename: "notes.txt",
      claimedMediaType: "text/plain",
      declaredBytes: bytes.byteLength,
      body: once(bytes),
    });
  }

  it("replaces content with an immutable same-format version", async () => {
    const original = await uploadText();
    const bytes = new TextEncoder().encode("two");

    const replaced = await service.replace({
      businessId: BUSINESS,
      ownerPrincipalId: OWNER,
      fileId: original.id,
      expectedRevision: original.revision,
      claimedMediaType: "text/plain",
      declaredBytes: bytes.byteLength,
      body: once(bytes),
    });

    expect(replaced.revision).toBe(2);
    expect(repo.versions.map((version) => version.reason)).toEqual(["created", "replaced"]);
    expect(repo.versions[0]?.blob.hash).not.toBe(repo.versions[1]?.blob.hash);
  });

  it("refuses a stale replacement before consuming its body", async () => {
    const original = await uploadText();
    let consumed = false;
    const body = (async function* () {
      consumed = true;
      yield new TextEncoder().encode("two");
    })();

    await expect(
      service.replace({
        businessId: BUSINESS,
        ownerPrincipalId: OWNER,
        fileId: original.id,
        expectedRevision: original.revision + 1,
        claimedMediaType: "text/plain",
        declaredBytes: 3,
        body,
      })
    ).rejects.toMatchObject({ reason: "conflict" });
    expect(consumed).toBe(false);
  });

  it("refuses a replacement whose verified format differs", async () => {
    const original = await uploadText();

    await expect(
      service.replace({
        businessId: BUSINESS,
        ownerPrincipalId: OWNER,
        fileId: original.id,
        expectedRevision: original.revision,
        claimedMediaType: "image/png",
        declaredBytes: PNG.byteLength,
        body: once(PNG),
      })
    ).rejects.toMatchObject({ reason: "format_mismatch" });
    expect(repo.versions).toHaveLength(1);
  });

  it("restores old content as a new version without writing another blob", async () => {
    let puts = 0;
    const counting = new FileService({
      repo,
      blobs: {
        put: async (body, type) => {
          puts += 1;
          return await blobs.put(body, type);
        },
        get: (ref, range) => blobs.get(ref, range),
        head: (ref) => blobs.head(ref),
        delete: (ref) => blobs.delete(ref),
      },
      newId: () => randomUUID(),
    });
    const originalBytes = new TextEncoder().encode("one");
    const original = await counting.upload({
      businessId: BUSINESS,
      ownerPrincipalId: OWNER,
      filename: "notes.txt",
      claimedMediaType: "text/plain",
      declaredBytes: originalBytes.byteLength,
      body: once(originalBytes),
    });
    const replacementBytes = new TextEncoder().encode("two");
    const replaced = await counting.replace({
      businessId: BUSINESS,
      ownerPrincipalId: OWNER,
      fileId: original.id,
      expectedRevision: original.revision,
      claimedMediaType: "text/plain",
      declaredBytes: replacementBytes.byteLength,
      body: once(replacementBytes),
    });

    const restored = await counting.restoreVersion({
      businessId: BUSINESS,
      ownerPrincipalId: OWNER,
      fileId: original.id,
      versionId: original.currentVersionId,
      expectedRevision: replaced.revision,
    });

    expect(puts).toBe(2);
    expect(restored.blob).toEqual(original.blob);
    expect(repo.versions.at(-1)).toMatchObject({
      reason: "restored",
      restoredFromVersionId: original.currentVersionId,
    });
  });

  it("hides archived Files from discovery and new attachments but keeps direct reads", async () => {
    const file = await uploadText();
    const archived = await service.archive(BUSINESS, file.id, OWNER, file.revision);

    await expect(service.read(BUSINESS, file.id, OWNER)).resolves.toMatchObject({ id: file.id });
    expect(await service.list(BUSINESS, OWNER, 10)).toEqual([]);
    expect(await service.search(BUSINESS, OWNER, "notes", 10)).toEqual([]);
    expect((await service.presentFor(BUSINESS, OWNER, [file.id])).has(file.id)).toBe(true);
    await expect(service.readForAttachment(BUSINESS, file.id, OWNER)).rejects.toMatchObject({
      reason: "not_found",
    });
    await expect(
      service.share(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER })
    ).rejects.toMatchObject({ reason: "invalid_state" });
    await expect(
      service.replace({
        businessId: BUSINESS,
        ownerPrincipalId: OWNER,
        fileId: file.id,
        expectedRevision: archived.revision,
        claimedMediaType: "text/plain",
        declaredBytes: 3,
        body: once(new TextEncoder().encode("two")),
      })
    ).rejects.toMatchObject({ reason: "invalid_state" });

    const restored = await service.restoreArchive(BUSINESS, file.id, OWNER, archived.revision);
    expect(restored.archivedAt).toBeNull();
    expect(await service.list(BUSINESS, OWNER, 10)).toHaveLength(1);
  });
});

describe("FileService.presentFor", () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  let root: string;
  let repo: MemoryFileRepo;
  let service: FileService;
  let roles: Map<string, string[]>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tulip-files-present-"));
    repo = new MemoryFileRepo();
    roles = new Map();
    service = new FileService({
      repo,
      blobs: new FileSystemBlobPort(root),
      newId: () => randomUUID(),
      rolesOf: async (_business, principalId) => roles.get(principalId) ?? [],
    });
  });

  afterEach(async () => {
    await rm(root, PURGE);
  });

  async function uploaded(owner = OWNER) {
    return await service.upload({
      businessId: BUSINESS,
      ownerPrincipalId: owner,
      filename: "shot.png",
      claimedMediaType: "image/png",
      declaredBytes: PNG_BYTES.byteLength,
      body: (async function* () {
        yield PNG_BYTES;
      })(),
    });
  }

  it("reports the caller's own Files as present and a destroyed one as absent", async () => {
    const kept = await uploaded();
    const gone = await uploaded();
    const archived = await service.archive(BUSINESS, gone.id, OWNER, gone.revision);
    await service.delete(BUSINESS, gone.id, OWNER, archived.revision);

    const present = await service.presentFor(BUSINESS, OWNER, [kept.id, gone.id]);

    expect(present.has(kept.id)).toBe(true);
    expect(present.has(gone.id)).toBe(false);
  });

  it("reports a File that exists but is not shared with the caller as absent", async () => {
    const file = await uploaded();

    expect((await service.presentFor(BUSINESS, STRANGER, [file.id])).has(file.id)).toBe(false);

    await service.share(BUSINESS, file.id, OWNER, { kind: "user", id: STRANGER });

    expect((await service.presentFor(BUSINESS, STRANGER, [file.id])).has(file.id)).toBe(true);
  });

  it("honours a Role share, so a transcript matches what the reader may open", async () => {
    const file = await uploaded();
    roles.set(STRANGER, ["role-support"]);
    await service.share(BUSINESS, file.id, OWNER, { kind: "role", id: "role-support" });

    expect((await service.presentFor(BUSINESS, STRANGER, [file.id])).has(file.id)).toBe(true);

    roles.set(STRANGER, []);

    expect((await service.presentFor(BUSINESS, STRANGER, [file.id])).has(file.id)).toBe(false);
  });

  it("asks nothing at all for an empty list", async () => {
    let asked = 0;
    const counting = new FileService({
      repo: {
        ...repo,
        readableIds: async (
          ...args: Parameters<MemoryFileRepo["readableIds"]>
        ): Promise<readonly string[]> => {
          asked += 1;
          return await repo.readableIds(...args);
        },
      } as unknown as MemoryFileRepo,
      blobs: new FileSystemBlobPort(root),
      newId: () => randomUUID(),
    });

    expect((await counting.presentFor(BUSINESS, OWNER, [])).size).toBe(0);
    expect(asked).toBe(0);
  });
});

describe("FileService.generate", () => {
  let root: string;
  let repo: MemoryFileRepo;
  let service: FileService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tulip-files-"));
    repo = new MemoryFileRepo();
    service = new FileService({
      repo,
      blobs: new FileSystemBlobPort(root),
      newId: () => randomUUID(),
    });
  });

  afterEach(async () => {
    await rm(root, PURGE);
  });

  const generate = (overrides: Partial<Parameters<FileService["generate"]>[0]> = {}) =>
    service.generate({
      businessId: BUSINESS,
      filename: "quarterly-summary",
      format: "pdf",
      content: "# Quarterly\n\nRevenue rose.",
      readableBy: { kind: "user", id: OWNER },
      ...overrides,
    });

  const recordingAccess: FileOwnershipPort["accessFor"] = async (ownership, principalId) => {
    const owns = ownership.owners.some(
      (owner) => owner.kind === "principal" && owner.principalId === principalId
    );
    return owns
      ? { levels: ["view", "use", "edit"], canManageOwnership: true }
      : { levels: [], canManageOwnership: false };
  };

  const recordingOwnership = (records: Map<string, FileAssetOwnership>): FileOwnershipPort => ({
    ...listingAnswers(records, recordingAccess),
    async createPersonal(businessId, fileId, principalId) {
      records.set(fileId, {
        businessId,
        assetType: "file",
        assetId: fileId,
        owners: [{ kind: "principal", principalId, principalKind: "user" }],
        shares: [],
        revision: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    },
    async get(_businessId, fileId) {
      return records.get(fileId);
    },
    accessFor: recordingAccess,
    async consumeDestructiveApproval() {},
  });

  it("does not hand a generated File to everyone in the business", async () => {
    // Business ownership is represented as the "Everyone" Team, which every active user joins by
    // trigger, so the record a generated File acquires must name the one person who asked for it.
    // A Team owner here would override the audience `generatedAudience` computed and hand a
    // Routine's output to the whole company.
    const records = new Map<string, FileAssetOwnership>();
    service = new FileService({
      repo,
      blobs: new FileSystemBlobPort(root),
      newId: () => randomUUID(),
      ownership: recordingOwnership(records),
    });

    const file = await generate();

    expect(records.get(file.id)?.owners).toEqual([
      { kind: "principal", principalId: OWNER, principalKind: "user" },
    ]);
    await expect(service.read(BUSINESS, file.id, OWNER)).resolves.toMatchObject({ id: file.id });
    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("lets the person who asked for it manage it", async () => {
    // Nothing else can. A File whose owner field says `business` names no person, so with no
    // record the document it produced could never be shared, archived, deleted, or indexed.
    const records = new Map<string, FileAssetOwnership>();
    service = new FileService({
      repo,
      blobs: new FileSystemBlobPort(root),
      newId: () => randomUUID(),
      ownership: recordingOwnership(records),
    });

    const file = await generate();

    await expect(service.canManage(BUSINESS, file.id, OWNER)).resolves.toBe(true);
    await expect(service.canManage(BUSINESS, file.id, STRANGER)).resolves.toBe(false);
  });

  it("leaves an unattended Run's output to the business, so it outlives the scheduler", async () => {
    const records = new Map<string, FileAssetOwnership>();
    service = new FileService({
      repo,
      blobs: new FileSystemBlobPort(root),
      newId: () => randomUUID(),
      ownership: recordingOwnership(records),
    });

    const file = await generate({ readableBy: undefined, authoredByRoutineId: "routine-nightly" });

    expect(file.ownerPrincipalId).toBe(BUSINESS_PRINCIPAL_ID);
    expect(records.has(file.id)).toBe(false);
  });

  it("writes a real document and marks it machine-made", async () => {
    const file = await generate();
    expect(file.origin).toBe("generated");
    expect(file.mediaType).toBe("application/pdf");
    expect(file.filename).toBe("quarterly-summary.pdf");
    expect(file.sizeBytes).toBeGreaterThan(0);
    const stored = await service.content(BUSINESS, file.id, OWNER);
    let total = 0;
    for await (const chunk of stored.body) total += chunk.byteLength;
    expect(total).toBe(file.sizeBytes);
  });

  it("belongs to whoever asked for it, and to the business when nobody did", async () => {
    // Somebody has to be able to share, archive and index a document, and `business` names no
    // person. An unattended Run has no requester, so its output stays the business's and survives
    // the offboarding of whoever scheduled it.
    expect((await generate()).ownerPrincipalId).toBe(OWNER);
    const unattended = await generate({ readableBy: undefined });
    expect(unattended.ownerPrincipalId).toBe(BUSINESS_PRINCIPAL_ID);
  });

  it("lets the person who asked read it, and nobody else", async () => {
    const file = await generate();
    await expect(service.read(BUSINESS, file.id, OWNER)).resolves.toMatchObject({ id: file.id });
    await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("makes a File nobody can read when nobody is named, rather than one everybody can", async () => {
    const file = await generate({ readableBy: undefined });
    expect(repo.shares.filter((share) => share.fileId === file.id)).toEqual([]);
    await expect(service.read(BUSINESS, file.id, OWNER)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("records the Run that authored it, so a generated File can be traced back", async () => {
    const file = await generate({ sourceRunId: "run_7" });
    expect(file.sourceRunId).toBe("run_7");
  });

  it("returns the same File when the same Tool occurrence is retried", async () => {
    const first = await generate({ sourceRunId: "run_7", sourceToolCallId: "call_7" });
    const retried = await generate({ sourceRunId: "run_7", sourceToolCallId: "call_7" });
    expect(retried.id).toBe(first.id);
    expect(repo.rows.filter((row) => row.sourceToolCallId === "call_7")).toHaveLength(1);
  });

  it("records Routine creator provenance for an automatically saved output", async () => {
    const file = await generate({
      sourceRunId: "run_8",
      sourceToolCallId: "call_8",
      authoredByAgentId: "agent-finance",
      authoredByRoutineId: "routine-month-end",
    });
    const version = repo.versions.find((candidate) => candidate.fileId === file.id);
    expect(version).toMatchObject({
      actorKind: "routine",
      actorId: "routine-month-end",
      sourceRunId: "run_8",
    });
  });

  it("leaves the Run empty when the Agent was not running one", async () => {
    expect((await generate()).sourceRunId).toBeNull();
  });

  it("does not double an extension the Agent already got right", async () => {
    const file = await generate({ filename: "report.pdf" });
    expect(file.filename).toBe("report.pdf");
  });

  it("stores the plain formats byte for byte", async () => {
    const file = await generate({ format: "csv", filename: "rows", content: "a,b\n1,2\n" });
    expect(file.mediaType).toBe("text/csv");
    expect(file.filename).toBe("rows.csv");
    const { body } = await service.content(BUSINESS, file.id, OWNER);
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("a,b\n1,2\n");
  });

  it("refuses before writing anything when the render refuses", async () => {
    await expect(generate({ content: "   " })).rejects.toMatchObject({ reason: "empty" });
    // The row is what makes a File exist. Nothing reached storage, so nothing needs compensating.
    expect(repo.rows).toEqual([]);
  });

  describe("when the authoring Agent belongs to a team", () => {
    const HR_AGENT = "agent-hr";
    const MANAGER = "principal-manager";

    // The HR Agent and the HR manager both hold `hr-team`; the stranger holds nothing.
    const withRoles = () =>
      new FileService({
        repo,
        blobs: new FileSystemBlobPort(root),
        newId: () => randomUUID(),
        rolesOf: async (_businessId, principalId) =>
          principalId === HR_AGENT || principalId === MANAGER ? ["hr-team"] : [],
      });

    const byHrAgent = () =>
      withRoles().generate({
        businessId: BUSINESS,
        filename: "headcount",
        format: "pdf",
        content: "# Headcount\n\nTwelve.",
        readableBy: { kind: "user", id: OWNER },
        authoredByAgentId: HR_AGENT,
      });

    it("shares what it wrote with that team as well as with whoever asked", async () => {
      const file = await byHrAgent();
      expect(
        repo.shares
          .filter((share) => share.fileId === file.id)
          .map((share) => `${share.kind}:${share.id}`)
          .sort()
        // The requester owns it outright, so the only share worth writing is the team's.
      ).toEqual(["role:hr-team"]);
    });

    it("lets the rest of that team open it, and still refuses everybody else", async () => {
      // The whole point: an HR Agent's report reaches HR without anyone forwarding it by hand,
      // while a stranger sees the same 404 they saw before the Agent had a team at all.
      const service = withRoles();
      const file = await byHrAgent();
      await expect(service.read(BUSINESS, file.id, MANAGER)).resolves.toMatchObject({
        id: file.id,
      });
      await expect(service.read(BUSINESS, file.id, OWNER)).resolves.toMatchObject({ id: file.id });
      await expect(service.read(BUSINESS, file.id, STRANGER)).rejects.toMatchObject({
        reason: "not_found",
      });
    });

    describe("FileService generated drafts", () => {
      let root: string;
      let repo: MemoryFileRepo;
      let service: FileService;

      beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "tulip-file-drafts-"));
        repo = new MemoryFileRepo();
        service = new FileService({
          repo,
          blobs: new FileSystemBlobPort(root),
          newId: () => randomUUID(),
          rolesOf: async (_businessId, principalId) =>
            principalId === "agent-hr" ? ["hr-team"] : [],
        });
      });

      afterEach(async () => {
        await rm(root, PURGE);
      });

      const draft = () =>
        service.generateDraft({
          businessId: BUSINESS,
          creatorPrincipalId: OWNER,
          filename: "headcount",
          format: "json",
          content: '{"count":12}',
          authoredByAgentId: "agent-hr",
          sourceRunId: "run-draft",
          sourceToolCallId: "call-draft",
        });

      it("keeps a Chat output outside the File library until Save File", async () => {
        const created = await draft();
        expect(repo.rows).toHaveLength(0);
        expect(created.filename).toBe("headcount.json");
        expect(await service.draftContent(BUSINESS, created.id, OWNER)).toMatchObject({
          draft: { id: created.id },
        });
        await expect(service.draftContent(BUSINESS, created.id, STRANGER)).rejects.toMatchObject({
          reason: "not_found",
        });
      });

      it("deduplicates a retried Tool occurrence", async () => {
        const first = await draft();
        const retried = await draft();
        expect(retried.id).toBe(first.id);
        expect(repo.drafts).toHaveLength(1);
      });

      it("gives the saved draft to the person who saved it", async () => {
        // The saver is also given personal ownership, so a row owned by the business contradicts
        // it: the File would sit under "Shared with me", report Business as its owner, and hide
        // sharing, replacement, versions and deletion from the one person who owns it.
        const created = await draft();
        const saved = await service.saveDraft(BUSINESS, created.id, OWNER);
        expect(saved.ownerPrincipalId).toBe(OWNER);
      });

      it("saves once and preserves the requester and Agent Role audience", async () => {
        const created = await draft();
        const saved = await service.saveDraft(BUSINESS, created.id, OWNER);
        const retried = await service.saveDraft(BUSINESS, created.id, OWNER);
        expect(retried.id).toBe(saved.id);
        expect(repo.rows).toHaveLength(1);
        expect(saved.sourceRunId).toBe("run-draft");
        expect(saved.sourceToolCallId).toBe("call-draft");
        expect(
          repo.shares
            .filter((share) => share.fileId === saved.id)
            .map((share) => `${share.kind}:${share.id}`)
            .sort()
          // The requester owns it outright, so the only share worth writing is the team's.
        ).toEqual(["role:hr-team"]);
      });

      it("finishes a save that failed after the row but before its ownership", async () => {
        // The draft now names a File, so a naive retry returns it and never replays what the first
        // attempt did not reach — leaving the document owned by nobody for good.
        const records = new Map<string, FileAssetOwnership>();
        let failures = 1;
        service = new FileService({
          repo,
          blobs: new FileSystemBlobPort(root),
          newId: () => randomUUID(),
          rolesOf: async (_businessId, principalId) =>
            principalId === "agent-hr" ? ["hr-team"] : [],
          ownership: {
            ...recordingOwnership(records),
            async createPersonal(businessId, fileId, principalId) {
              if (failures-- > 0) throw new Error("ownership store unavailable");
              await recordingOwnership(records).createPersonal(businessId, fileId, principalId);
            },
          },
        });
        const created = await draft();
        await expect(service.saveDraft(BUSINESS, created.id, OWNER)).rejects.toThrow();

        const saved = await service.saveDraft(BUSINESS, created.id, OWNER);

        expect(records.get(saved.id)?.owners).toEqual([
          { kind: "principal", principalId: OWNER, principalKind: "user" },
        ]);
        expect(
          repo.shares.filter((share) => share.fileId === saved.id).map((share) => share.id)
        ).toEqual(["hr-team"]);
      });

      it("expires an unsaved draft onto durable blob cleanup", async () => {
        const created = await draft();
        repo.drafts[0] = { ...created, expiresAt: new Date(0) };
        expect(await service.cleanupExpiredDrafts()).toBe(1);
        expect(repo.drafts).toHaveLength(0);
        expect(repo.cleanup).toEqual([created.blob]);
      });
    });

    it("stops sharing with the team the moment the Agent is removed from the Role", async () => {
      // Resolved per read with no derived state, so a revoked Role is felt on the next request
      // rather than at the next reindex.
      const file = await byHrAgent();
      const afterRemoval = new FileService({
        repo,
        blobs: new FileSystemBlobPort(root),
        newId: () => randomUUID(),
        rolesOf: async () => [],
      });
      await expect(afterRemoval.read(BUSINESS, file.id, MANAGER)).rejects.toMatchObject({
        reason: "not_found",
      });
    });

    it("writes nothing at all when resolving the Agent's Roles fails", async () => {
      // The audience is resolved before the blob and the row, so a failure costs no compensating
      // delete and can never leave a File that exists but nobody can reach.
      const before = repo.rows.length;
      const failing = new FileService({
        repo,
        blobs: new FileSystemBlobPort(root),
        newId: () => randomUUID(),
        rolesOf: async () => {
          throw new Error("role store unavailable");
        },
      });
      await expect(
        failing.generate({
          businessId: BUSINESS,
          filename: "headcount",
          format: "pdf",
          content: "# Headcount",
          readableBy: { kind: "user", id: OWNER },
          authoredByAgentId: HR_AGENT,
        })
      ).rejects.toThrow("role store unavailable");
      expect(repo.rows.length).toBe(before);
    });
  });
});
