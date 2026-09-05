/**
 * The ordered upload pipeline, and the read that pairs with it.
 *
 * The order is the design, not an implementation detail:
 *
 *   authorize → reject on declared length → stream to storage → sniff the real type →
 *   reject if disallowed → write the row
 *
 * Checking the declared length *before* the stream opens is the difference between a rejected
 * upload costing a header and costing a full storage write plus a compensating delete. Sniffing
 * after the write is unavoidable — the bytes are the evidence, and buffering the whole object to
 * sniff first would defeat streaming — so the write is compensated when the sniff refuses. The
 * row lands last, which is what makes "a File row implies its bytes are present" true.
 */

import type { TeamAssetAccessLevel, TeamAssetOwner } from "@tulipfarm/schema";
import type { BlobPort, BlobRef } from "@tulipfarm/storage";
import { generatedAudience, roleGrantees } from "./audience";
import { boundStoredImage, type ImageBoundPolicy } from "./bound";
import { normalizeFilename } from "./filename";
import {
  BUSINESS_PRINCIPAL_ID,
  isAllowedMediaType,
  isImageMediaType,
  MAX_FILE_BYTES,
} from "./limits";
import { extensionForFormat, type RenderFormat, renderDocument } from "./render";
import {
  encodeFileCursor,
  type FileCursor,
  type FileDraftRecord,
  type FileFolderRecord,
  type FileGrantee,
  type FileReader,
  type FileRecord,
  type FileRepo,
  type FileShare,
  type FileVersionRecord,
  type NewFile,
} from "./repo";
import { resolveMediaType, SNIFF_BYTES } from "./sniff";

/**
 * Why the File domain refused.
 *
 * There is deliberately no "not authorized" reason. A caller who may not read a File is told
 * `not_found`, the same answer a File that does not exist gets, so that a probe cannot use the
 * difference to learn which File ids are real.
 */
export type UploadRejection =
  | "too_large"
  | "empty"
  | "disallowed_type"
  | "format_mismatch"
  | "image_too_large"
  | "not_found"
  | "invalid_share"
  | "invalid_folder"
  | "conflict"
  | "invalid_state";

export class FileError extends Error {
  constructor(
    readonly reason: UploadRejection,
    message: string
  ) {
    super(message);
    this.name = "FileError";
  }
}

export interface UploadRequest {
  readonly businessId: string;
  readonly ownerPrincipalId: string;
  readonly folderId?: string;
  readonly filename: string;
  readonly claimedMediaType: string;
  /** What the client says the body weighs. Refused here before any byte is written. */
  readonly declaredBytes: number;
  readonly body: AsyncIterable<Uint8Array>;
}

export interface GenerateRequest {
  readonly businessId: string;
  readonly filename: string;
  readonly format: RenderFormat;
  /** Markdown for `pdf`; structured formats are validated. Rendered before anything is written. */
  readonly content: string;
  readonly title?: string;
  /**
   * Given read access as the File lands.
   *
   * Passed rather than inferred because the service does not know who asked — and a machine-made
   * File that nobody can read is the same as one that was never made.
   */
  readonly readableBy?: FileGrantee;
  /** The Agent writing this File, whose Roles join the audience. See {@link generatedAudience}. */
  readonly authoredByAgentId?: string;
  /** The Run authoring this File, so the library can say where a generated File came from. */
  readonly sourceRunId?: string;
  /** The stable Tool occurrence, so a retried dispatch returns the same File. */
  readonly sourceToolCallId?: string;
  /** Present for unattended Routine generation, which owns creator provenance over the Agent. */
  readonly authoredByRoutineId?: string;
  /**
   * The Run subject, consulted for Roles only when no person asked. See {@link generatedAudience}.
   */
  readonly subjectPrincipalId?: string;
}

export interface GenerateDraftRequest {
  readonly businessId: string;
  readonly creatorPrincipalId: string;
  readonly filename: string;
  readonly format: RenderFormat;
  readonly content: string;
  readonly title?: string;
  readonly authoredByAgentId?: string;
  readonly sourceRunId: string;
  readonly sourceToolCallId: string;
}

export const FILE_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ReplaceFileRequest extends Omit<UploadRequest, "filename"> {
  readonly fileId: string;
  readonly expectedRevision: number;
}

export interface RestoreFileVersionRequest {
  readonly businessId: string;
  readonly fileId: string;
  readonly versionId: string;
  readonly ownerPrincipalId: string;
  readonly expectedRevision: number;
}

