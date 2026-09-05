import { MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE, uploadMediaType } from "@tulipfarm/files/limits";
import { modalityForMediaType } from "@tulipfarm/schema/message-content";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAcceptedModalities,
  UploadCancelled,
  type UploadedFile,
  uploadFile,
} from "~/lib/files";

/**
 * The files staged on the composer for the next message.
 *
 * Uploads start the moment a file is chosen rather than on send, so the bytes are usually already
 * across by the time someone finishes typing. That is also why an attachment carries a local id:
 * it exists in the UI before the server has given it a real one.
 *
 * The limits are re-checked here purely to fail fast and legibly. The server enforces them for
 * real — a browser check is a courtesy, never a control.
 */
export interface Attachment {
  readonly localId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly status: "uploading" | "ready" | "error";
  readonly progress: number;
  readonly fileId?: string;
  readonly error?: string;
}

/** How to get the content in anyway, per modality, when no model can read the file itself. */
const INSTEAD: Record<string, string> = {
  image: "describe what it shows in your message",
  document: "paste the relevant text into your message",
};

/**
 * Why `file` cannot be staged, or `null` to stage it.
 *
 * `accepted` is the union of input modalities across configured models, or `undefined` while that
 * is still unknown. Every check here is a courtesy that fails fast and legibly; the server
 * enforces all of them for real, so this stays permissive whenever it cannot be certain.
 */
export function describeRejection(
  file: File,
  staged: number,
  accepted: readonly string[] | undefined
): string | null {
  if (staged >= MAX_FILES_PER_MESSAGE) {
    return `You can attach at most ${MAX_FILES_PER_MESSAGE} files to one message.`;
  }
  if (file.size > MAX_FILE_BYTES) {
    return `${file.name} is larger than ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MB.`;
  }
  // An empty `type` means the browser did not recognise the format. When the filename does not
  // name it either, there is nothing to judge, so defer to the server's byte sniffer rather than
  // refusing something it might well accept.
  const mediaType = uploadMediaType(file.type, file.name);
  if (mediaType === null) {
    if (file.type === "") return null;
    return `${file.name} is not a supported file type.`;
  }
  if (accepted !== undefined) {
    const modality = modalityForMediaType(mediaType);
    if (modality !== "text" && !accepted.includes(modality)) {
      const plural = `${modality}s`;
      const instead = INSTEAD[modality] ?? "include the content in your message";
      return `No configured model can read ${plural}, so ${file.name} would be ignored. Ask an administrator to enable one, or ${instead}.`;
    }
  }
  return null;
}

export function useAttachments() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const cancels = useRef(new Map<string, () => void>());
  // Undefined until known, and left undefined if the fetch fails: see `describeRejection`.
  const [accepted, setAccepted] = useState<readonly string[] | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    fetchAcceptedModalities(controller.signal)
      .then(setAccepted)
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const update = useCallback((localId: string, patch: Partial<Attachment>) => {
    setAttachments((current) =>
      current.map((item) => (item.localId === localId ? { ...item, ...patch } : item))
    );
  }, []);

  const add = useCallback(
    (files: readonly File[]) => {
      setAttachments((current) => {
        const next = [...current];
        for (const file of files) {
          const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const rejection = describeRejection(file, next.length, accepted);
          if (rejection !== null) {
            next.push({
              localId,
              name: file.name,
              mediaType: file.type,
              sizeBytes: file.size,
              status: "error",
              progress: 0,
              error: rejection,
            });
            continue;
          }
          next.push({
            localId,
            name: file.name,
            mediaType: file.type,
            sizeBytes: file.size,
            status: "uploading",
            progress: 0,
          });
          const handle = uploadFile(file, (fraction) => update(localId, { progress: fraction }));
          cancels.current.set(localId, handle.cancel);
          handle.done
            .then((uploaded) => {
              update(localId, {
                status: "ready",
                progress: 1,
                fileId: uploaded.id,
                mediaType: uploaded.mediaType,
              });
            })
            .catch((error: unknown) => {
              // A cancel already removed the chip; reporting an error for it would resurrect one.
              if (error instanceof UploadCancelled) return;
              update(localId, {
                status: "error",
                error: error instanceof Error ? error.message : "The upload failed.",
              });
            })
            .finally(() => cancels.current.delete(localId));
        }
        return next;
      });
    },
    [update, accepted]
  );

  /**
   * Stages a File that is already stored, without sending its bytes again.
   *
   * The library hands over one of these. It arrives `ready` because there is nothing left to
   * upload — the only thing a new message needs is the id the server already issued.
   */
  const addExisting = useCallback((file: UploadedFile) => {
    setAttachments((current) => {
      if (current.length >= MAX_FILES_PER_MESSAGE) return current;
      if (current.some((item) => item.fileId === file.id)) return current;
      return [
        ...current,
        {
          localId: `existing-${file.id}`,
          name: file.filename,
          mediaType: file.mediaType,
          sizeBytes: file.sizeBytes,
          status: "ready",
          progress: 1,
          fileId: file.id,
        },
      ];
    });
  }, []);

  const remove = useCallback((localId: string) => {
    cancels.current.get(localId)?.();
    cancels.current.delete(localId);
    setAttachments((current) => current.filter((item) => item.localId !== localId));
  }, []);

  const clear = useCallback(() => {
    for (const cancel of cancels.current.values()) cancel();
    cancels.current.clear();
    setAttachments([]);
  }, []);

  return {
    attachments,
    add,
    addExisting,
    remove,
    clear,
    /** Only settled uploads can be sent; a half-sent file has no id to name. */
    readyFiles: attachments.filter((item) => item.status === "ready" && item.fileId !== undefined),
    uploading: attachments.some((item) => item.status === "uploading"),
  };
}
