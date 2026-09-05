/**
 * Turning the file ids a Chat request claims into Message parts it is allowed to carry.
 *
 * A client sends ids. An id is a claim, not a capability: nothing about receiving one proves the
 * sender may read it. Every id is therefore resolved against the caller's own authority here, and
 * only the Files that resolve become parts. An id that does not resolve is refused rather than
 * dropped, because silently sending a message without the image someone attached is worse than
 * telling them it did not go.
 */

import type { MessageFilePart } from "@tulipfarm/schema";
import { MAX_FILES_PER_MESSAGE } from "./limits";
import { FileError, type FileService } from "./service";

export interface AttachmentRefusal {
  readonly status: 400 | 404 | 503;
  readonly error: string;
}

export function isAttachmentRefusal(
  value: readonly MessageFilePart[] | AttachmentRefusal
): value is AttachmentRefusal {
  return !Array.isArray(value);
}

export async function resolveAttachments(
  files: FileService | undefined,
  businessId: string,
  principalId: string,
  fileIds: readonly string[] | undefined
): Promise<readonly MessageFilePart[] | AttachmentRefusal> {
  if (fileIds === undefined || fileIds.length === 0) return [];
  if (files === undefined) {
    return { status: 503, error: "file storage is not configured on this instance" };
  }
  if (fileIds.length > MAX_FILES_PER_MESSAGE) {
    return { status: 400, error: `a message may carry at most ${MAX_FILES_PER_MESSAGE} files` };
  }

  const parts: MessageFilePart[] = [];
  for (const fileId of fileIds) {
    try {
      const file = await files.readForAttachment(businessId, fileId, principalId);
      parts.push({
        type: "file",
        fileId: file.id,
        mediaType: file.mediaType,
        name: file.filename,
      });
    } catch (error) {
      if (error instanceof FileError)
        return { status: 404, error: `file ${fileId} is not available` };
      throw error;
    }
  }
  return parts;
}