export interface FileAssetOwnership {
  readonly businessId: string;
  readonly assetType: "file";
  readonly assetId: string;
  readonly owners: readonly TeamAssetOwner[];
  readonly shares: readonly {
    readonly teamId: string;
    readonly access: TeamAssetAccessLevel;
  }[];
  readonly revision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface FileAssetAccess {
  readonly levels: readonly TeamAssetAccessLevel[];
  readonly canManageOwnership: boolean;
}

export interface FileOwnershipPort {
  createPersonal(businessId: string, fileId: string, principalId: string): Promise<void>;
  get(businessId: string, fileId: string): Promise<FileAssetOwnership | undefined>;
  accessFor(
    ownership: FileAssetOwnership,
    principalId: string,
    principalKind: string
  ): Promise<FileAssetAccess>;
  consumeDestructiveApproval(
    ownership: FileAssetOwnership,
    action: "archive" | "delete",
    operationId: string | undefined
  ): Promise<void>;
}

export interface FileServiceDeps {
  readonly repo: FileRepo;
  readonly blobs: BlobPort;
  readonly newId: () => string;
  /**
   * The business's image-bounding policy, read per upload rather than held.
   *
   * Read fresh so that turning downscaling on in `soul.yaml` takes effect on the next upload
   * without restarting anything. Absent means the default policy.
   */
  readonly imagePolicy?: () => ImageBoundPolicy | Promise<ImageBoundPolicy>;
  /**
   * Which Roles a reader currently holds, asked on every read a share has to justify.
   *
   * A port rather than a dependency because the one correct answer — direct assignments plus
   * group-held Roles, minus anything expired — already exists in the authority resolver, and a
   * second implementation of it here is precisely how a File would stay readable to someone the
   * Role no longer contains. Absent means no Role-based sharing, never "all Roles". Asked of an
   * authoring Agent's Principal too, since the question is the same for either kind.
   */
  readonly rolesOf?: (businessId: string, principalId: string) => Promise<readonly string[]>;
  /**
   * Shared Team ownership projected into this service's existing read and mutation gates.
   *
   * The implementation must use the shared ownership decision. This package consumes the result;
   * it never grows a second Team evaluator.
   */
  readonly ownership?: FileOwnershipPort;
}

function normalizeFolderName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (
    normalized.length === 0 ||
    normalized.length > 120 ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new FileError("invalid_folder", "folder name must be between 1 and 120 characters");
  }
  return normalized;
}

/**
 * Reads the first {@link SNIFF_BYTES} while passing every chunk through unchanged.
 *
 * The sniff sample has to be taken from the same pass that writes, because the body is a stream
 * that can only be consumed once. Enforcing the byte ceiling here too is what makes the limit
 * real: a client can declare any length it likes, so the declared check is a courtesy and this
 * one is the control.
 */
/**
 * How much of the body is buffered for inspection.
 *
 * A single JPEG APP1 EXIF segment is spec-capped at 64 KiB, and a JPEG states its dimensions in a
 * frame header sitting behind however much of it the camera wrote — routinely past the first 512
 * bytes. Reading the size from the head is what lets an oversized image be refused without
 * decoding the whole bitmap.
 *
 * Taken as a maximum rather than written as one number so this can only ever widen the sniffer's
 * own minimum, never silently undercut it if that minimum grows.
 */
const HEAD_BYTES = Math.max(SNIFF_BYTES, 65_536);

function tee(
  body: AsyncIterable<Uint8Array>,
  sample: { bytes: Uint8Array; size: number }
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const head: Uint8Array[] = [];
      let headLength = 0;
      for await (const chunk of body) {
        sample.size += chunk.byteLength;
        if (sample.size > MAX_FILE_BYTES) {
          throw new FileError("too_large", `upload exceeds ${MAX_FILE_BYTES} bytes`);
        }
        if (headLength < HEAD_BYTES) {
          head.push(chunk);
          headLength += chunk.byteLength;
          sample.bytes = concat(head, Math.min(headLength, HEAD_BYTES));
        }
        yield chunk;
      }
    },
  };
}

function concat(chunks: readonly Uint8Array[], limit: number): Uint8Array {
  const out = new Uint8Array(limit);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= limit) break;
    const slice = chunk.subarray(0, limit - offset);
    out.set(slice, offset);
    offset += slice.byteLength;
  }
  return out;
}

/** Keeps the name honest about what the bytes are, without doubling a suffix the Agent got right. */
function withExtension(filename: string, format: RenderFormat): string {
  const extension = extensionForFormat(format);
  return filename.toLowerCase().endsWith(extension) ? filename : `${filename}${extension}`;
}

function once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}

export class FileService {
  constructor(private readonly deps: FileServiceDeps) {}

  private async storeUpload(
    request: Pick<UploadRequest, "declaredBytes" | "body" | "claimedMediaType">
  ): Promise<{
    ref: BlobRef;
    mediaType: string;
    sizeBytes: number;
  }> {
    if (request.declaredBytes > MAX_FILE_BYTES) {
      throw new FileError("too_large", `upload exceeds ${MAX_FILE_BYTES} bytes`);
    }

    const sample = { bytes: new Uint8Array(0), size: 0 };
    // A mid-stream refusal from `tee` propagates out of `put`, which leaves nothing behind: the
    // store only publishes an object once the whole body has been written.
    const ref = await this.deps.blobs.put(tee(request.body, sample), request.claimedMediaType);

    if (sample.size === 0) {
      await this.discard(ref);
      throw new FileError("empty", "upload carried no bytes");
    }

    const mediaType = resolveMediaType(sample.bytes, request.claimedMediaType);
    if (mediaType === null || !isAllowedMediaType(mediaType)) {
      await this.discard(ref);
      throw new FileError(
        "disallowed_type",
        `${request.claimedMediaType} is not a type this instance accepts`
      );
    }

    const imagePolicy = await this.deps.imagePolicy?.();
    const shouldBoundImage =
      isImageMediaType(mediaType) &&
      imagePolicy !== undefined &&
      (imagePolicy.maxImageDimension !== undefined || imagePolicy.downscaleImages === true);
    const bounded = shouldBoundImage
      ? await boundStoredImage(this.deps.blobs, ref, mediaType, sample, imagePolicy, (orphan) =>
          this.discard(orphan)
        )
      : { ref, sizeBytes: sample.size };
    if (bounded.refused !== undefined) {
      throw new FileError("image_too_large", bounded.refused);
    }
    return { ref: bounded.ref, mediaType, sizeBytes: bounded.sizeBytes };
  }

