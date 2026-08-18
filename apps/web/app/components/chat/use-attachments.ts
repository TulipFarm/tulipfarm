import { isAllowedMediaType, MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE } from "@tulipfarm/files";
import { useCallback, useRef, useState } from "react";
import { UploadCancelled, uploadFile } from "~/lib/files";

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

function describeRejection(file: File, staged: number): string | null {
  if (staged >= MAX_FILES_PER_MESSAGE) {
    return `You can attach at most ${MAX_FILES_PER_MESSAGE} files to one message.`;
  }
  if (file.size > MAX_FILE_BYTES) {
    return `${file.name} is larger than ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MB.`;
  }
  // An empty `type` means the browser did not recognise the format, so let the server's sniffer
  // decide rather than refusing something it might well accept.
  if (file.type !== "" && !isAllowedMediaType(file.type)) {
    return `${file.name} is not a supported file type.`;
  }
  return null;
}

export function useAttachments() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const cancels = useRef(new Map<string, () => void>());

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
          const rejection = describeRejection(file, next.length);
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
    [update]
  );

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
    remove,
    clear,
    /** Only settled uploads can be sent; a half-sent file has no id to name. */
    readyFiles: attachments.filter((item) => item.status === "ready" && item.fileId !== undefined),
    uploading: attachments.some((item) => item.status === "uploading"),
  };
}
