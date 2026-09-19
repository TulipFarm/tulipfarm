import init, { toDocument } from "@firecrawl/anydoc-wasm";
import wasmUrl from "@firecrawl/anydoc-wasm/anydoc_wasm_bg.wasm?url";
import {
  DocumentRefusedError,
  type OfficeDocumentFormat,
  projectDocument,
  validateOfficeArchive,
} from "@tulipfarm/files/document-preview";
import {
  MAX_PREVIEW_BLOCKS,
  MAX_PREVIEW_COLUMNS,
  MAX_PREVIEW_ROWS,
} from "@tulipfarm/files/office-preview";
import type { DocxPreviewFailureCode, DocxPreviewReply } from "./docx-preview-client";

function failureCode(error: unknown): DocxPreviewFailureCode {
  if (error instanceof DocumentRefusedError) {
    if (error.reason === "resource_limit") return "resourceLimit";
    if (error.reason === "encrypted") return "encrypted";
    if (error.reason === "unsupported_media_type") return "unsupported";
    return "malformed";
  }
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  switch (code) {
    case "malformed":
    case "encrypted":
    case "unsupported":
    case "resourceLimit":
      return code;
    case "missingPart":
      return "malformed";
    default:
      return "unavailable";
  }
}

self.onmessage = async (
  event: MessageEvent<{ bytes: Uint8Array; format?: OfficeDocumentFormat }>
) => {
  let reply: DocxPreviewReply;
  try {
    validateOfficeArchive(event.data.bytes);
    await init({ module_or_path: wasmUrl });
    const format = event.data.format ?? "docx";
    if (!["docx", "xlsx", "pptx"].includes(format)) {
      throw new DocumentRefusedError("unsupported_media_type");
    }
    const document = toDocument(event.data.bytes, format);
    reply = {
      kind: "ready",
      preview: projectDocument(document, {
        format,
        maxBlocks: MAX_PREVIEW_BLOCKS,
        maxRows: MAX_PREVIEW_ROWS,
        maxColumns: MAX_PREVIEW_COLUMNS,
      }),
    };
  } catch (error) {
    reply = { kind: "failed", code: failureCode(error) };
  }
  self.postMessage(reply);
};