  async upload(request: UploadRequest): Promise<FileRecord> {
    if (request.folderId !== undefined) {
      await this.requireOwnedFolder(request.businessId, request.folderId, request.ownerPrincipalId);
    }
    const stored = await this.storeUpload(request);
    const file = await this.withLiveBlob(stored.ref, (repo) =>
      repo.create({
        id: this.deps.newId(),
        businessId: request.businessId,
        ownerPrincipalId: request.ownerPrincipalId,
        ...(request.folderId === undefined ? {} : { folderId: request.folderId }),
        filename: normalizeFilename(request.filename),
        mediaType: stored.mediaType,
        claimedMediaType: request.claimedMediaType,
        sizeBytes: stored.sizeBytes,
        blob: stored.ref,
      })
    );
    await this.deps.ownership?.createPersonal(
      request.businessId,
      file.id,
      request.ownerPrincipalId
    );
    return file;
  }

  async createFolder(
    businessId: string,
    ownerPrincipalId: string,
    name: string,
    parentId?: string
  ): Promise<FileFolderRecord> {
    if (parentId !== undefined) {
      await this.requireOwnedFolder(businessId, parentId, ownerPrincipalId);
    }
    const folder = await this.deps.repo.createFolder({
      id: this.deps.newId(),
      businessId,
      ownerPrincipalId,
      name: normalizeFolderName(name),
      ...(parentId === undefined ? {} : { parentId }),
    });
    if (folder !== null) return folder;
    throw new FileError("invalid_folder", "a folder with that name already exists here");
  }

  async folders(businessId: string, ownerPrincipalId: string): Promise<FileFolderRecord[]> {
    return await this.deps.repo.listFolders(businessId, ownerPrincipalId);
  }

  async renameFolder(
    businessId: string,
    id: string,
    ownerPrincipalId: string,
    name: string
  ): Promise<FileFolderRecord> {
    await this.requireOwnedFolder(businessId, id, ownerPrincipalId);
    const renamed = await this.deps.repo.renameFolder(
      businessId,
      id,
      ownerPrincipalId,
      normalizeFolderName(name)
    );
    if (renamed !== null) return renamed;
    throw new FileError("invalid_folder", "a folder with that name already exists here");
  }

  async deleteFolder(businessId: string, id: string, ownerPrincipalId: string): Promise<void> {
    await this.requireOwnedFolder(businessId, id, ownerPrincipalId);
    const removed = await this.deps.repo.deleteFolder(businessId, id, ownerPrincipalId);
    if (!removed) {
      throw new FileError(
        "invalid_folder",
        "move or delete what this folder holds before deleting it"
      );
    }
  }

  async move(
    businessId: string,
    id: string,
    ownerPrincipalId: string,
    folderId: string | null,
    expectedRevision: number
  ): Promise<FileRecord> {
    const file = await this.readActiveAsEditor(businessId, id, ownerPrincipalId);
    if (file.revision !== expectedRevision) {
      throw new FileError("conflict", "the File changed before it could be moved");
    }
    if (file.folderId === folderId) return file;
    if (folderId !== null) {
      await this.requireOwnedFolder(businessId, folderId, ownerPrincipalId);
    }
    const moved = await this.deps.repo.moveFile(
      businessId,
      id,
      ownerPrincipalId,
      folderId,
      expectedRevision
    );
    if (moved !== null) return moved;
    throw new FileError("conflict", "the File changed before it could be moved");
  }

  private async requireOwnedFolder(
    businessId: string,
    id: string,
    ownerPrincipalId: string
  ): Promise<FileFolderRecord> {
    const folder = await this.deps.repo.getFolder(businessId, id);
    if (folder === null || folder.ownerPrincipalId !== ownerPrincipalId) {
      throw new FileError("not_found", `folder ${id} does not exist`);
    }
    return folder;
  }

  async replace(request: ReplaceFileRequest): Promise<FileRecord> {
    const current = await this.readActiveAsEditor(
      request.businessId,
      request.fileId,
      request.ownerPrincipalId
    );
    if (current.revision !== request.expectedRevision) {
      throw new FileError("conflict", "the File changed before it could be replaced");
    }

    const stored = await this.storeUpload(request);
    if (stored.mediaType !== current.mediaType) {
      await this.discard(stored.ref);
      throw new FileError(
        "format_mismatch",
        `replacement must remain ${current.mediaType}, received ${stored.mediaType}`
      );
    }

    const replaced = await this.withLiveBlob(stored.ref, (repo) =>
      repo.replaceVersion({
        id: this.deps.newId(),
        businessId: request.businessId,
        fileId: request.fileId,
        expectedRevision: request.expectedRevision,
        mediaType: stored.mediaType,
        claimedMediaType: request.claimedMediaType,
        sizeBytes: stored.sizeBytes,
        blob: stored.ref,
        actorKind: "principal",
        actorId: request.ownerPrincipalId,
        reason: "replaced",
      })
    );
    if (replaced !== null) return replaced;

    await this.discard(stored.ref);
    throw new FileError("conflict", "the File changed before it could be replaced");
  }

  async restoreVersion(request: RestoreFileVersionRequest): Promise<FileRecord> {
    const current = await this.readActiveAsEditor(
      request.businessId,
      request.fileId,
      request.ownerPrincipalId
    );
    if (current.revision !== request.expectedRevision) {
      throw new FileError("conflict", "the File changed before the version could be restored");
    }
    const source = await this.deps.repo.getVersion(
      request.businessId,
      request.fileId,
      request.versionId
    );
    if (source === null) {
      throw new FileError("not_found", `file version ${request.versionId} does not exist`);
    }
    const restored = await this.deps.repo.restoreVersion({
      id: this.deps.newId(),
      businessId: request.businessId,
      fileId: request.fileId,
      versionId: request.versionId,
      expectedRevision: request.expectedRevision,
      actorKind: "principal",
      actorId: request.ownerPrincipalId,
    });
    if (restored !== null) return restored;
    throw new FileError("conflict", "the File changed before the version could be restored");
  }

