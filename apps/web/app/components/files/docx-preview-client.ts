import type { DocumentProjection, OfficeDocumentFormat } from "@tulipfarm/files/document-preview";

export type DocxPreviewFailureCode =
  | "malformed"
  | "encrypted"
  | "unsupported"
  | "resourceLimit"
  | "unavailable"
  | "timeout";

export type DocxPreviewReply =
  | { readonly kind: "ready"; readonly preview: DocumentProjection }
  | { readonly kind: "failed"; readonly code: DocxPreviewFailureCode };

export const DOCX_PREVIEW_DEADLINE_MS = 10_000;

const FAILURE_MESSAGES: Record<DocxPreviewFailureCode, string> = {
  malformed: "This document could not be read. It may be damaged or incomplete.",
  encrypted: "This document is password-protected. Download an unprotected copy to preview it.",
  unsupported: "This document cannot be shown in the semantic preview.",
  resourceLimit: "This document exceeds the local preview's safety limits.",
  unavailable: "The local document preview could not start. Download the file or try again.",
  timeout: "The document preview took too long and was stopped. Download the file to read it.",
};

export class DocxPreviewFailure extends Error {
  constructor(readonly code: DocxPreviewFailureCode) {
    super(FAILURE_MESSAGES[code]);
    this.name = "DocxPreviewFailure";
  }
}

export function previewDocument(
  bytes: Uint8Array,
  signal: AbortSignal,
  format: OfficeDocumentFormat = "docx"
): Promise<DocumentProjection> {
  if (signal.aborted) return Promise.reject(new DOMException("Preview closed", "AbortError"));
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./docx-preview.worker.ts", import.meta.url), {
        type: "module",
        name: "document-semantic-preview",
      });
    } catch {
      reject(new DocxPreviewFailure("unavailable"));
      return;
    }
    let settled = false;
    const finish = (result: DocxPreviewReply | "aborted") => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      if (result === "aborted") reject(new DOMException("Preview closed", "AbortError"));
      else if (result.kind === "failed") reject(new DocxPreviewFailure(result.code));
      else resolve(result.preview);
    };
    const abort = () => finish("aborted");
    const deadline = setTimeout(
      () => finish({ kind: "failed", code: "timeout" }),
      DOCX_PREVIEW_DEADLINE_MS
    );
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<DocxPreviewReply>) => finish(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      finish({ kind: "failed", code: "unavailable" });
    };
    worker.onmessageerror = () => finish({ kind: "failed", code: "unavailable" });
    try {
      // Transfer only our copy; the rich viewer and download still own the source bytes.
      const copy = bytes.slice();
      worker.postMessage({ bytes: copy, format }, [copy.buffer]);
    } catch {
      finish({ kind: "failed", code: "unavailable" });
    }
  });
}

export const previewDocx = previewDocument;
