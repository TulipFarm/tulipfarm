import { useCallback, useEffect, useRef } from "react";
import { fetchFile, isKnowledgePending, type LibraryFile } from "~/lib/files";

const REASONS: Readonly<Record<string, string>> = {
  needs_ocr: "This document needs OCR. Upload a version with selectable text.",
  encrypted: "This document is password-protected. Upload an unlocked version.",
  unreadable: "This document could not be read. Check it and upload a new version.",
  resource_limit: "This document exceeds processing limits. Try a smaller document.",
  unsupported_media_type: "This document format is not supported for Knowledge.",
  no_text_layer: "This document has no text layer. Upload a version with selectable text.",
  no_text: "No text was found. Upload a document that contains text.",
  no_space: "There is not enough storage. Ask your administrator to free space, then refresh.",
  withdrawn: "Knowledge was withdrawn. Add the File again if you want it indexed.",
  changed: "The File changed. Check the current version, then refresh Knowledge.",
  converter_unavailable: "Document processing is unavailable. Ask your administrator, then retry.",
  retry_pending: "Processing will retry automatically. Check back shortly.",
  index_failed: "Knowledge could not be published. Try Refresh Knowledge again.",
};

export function KnowledgeStatus({ file }: { readonly file: LibraryFile }) {
  const receipt = file.knowledgeReceipt;
  if (!file.canManage || !receipt || file.archivedAt) return null;
  if (file.currentVersionId && receipt.versionId !== file.currentVersionId) return null;
  const label = {
    queued: "Knowledge queued",
    processing: "Knowledge processing",
    succeeded: "Knowledge completed",
    refused: "Knowledge refused",
    failed: "Knowledge failed",
  }[receipt.status];
  const failed = receipt.status === "refused" || receipt.status === "failed";
  const reason = receipt.reason
    ? (REASONS[receipt.reason] ??
      "An unknown processing error occurred. Try again or contact your administrator.")
    : failed
      ? "Knowledge was not updated. Try again or contact your administrator."
      : null;

  return (
    <div role={failed ? "alert" : "status"} className="mt-2 text-xs text-muted-foreground">
      <p className="font-medium">{label ?? "Knowledge status unavailable"}</p>
      {reason ? <p>{reason}</p> : null}
      {file.inKnowledge && receipt.status !== "succeeded" ? (
        <p>Previous Knowledge result is still available.</p>
      ) : null}
      {receipt.status === "succeeded" && receipt.truncated ? (
        <p>Only part of this document was indexed. Try smaller documents for full coverage.</p>
      ) : null}
    </div>
  );
}

export function useKnowledgePolling(
  files: readonly LibraryFile[],
  onFile: (file: LibraryFile) => void,
  onError: (message: string) => void,
  paused = false,
  scope = ""
) {
  const callbacks = useRef({ onFile, onError });
  callbacks.current = { onFile, onError };
  const controllerRef = useRef<AbortController | null>(null);
  const pending = JSON.stringify({
    scope,
    ids: files
      .filter((file) => file.canManage && !file.archivedAt && isKnowledgePending(file))
      .map((file) => [file.id, file.currentVersionId, file.knowledgeReceipt?.requestId]),
  });
  const cancel = useCallback(() => controllerRef.current?.abort(), []);

  useEffect(() => {
    if (paused) return;
    const ids = (JSON.parse(pending) as { ids: [string, ...unknown[]][] }).ids.map(([id]) => id);
    if (ids.length === 0) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      for (const id of ids) {
        if (controller.signal.aborted) return;
        try {
          const next = await fetchFile(id, controller.signal);
          if (controller.signal.aborted) return;
          callbacks.current.onFile(next);
        } catch {
          if (controller.signal.aborted) return;
          callbacks.current.onError(
            "Knowledge status could not be loaded. Reload the page to check the latest result."
          );
          return;
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    }
    timer = setTimeout(poll, 2000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pending, paused]);

  return cancel;
}