  /**
   * Writes a File an Agent authored: render first, then store, then share.
   *
   * The order matters for the same reason the upload pipeline's does. Rendering is the step that
   * can refuse — over the input cap, over the page cap, past the deadline — and doing it before
   * any byte reaches storage means a refusal costs nothing to compensate. The share lands last so
   * that a File is never readable before its bytes are.
   *
   * The media type is not sniffed. Unlike an upload, the bytes were produced here from a format
   * this service chose, so the claim and the content have the same author and a sniff would be
   * asking this process to confirm its own output.
   */
  async generate(request: GenerateRequest): Promise<FileRecord> {
    const rendered = await renderDocument({
      format: request.format,
      content: request.content,
      ...(request.title === undefined ? {} : { title: request.title }),
    });
    if (rendered.bytes.byteLength > MAX_FILE_BYTES) {
      throw new FileError("too_large", `rendered document exceeds ${MAX_FILE_BYTES} bytes`);
    }

    // Resolved before a byte is written: a Role lookup that throws must cost no compensating delete.
    const audience = await generatedAudience(request, this.deps.rolesOf);

    // The person who asked for the document owns it. Without an owner a generated File is readable
    // by its audience and manageable by nobody: no share, no archive, no delete, and no way to put
    // it into Knowledge, since every one of those asks who owns it and `business` names no person.
    const requester =
      request.readableBy?.kind === "user" && request.readableBy.id !== BUSINESS_PRINCIPAL_ID
        ? request.readableBy.id
        : null;

    const filename = withExtension(normalizeFilename(request.filename), request.format);
    const ref = await this.deps.blobs.put(once(rendered.bytes), rendered.mediaType);
    const newFile: NewFile = {
      id: this.deps.newId(),
      businessId: request.businessId,
      ownerPrincipalId: requester ?? BUSINESS_PRINCIPAL_ID,
      filename,
      mediaType: rendered.mediaType,
      claimedMediaType: rendered.mediaType,
      sizeBytes: rendered.bytes.byteLength,
      blob: ref,
      origin: "generated",
      versionActorKind: request.authoredByRoutineId
        ? ("routine" as const)
        : request.authoredByAgentId
          ? ("agent" as const)
          : ("system" as const),
      versionActorId:
        request.authoredByRoutineId ?? request.authoredByAgentId ?? BUSINESS_PRINCIPAL_ID,
      ...(request.sourceRunId === undefined ? {} : { sourceRunId: request.sourceRunId }),
      ...(request.sourceToolCallId === undefined
        ? {}
        : { sourceToolCallId: request.sourceToolCallId }),
    };
    const created = await this.withLiveBlob(ref, async (repo) =>
      request.sourceRunId === undefined || request.sourceToolCallId === undefined
        ? { file: await repo.create(newFile), created: true }
        : await repo.createGenerated(newFile)
    );
    if (!created.created && created.file.blob.hash !== ref.hash) await this.discard(ref);
    // Personal, never business. Business ownership is represented as the "Everyone" Team, which
    // every active user joins, so recording one here would hand a Routine's output to the whole
    // company and silently override the audience `generatedAudience` just computed. An unattended
    // Run has no requester and so records nothing: `read` then falls through to the shares below,
    // which are that audience, exactly.
    if (requester !== null) {
      await this.deps.ownership?.createPersonal(request.businessId, created.file.id, requester);
    }

    for (const grantee of audience) {
      // The owner reads it by owning it, so a share naming them is a row that grants nothing.
      if (grantee.kind === "user" && grantee.id === created.file.ownerPrincipalId) continue;
      await this.deps.repo.share(
        request.businessId,
        created.file.id,
        grantee,
        BUSINESS_PRINCIPAL_ID
      );
    }
    return created.file;
  }

  /** Renders a Chat output into an expiring, caller-bound draft rather than the File library. */
  async generateDraft(request: GenerateDraftRequest): Promise<FileDraftRecord> {
    const rendered = await renderDocument({
      format: request.format,
      content: request.content,
      ...(request.title === undefined ? {} : { title: request.title }),
    });
    if (rendered.bytes.byteLength > MAX_FILE_BYTES) {
      throw new FileError("too_large", `rendered document exceeds ${MAX_FILE_BYTES} bytes`);
    }

    const ref = await this.deps.blobs.put(once(rendered.bytes), rendered.mediaType);
    const created = await this.withLiveBlob(ref, (repo) =>
      repo.createDraft({
        id: this.deps.newId(),
        businessId: request.businessId,
        creatorPrincipalId: request.creatorPrincipalId,
        filename: withExtension(normalizeFilename(request.filename), request.format),
        mediaType: rendered.mediaType,
        sizeBytes: rendered.bytes.byteLength,
        blob: ref,
        ...(request.authoredByAgentId === undefined
          ? {}
          : { authoredByAgentId: request.authoredByAgentId }),
        sourceRunId: request.sourceRunId,
        sourceToolCallId: request.sourceToolCallId,
        expiresAt: new Date(Date.now() + FILE_DRAFT_TTL_MS),
      })
    );
    if (!created.created && created.draft.blob.hash !== ref.hash) await this.discard(ref);
    return created.draft;
  }

  async draftContent(
    businessId: string,
    id: string,
    principalId: string
  ): Promise<{ draft: FileDraftRecord; body: AsyncIterable<Uint8Array> }> {
    const draft = await this.deps.repo.getDraft(businessId, id, principalId);
    if (draft === null || draft.expiresAt.getTime() <= Date.now()) {
      throw new FileError("not_found", `file draft ${id} does not exist`);
    }
    return { draft, body: await this.deps.blobs.get(draft.blob) };
  }

