import { createRequire } from "node:module";
import type { Format } from "@firecrawl/anydoc";
import {
  DocumentRefusedError,
  documentBlocksText,
  MAX_DOCUMENT_BYTES,
  projectDocument,
  validateOfficeArchive,
} from "@tulipfarm/files/document-preview";

function refusal(error: unknown): string | undefined {
  if (error instanceof DocumentRefusedError) return error.reason;
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  switch (error.code) {
    case "unsupported":
      return "unsupported_media_type";
    case "needsOcr":
      return "needs_ocr";
    case "encrypted":
      return "encrypted";
    case "resourceLimit":
      return "resource_limit";
    case "malformed":
    case "missingPart":
      return "unreadable";
    default:
      return undefined;
  }
}

function reply(value: object): void {
  process.send?.(value, () => process.disconnect?.());
}

async function pdfVisual(bytes: Uint8Array) {
  const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
  const fromFiles = createRequire(require.resolve("@tulipfarm/files"));
  const { getDocumentProxy }: typeof import("unpdf") = await import(fromFiles.resolve("unpdf"));
  let document: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    // pdf.js transfers its input buffer. Its copy must never detach the source sent to a model.
    document = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
    const pages: { width: number; height: number }[] = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      // A 144-DPI proxy preserves the existing conservative provider-input estimate.
      const viewport = page.getViewport({ scale: 2 });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width <= 0 ||
        height <= 0
      ) {
        throw new DocumentRefusedError("unreadable");
      }
      pages.push({ width, height });
      page.cleanup();
    }
    if (pages.length === 0) throw new DocumentRefusedError("unreadable");
    return { kind: "pdf" as const, pages };
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException") {
      throw new DocumentRefusedError("encrypted");
    }
    if (error instanceof Error && error.name === "InvalidPDFException") {
      throw new DocumentRefusedError("unreadable");
    }
    throw error;
  } finally {
    await document?.loadingTask.destroy();
  }
}

process.once("message", async (message: unknown) => {
  if (
    typeof message !== "object" ||
    message === null ||
    !("bytes" in message) ||
    !(message.bytes instanceof Uint8Array) ||
    !("format" in message) ||
    (message.format !== "docx" &&
      message.format !== "xlsx" &&
      message.format !== "pptx" &&
      message.format !== "pdf") ||
    !("maxChars" in message) ||
    typeof message.maxChars !== "number" ||
    !Number.isInteger(message.maxChars) ||
    message.maxChars < 0 ||
    message.maxChars > 200_000
  ) {
    reply({ kind: "failure", code: "protocol" });
    return;
  }
  if (message.bytes.byteLength > MAX_DOCUMENT_BYTES) {
    reply({ kind: "refused", reason: "resource_limit" });
    return;
  }
  try {
    if (message.format !== "pdf") validateOfficeArchive(message.bytes);
  } catch (error) {
    const reason = refusal(error);
    reply(reason ? { kind: "refused", reason } : { kind: "failure", code: "protocol" });
    return;
  }

  let native: typeof import("@firecrawl/anydoc");
  try {
    const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
    const fromFiles = createRequire(require.resolve("@tulipfarm/files"));
    native = await import(fromFiles.resolve("@firecrawl/anydoc"));
  } catch {
    reply({ kind: "failure", code: "native_load" });
    return;
  }
  try {
    if (message.format === "pdf") {
      let text: string;
      try {
        text = await native.toMarkdownBytes(new Uint8Array(message.bytes), "pdf" as Format, {
          ocr: "reject",
        });
      } catch (error) {
        if (refusal(error) !== "needs_ocr") throw error;
        reply({ kind: "refused", reason: "needs_ocr", visual: await pdfVisual(message.bytes) });
        return;
      }
      const visual = await pdfVisual(message.bytes);
      reply(
        text.trim().length === 0
          ? { kind: "refused", reason: "no_text_layer", visual }
          : {
              kind: "text",
              text: text.slice(0, message.maxChars),
              truncated: text.length > message.maxChars,
              visual,
            }
      );
      return;
    }
    // toDocument has no hosted OCR path; bytes and an explicit format are its entire input.
    const document = await native.toDocument(
      new Uint8Array(message.bytes),
      message.format as Format
    );
    const text = documentBlocksText(projectDocument(document, { format: message.format }).blocks);
    reply(
      text.length === 0
        ? { kind: "refused", reason: "no_text_layer" }
        : {
            kind: "text",
            text: text.slice(0, message.maxChars),
            truncated: text.length > message.maxChars,
          }
    );
  } catch (error) {
    const reason = refusal(error);
    reply(reason ? { kind: "refused", reason } : { kind: "failure", code: "conversion" });
  }
});

process.once("disconnect", () => process.exit(0));