  /** Promotes one caller-bound draft into the File library. Repeating the save returns one File. */
  async saveDraft(businessId: string, id: string, principalId: string): Promise<FileRecord> {
    const draft = await this.deps.repo.getDraft(businessId, id, principalId);
    if (draft === null) {
      throw new FileError("not_found", `file draft ${id} does not exist`);
    }
    const saved =
      draft.savedFileId === null ? null : await this.deps.repo.get(businessId, draft.savedFileId);
    if (saved === null && draft.expiresAt.getTime() <= Date.now()) {
      throw new FileError("not_found", `file draft ${id} does not exist`);
    }
    const audience = await generatedAudience(
      {
        businessId,
        readableBy: { kind: "user", id: principalId },
        ...(draft.authoredByAgentId === null ? {} : { authoredByAgentId: draft.authoredByAgentId }),
      },
      this.deps.rolesOf
    );
    // A retry lands here whenever the first save failed after the row but before its ownership or
    // its shares, and returning early on the File alone would strand the draft half-saved: owned
    // by nobody, or readable by the Roles it was meant for and nobody else. Both writes are
    // idempotent, so the second attempt finishes what the first started rather than repeating it.
    const file =
      saved ?? (await this.deps.repo.saveDraft(businessId, id, principalId, this.deps.newId()));
    if (file === null) throw new FileError("not_found", `file draft ${id} does not exist`);
    await this.deps.ownership?.createPersonal(businessId, file.id, principalId);
    for (const grantee of audience) {
      // The saver owns it, so a share naming them is a row that grants nothing.
      if (grantee.kind === "user" && grantee.id === file.ownerPrincipalId) continue;
      await this.deps.repo.share(businessId, file.id, grantee, BUSINESS_PRINCIPAL_ID);
    }
    return file;
  }

  /** Moves expired draft blobs onto the same durable cleanup path deleted File versions use. */
  async cleanupExpiredDrafts(limit = 25): Promise<number> {
    return await this.deps.repo.expireDrafts(limit);
  }

  /**
   * Applies the business's image-bounding policy before the row lands.
   *
   * Bounding happens at upload rather than when a File is put into a prompt because this is the
   * only moment the person who chose the file is present to be told. Refusing mid-Turn would
   * report a limit about a file they picked minutes ago, and only after they had already asked a
   * question about it.
   *
   * The stored bytes are the bounded ones, so a File is within the limit once and stays that way
   * — and what the person sees back in the message is exactly what the model was given.
   */
  /**
   * The identities a read can be justified by: the reader, and every Role they hold right now.
   *
   * Resolved per read, never cached. That is the entire mechanism behind immediate revocation —
   * there is no derived state to invalidate, so removing a share or removing someone from a Role
   * is felt by the very next request.
   */
  private async granteesFor(
    businessId: string,
    principalId: string
  ): Promise<readonly FileGrantee[]> {
    const roles = await this.deps.rolesOf?.(businessId, principalId);
    return [{ kind: "user", id: principalId }, ...roleGrantees(roles ?? [])];
  }

  /**
   * Reads a File's metadata, refusing a Principal who neither owns it nor has been shared it.
   *
   * The ACL is consulted freshly on every request rather than cached, which is why this feature
   * has no presigned URLs: a presigned URL is an unrevocable bearer capability, and revocation
   * here has to take effect on the very next read.
   */
  async read(businessId: string, id: string, principalId: string): Promise<FileRecord> {
    const [file, ownership] = await Promise.all([
      this.deps.repo.get(businessId, id),
      this.deps.ownership?.get(businessId, id),
    ]);
    if (file !== null && ownership !== undefined) {
      const access = await this.deps.ownership?.accessFor(ownership, principalId, "user");
      if (access?.levels.includes("view")) return file;
    } else if (file !== null && file.ownerPrincipalId === principalId) {
      return file;
    }

    // Both remaining outcomes are a 404, so both must cost the same. Short-circuiting on a missing
    // File would make "exists but not yours" the slower of two identical answers, and a caller
    // that can time the difference has the existence oracle the identical message denies them.
    // The owner's own read is above this and unaffected: its answer already differs.
    const [shares, grantees] = await Promise.all([
      this.deps.repo.listShares(businessId, id),
      this.granteesFor(businessId, principalId),
    ]);
    const permitted = shares.some((share) =>
      grantees.some((held) => held.kind === share.kind && held.id === share.id)
    );
    if (file !== null && permitted) return file;

    throw new FileError("not_found", `file ${id} does not exist`);
  }

  async readForAttachment(
    businessId: string,
    id: string,
    principalId: string
  ): Promise<FileRecord> {
    const file = await this.read(businessId, id, principalId);
    if (file.archivedAt !== null) {
      throw new FileError("not_found", `file ${id} does not exist`);
    }
    return file;
  }

  /**
   * Shares a File. Only its owner may, and a recipient is never given that power — which is what
   * stops a share from propagating past the one person who chose to grant it.
   */
  async share(
    businessId: string,
    id: string,
    ownerPrincipalId: string,
    grantee: FileGrantee
  ): Promise<void> {
    const file = await this.readActiveAsOwner(businessId, id, ownerPrincipalId);
    if (grantee.kind === "user" && grantee.id === file.ownerPrincipalId) {
      throw new FileError("invalid_share", "a File is already readable by its owner");
    }
    await this.deps.repo.share(businessId, id, grantee, ownerPrincipalId);
  }

  /** Revokes a share. Answers whether one existed, so a caller can tell a revoke from a no-op. */
  async unshare(
    businessId: string,
    id: string,
    ownerPrincipalId: string,
    grantee: FileGrantee
  ): Promise<boolean> {
    await this.readActiveAsOwner(businessId, id, ownerPrincipalId);
    return await this.deps.repo.unshare(businessId, id, grantee);
  }

  /** Who a File is shared with. Only its owner may ask; a recipient cannot enumerate the others. */
  async shares(businessId: string, id: string, ownerPrincipalId: string): Promise<FileShare[]> {
    await this.readAsOwner(businessId, id, ownerPrincipalId);
    return await this.deps.repo.listShares(businessId, id);
  }

  /**
   * Whether this Principal may share, replace, archive or delete the File.
   *
   * Asked of the service rather than answered by comparing `ownerPrincipalId`, because a File can
   * be owned by a Team and its owner field then names nobody who holds that power.
   */
  async canManage(businessId: string, id: string, principalId: string): Promise<boolean> {
    try {
      await this.readAsOwner(businessId, id, principalId);
      return true;
    } catch (error) {
      if (error instanceof FileError && error.reason === "not_found") return false;
      throw error;
    }
  }

  /**
   * Everyone who may read this File right now: its owner, plus every grantee of a share.
   *
   * The list Knowledge restricts an indexed File's Page to, which is why it is derived here rather
   * than assembled by the caller. A second answer to "who may read this File" is how a File's
   * passage stays searchable by somebody its share no longer names.
   */
  async readers(
    businessId: string,
    id: string,
    ownerPrincipalId: string
  ): Promise<readonly FileReader[]> {
    await this.readAsOwner(businessId, id, ownerPrincipalId);
    return await this.currentReaders(businessId, id);
  }

  /**
   * The same list, asked without an owner to ask it on behalf of.
   *
   * Not an authorization check and never reachable from a request: it exists for the server-side
   * reconciler that re-points a File's Knowledge Page after its owners changed. That reconciler
   * runs *after* the change, and the change may be the very one that took the acting Principal's
   * management rights away — an owning Team removing itself, or a company admin overriding an
   * ownership it was never part of. Asking as them would fail exactly when the Page most needs
   * narrowing, so the reconciler does not ask as anyone.
   */
  async currentReaders(businessId: string, id: string): Promise<readonly FileReader[]> {
    const [file, shares, ownership] = await Promise.all([
      this.deps.repo.get(businessId, id),
      this.deps.repo.listShares(businessId, id),
      this.deps.ownership?.get(businessId, id),
    ]);
    if (file === null) throw new FileError("not_found", `file ${id} does not exist`);
    const readers: FileReader[] = [];
    if (ownership === undefined) {
      readers.push({ kind: "user", id: file.ownerPrincipalId });
    } else {
      for (const owner of ownership.owners) {
        readers.push(
          owner.kind === "team"
            ? { kind: "team", id: owner.teamId }
            : { kind: "user", id: owner.principalId }
        );
      }
      for (const share of ownership.shares) {
        readers.push({ kind: "team", id: share.teamId });
      }
    }
    for (const share of shares) readers.push({ kind: share.kind, id: share.id });
    return [
      ...new Map(readers.map((reader) => [`${reader.kind}\u0000${reader.id}`, reader])).values(),
    ];
  }

  /** One page of Files shared with the caller, excluding the ones they already own. */
  async listSharedWithMe(
    businessId: string,
    principalId: string,
    limit: number,
    after?: FileCursor
  ): Promise<{ files: FileRecord[]; nextCursor: string | null }> {
    const grantees = await this.granteesFor(businessId, principalId);
    const page = await this.deps.repo.listSharedWith(
      businessId,
      principalId,
      grantees,
      limit + 1,
      after
    );
    const files = page.slice(0, limit);
    const last = files.at(-1);
    return { files, nextCursor: page.length > limit && last ? encodeFileCursor(last) : null };
  }

  async shareCountsFor(
    businessId: string,
    principalId: string,
    files: readonly FileRecord[]
  ): Promise<Map<string, number>> {
    const ownedIds = files
      .filter((file) => file.ownerPrincipalId === principalId)
      .map((file) => file.id);
    return await this.deps.repo.countShares(businessId, ownedIds);
  }

  /**
   * The File, if this Principal owns it.
   *
   * Every act of sharing goes through here rather than through `read`, because `read` now also
   * admits recipients — and a recipient who could re-share would make revocation meaningless.
   */
  /**
   * Records the owner's request that this File be in Knowledge, and reports who may read it.
   *
   * Owner-only, and the flag lands before the caller enqueues anything: a job that starts before
   * the request is durable could not tell a live opt-in from one already withdrawn.
   */
  async requestKnowledge(
    businessId: string,
    id: string,
    ownerPrincipalId: string
  ): Promise<readonly FileReader[]> {
    await this.readActiveAsEditor(businessId, id, ownerPrincipalId);
    await this.deps.repo.setKnowledgeRequested(businessId, id, new Date());
    return await this.readers(businessId, id, ownerPrincipalId);
  }

  /**
   * Withdraws that request, so an index job still in flight stops rather than finishing.
   *
   * Cleared *before* the caller removes the Page, never after: reversed, a job that read the flag
   * in between would write a Page nothing is left to remove it.
   */
  async clearKnowledgeRequest(
    businessId: string,
    id: string,
    ownerPrincipalId: string
  ): Promise<void> {
    await this.readActiveAsEditor(businessId, id, ownerPrincipalId);
    await this.deps.repo.setKnowledgeRequested(businessId, id, null);
  }

  /** Whether the owner's request to index this File still stands, for the job that acts on it. */
  async knowledgeRequested(businessId: string, id: string): Promise<boolean> {
    const file = await this.deps.repo.get(businessId, id);
    return file?.archivedAt === null && file.knowledgeRequestedAt != null;
  }

  private async readAsOwner(
    businessId: string,
    id: string,
    principalId: string
  ): Promise<FileRecord> {
    const [file, ownership] = await Promise.all([
      this.deps.repo.get(businessId, id),
      this.deps.ownership?.get(businessId, id),
    ]);
    if (file === null) {
      throw new FileError("not_found", `file ${id} does not exist`);
    }
    if (ownership !== undefined) {
      const access = await this.deps.ownership?.accessFor(ownership, principalId, "user");
      if (access?.canManageOwnership) return file;
      throw new FileError("not_found", `file ${id} does not exist`);
    }
    if (file.ownerPrincipalId !== principalId) {
      throw new FileError("not_found", `file ${id} does not exist`);
    }
    return file;
  }

  private async readAsEditor(
    businessId: string,
    id: string,
    principalId: string
  ): Promise<FileRecord> {
    const [file, ownership] = await Promise.all([
      this.deps.repo.get(businessId, id),
      this.deps.ownership?.get(businessId, id),
    ]);
    if (file === null) throw new FileError("not_found", `file ${id} does not exist`);
    if (ownership !== undefined) {
      const access = await this.deps.ownership?.accessFor(ownership, principalId, "user");
      if (access?.levels.includes("edit")) return file;
      throw new FileError("not_found", `file ${id} does not exist`);
    }
    if (file.ownerPrincipalId !== principalId) {
      throw new FileError("not_found", `file ${id} does not exist`);
    }
    return file;
  }

  private async readActiveAsOwner(
    businessId: string,
    id: string,
    principalId: string
  ): Promise<FileRecord> {
    const file = await this.readAsOwner(businessId, id, principalId);
    if (file.archivedAt !== null) {
      throw new FileError("invalid_state", "archived Files are read-only");
    }
    return file;
  }

  private async readActiveAsEditor(
    businessId: string,
    id: string,
    principalId: string
  ): Promise<FileRecord> {
    const file = await this.readAsEditor(businessId, id, principalId);
    if (file.archivedAt !== null) {
      throw new FileError("invalid_state", "archived Files are read-only");
    }
    return file;
  }

  async content(
    businessId: string,
    id: string,
    principalId: string
  ): Promise<{ file: FileRecord; body: AsyncIterable<Uint8Array> }> {
    const file = await this.read(businessId, id, principalId);
    const body = await this.deps.blobs.get(file.blob);
    return { file, body };
  }

  async versionContent(
    businessId: string,
    id: string,
    versionId: string,
    ownerPrincipalId: string
  ): Promise<{ file: FileRecord; version: FileVersionRecord; body: AsyncIterable<Uint8Array> }> {
    const file = await this.readAsEditor(businessId, id, ownerPrincipalId);
    const version = await this.deps.repo.getVersion(businessId, id, versionId);
    if (version === null) {
      throw new FileError("not_found", `file version ${versionId} does not exist`);
    }
    return { file, version, body: await this.deps.blobs.get(version.blob) };
  }

  async archive(
    businessId: string,
    id: string,
    ownerPrincipalId: string,
    expectedRevision: number,
    beforeArchive?: () => Promise<void>,
    ownershipOperationId?: string
  ): Promise<FileRecord> {
    const file = await this.readAsOwner(businessId, id, ownerPrincipalId);
    if (file.archivedAt !== null) throw new FileError("invalid_state", "File is already archived");
    if (file.revision !== expectedRevision) {
      throw new FileError("conflict", "the File changed before it could be archived");
    }
    const ownership = await this.deps.ownership?.get(businessId, id);
    if (ownership !== undefined) {
      await this.deps.ownership?.consumeDestructiveApproval(
        ownership,
        "archive",
        ownershipOperationId
      );
    }
    await beforeArchive?.();
    const archived = await this.deps.repo.setArchived(businessId, id, expectedRevision, true);
    if (archived !== null) return archived;
    throw new FileError("conflict", "the File changed before it could be archived");
  }

  async restoreArchive(
    businessId: string,
    id: string,
    ownerPrincipalId: string,
    expectedRevision: number
  ): Promise<FileRecord> {
    const file = await this.readAsOwner(businessId, id, ownerPrincipalId);
    if (file.archivedAt === null) throw new FileError("invalid_state", "File is not archived");
    if (file.revision !== expectedRevision) {
      throw new FileError("conflict", "the File changed before it could be restored");
    }
    const restored = await this.deps.repo.setArchived(businessId, id, expectedRevision, false);
    if (restored !== null) return restored;
    throw new FileError("conflict", "the File changed before it could be restored");
  }

  async delete(
    businessId: string,
    id: string,
    ownerPrincipalId: string,
    expectedRevision: number,
    ownershipOperationId?: string
  ): Promise<FileRecord> {
    const file = await this.readAsOwner(businessId, id, ownerPrincipalId);
    if (file.archivedAt === null) {
      throw new FileError("invalid_state", "a File must be archived before permanent deletion");
    }
    if (file.revision !== expectedRevision) {
      throw new FileError("conflict", "the File changed before it could be deleted");
    }
    const ownership = await this.deps.ownership?.get(businessId, id);
    if (ownership !== undefined) {
      await this.deps.ownership?.consumeDestructiveApproval(
        ownership,
        "delete",
        ownershipOperationId
      );
    }
    const deleted = await this.deps.repo.deleteArchived(businessId, id, expectedRevision);
    if (deleted === null) {
      throw new FileError("conflict", "the File changed before it could be deleted");
    }
    await this.cleanupBlobs().catch(() => undefined);
    return deleted;
  }

  async cleanupBlobs(owner?: string, limit = 25, leaseMs = 60_000): Promise<number> {
    const leaseOwner = owner ?? this.deps.newId();
    const claimed = await this.deps.repo.claimBlobCleanup(leaseOwner, limit, leaseMs);
    let failures = 0;
    for (const cleanup of claimed) {
      try {
        await this.deps.repo.withBlobLock(cleanup.blob.hash, async (repo) => {
          if (await repo.anyReferencesBlob(cleanup.blob.hash)) {
            await repo.retryBlobCleanup(
              cleanup.blob,
              leaseOwner,
              "blob remains referenced by a File version"
            );
            return;
          }
          await this.deps.blobs.delete(cleanup.blob);
          await repo.completeBlobCleanup(cleanup.blob, leaseOwner);
        });
      } catch (error) {
        failures += 1;
        await this.deps.repo.retryBlobCleanup(
          cleanup.blob,
          leaseOwner,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    if (failures > 0) throw new Error(`${failures} File blob cleanup task(s) failed`);
    return claimed.length;
  }

  /**
   * Which of `ids` this Principal can still read, for a caller rendering references it did not
   * fetch — a transcript, most of all.
   *
   * "Still there" and "still mine to see" are deliberately one answer. A File whose share was
   * revoked is as absent to this reader as one that was destroyed, and reporting them differently
   * would hand back the existence oracle the identical 404 in `read` is there to deny.
   */
  async presentFor(
    businessId: string,
    principalId: string,
    ids: readonly string[]
  ): Promise<ReadonlySet<string>> {
    if (ids.length === 0) return new Set();
    const grantees = await this.granteesFor(businessId, principalId);
    return new Set(await this.deps.repo.readableIds(businessId, principalId, grantees, ids));
  }

  async search(
    businessId: string,
    principalId: string,
    query: string,
    limit: number
  ): Promise<FileRecord[]> {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length === 0) return [];
    const grantees = await this.granteesFor(businessId, principalId);
    return await this.deps.repo.searchReadable(
      businessId,
      principalId,
      grantees,
      normalizedQuery,
      limit
    );
  }

  async versions(
    businessId: string,
    id: string,
    ownerPrincipalId: string
  ): Promise<FileVersionRecord[]> {
    await this.readAsEditor(businessId, id, ownerPrincipalId);
    return await this.deps.repo.listVersions(businessId, id);
  }

  async list(
    businessId: string,
    principalId: string,
    limit: number,
    after?: FileCursor
  ): Promise<FileRecord[]> {
    return await this.deps.repo.listByOwner(businessId, principalId, limit, after);
  }

  /**
   * One page of the caller's own Files, with the cursor that resumes after it.
   *
   * Reads one row past the page so "is there more" costs nothing extra, and hands back the cursor
   * already encoded — a caller should never have to know that the sort key is `(created_at, id)`.
   */
  async listPage(
    businessId: string,
    principalId: string,
    limit: number,
    after?: FileCursor
  ): Promise<{ files: FileRecord[]; nextCursor: string | null; shareCounts: Map<string, number> }> {
    const page = await this.list(businessId, principalId, limit + 1, after);
    const files = page.slice(0, limit);
    const last = files.at(-1);
    return {
      files,
      nextCursor: page.length > limit && last ? encodeFileCursor(last) : null,
      shareCounts: await this.deps.repo.countShares(
        businessId,
        files.map((file) => file.id)
      ),
    };
  }

  /** One page of the caller's archived Files. Recipients do not discover archived Files here. */
  async listArchivedPage(
    businessId: string,
    principalId: string,
    limit: number,
    after?: FileCursor
  ): Promise<{ files: FileRecord[]; nextCursor: string | null; shareCounts: Map<string, number> }> {
    const page = await this.deps.repo.listArchivedByOwner(
      businessId,
      principalId,
      limit + 1,
      after
    );
    const files = page.slice(0, limit);
    const last = files.at(-1);
    return {
      files,
      nextCursor: page.length > limit && last ? encodeFileCursor(last) : null,
      shareCounts: await this.deps.repo.countShares(
        businessId,
        files.map((file) => file.id)
      ),
    };
  }

  /**
   * Note that these Files were sent in a Conversation, so the library can say where one came from.
   *
   * Best-effort and deliberately not awaited into the send path's success: a message that was
   * accepted must not be reported as failed because a provenance note could not be written.
   */
  async noteSentIn(
    businessId: string,
    fileIds: readonly string[],
    conversationId: string
  ): Promise<void> {
    await this.deps.repo.recordFirstConversation(businessId, fileIds, conversationId);
  }

  /**
   * Removes bytes written for an upload that was then refused.
   *
   * A failure here is swallowed: the caller is already returning a rejection, and a leaked object
   * with no row pointing at it is strictly less harmful than replacing a clear "your file was
   * refused" with a storage error the client cannot act on.
   */
  private async discard(ref: BlobRef): Promise<void> {
    try {
      await this.deps.repo.withBlobLock(ref.hash, async (repo) => {
        if (await repo.anyReferencesBlob(ref.hash)) return;
        await this.deps.blobs.delete(ref);
      });
    } catch {
      // Intentionally ignored; see above.
    }
  }

  private async withLiveBlob<T>(ref: BlobRef, task: (repo: FileRepo) => Promise<T>): Promise<T> {
    return await this.deps.repo.withBlobLock(ref.hash, async (repo) => {
      if ((await this.deps.blobs.head(ref)) === null) {
        throw new Error("stored File bytes disappeared before they could be referenced");
      }
      return await task(repo);
    });
  }
}
