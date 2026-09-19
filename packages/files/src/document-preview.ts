import { MAX_FILE_BYTES } from "@tulipfarm/files/limits";
import { Unzip, UnzipInflate, unzipSync } from "fflate";
import type { PreviewBlock, PreviewTableSpan } from "./office-preview";

export const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PPTX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export type OfficeDocumentFormat = "docx" | "xlsx" | "pptx";

export function documentFormat(mediaType: string): OfficeDocumentFormat | null {
  switch (mediaType) {
    case DOCX_MEDIA_TYPE:
      return "docx";
    case XLSX_MEDIA_TYPE:
      return "xlsx";
    case PPTX_MEDIA_TYPE:
      return "pptx";
    default:
      return null;
  }
}
export const MAX_DOCUMENT_BYTES = MAX_FILE_BYTES;
export const MAX_OFFICE_EXPANDED_BYTES = 32 * 1024 * 1024;
export const MAX_OFFICE_ENTRIES = 512;

export function docxFormat(mediaType: string): "docx" | null {
  return mediaType === DOCX_MEDIA_TYPE ? "docx" : null;
}

export type DocumentRefusal =
  | "no_text_layer"
  | "unreadable"
  | "encrypted"
  | "unsupported_media_type"
  | "needs_ocr"
  | "resource_limit";

export class DocumentRefusedError extends Error {
  readonly reason: DocumentRefusal;

  constructor(reason: DocumentRefusal) {
    super(`Document conversion refused: ${reason}`);
    this.name = "DocumentRefusedError";
    this.reason = reason;
  }
}

/** Reject the whole archive; display limits never grant permission to skip archive entries. */
export function validateOfficeArchive(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new DocumentRefusedError("resource_limit");
  try {
    let declaredEntries = 0;
    unzipSync(bytes, {
      filter: (entry) => {
        declaredEntries += 1;
        if (
          declaredEntries > MAX_OFFICE_ENTRIES ||
          entry.originalSize > MAX_OFFICE_EXPANDED_BYTES
        ) {
          throw new DocumentRefusedError("resource_limit");
        }
        return false;
      },
    });
    let actualBytes = 0;
    let entries = 0;
    let completed = 0;
    const archive = new Unzip((entry) => {
      entries += 1;
      if (entries > MAX_OFFICE_ENTRIES) throw new DocumentRefusedError("resource_limit");
      entry.ondata = (error, chunk, final) => {
        if (error) throw error;
        actualBytes += chunk.byteLength;
        if (actualBytes > MAX_OFFICE_EXPANDED_BYTES) {
          throw new DocumentRefusedError("resource_limit");
        }
        if (final) completed += 1;
      };
      entry.start();
    });
    archive.register(UnzipInflate);
    for (let offset = 0; offset < bytes.byteLength; offset += 1024) {
      const end = Math.min(offset + 1024, bytes.byteLength);
      archive.push(bytes.subarray(offset, end), end === bytes.byteLength);
    }
    if (entries === 0 || entries !== declaredEntries || completed !== entries) {
      throw new DocumentRefusedError("unreadable");
    }
  } catch (error) {
    if (error instanceof DocumentRefusedError) throw error;
    // fflate reports corrupt ZIP streams with numeric codes, not converter infrastructure errors.
    if (error instanceof Error && "code" in error && typeof error.code === "number") {
      throw new DocumentRefusedError("unreadable");
    }
    throw error;
  }
}

export interface DocumentProjectionOptions {
  readonly format?: OfficeDocumentFormat;
  readonly maxBlocks?: number;
  readonly maxRows?: number;
  readonly maxColumns?: number;
}

export interface DocumentProjection {
  readonly blocks: PreviewBlock[];
  readonly truncated: boolean;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid document model");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Invalid document model collection");
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Invalid document model text");
  return value;
}

function spanSize(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError("Invalid document table span");
  }
  return value;
}

function inlineText(value: unknown): string {
  return array(value)
    .map((item) => {
      const inline = record(item);
      switch (inline.kind) {
        case "text":
        case "math":
          return string(inline.text);
        case "link":
          return inlineText(inline.content);
        case "image":
          return typeof inline.alt === "string" ? inline.alt : "";
        case "noteRef":
          return `[^${string(inline.noteId)}]`;
        case "lineBreak":
          return "\n";
        case "checkbox":
          return inline.checked === true ? "[x] " : "[ ] ";
        case "anchor":
          return "";
        default:
          throw new TypeError("Unknown document inline");
      }
    })
    .join("");
}

/** Safe semantic content only: never project asset bytes, source HTML, or link destinations. */
export function projectDocument(
  document: unknown,
  options: DocumentProjectionOptions = {}
): DocumentProjection {
  const source = record(document);
  const blocks: PreviewBlock[] = [];
  let truncated = false;
  const maxBlocks = options.maxBlocks ?? Number.POSITIVE_INFINITY;
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  const maxColumns = options.maxColumns ?? Number.POSITIVE_INFINITY;
  const append = (block: PreviewBlock) => {
    if (blocks.length >= maxBlocks) truncated = true;
    else blocks.push(block);
  };
  const walk = (values: unknown, depth = 0, list?: { ordered: boolean; marker: string }) => {
    for (const value of array(values)) {
      if (blocks.length >= maxBlocks) {
        truncated = true;
        return;
      }
      const block = record(value);
      switch (block.kind) {
        case "heading":
        case "paragraph": {
          const text = inlineText(block.content);
          if (list) append({ kind: "listItem", text, depth, ...list });
          else if (block.kind === "heading") {
            append({
              kind: "heading",
              text,
              level: typeof block.level === "number" ? block.level : 1,
            });
          } else append({ kind: "paragraph", text });
          break;
        }
        case "list": {
          const value = record(block.list);
          const ordered = value.marker !== "bullet";
          let index = typeof value.start === "number" ? value.start : 1;
          for (const item of array(value.items)) {
            const entry = record(item);
            const marker =
              typeof entry.markerLabel === "string"
                ? entry.markerLabel
                : ordered
                  ? `${index}.`
                  : "-";
            walk(entry.blocks, list ? depth + 1 : depth, { ordered, marker });
            index += 1;
          }
          break;
        }
        case "table": {
          const table = record(block.table);
          const grid = array(table.grid);
          if (grid.length > maxRows) truncated = true;
          const visibleGrid = grid.slice(0, maxRows).map((value) => {
            const row = array(value);
            if (row.length > maxColumns) truncated = true;
            return row.slice(0, maxColumns);
          });
          const spans: PreviewTableSpan[] = [];
          const rows = visibleGrid.map((row, rowIndex) =>
            row.map((slot, column) => {
              const cell = record(slot);
              if (cell.kind === "covered") return "";
              if (cell.kind !== "origin") throw new TypeError("Unknown document cell");
              const origin = record(cell.cell);
              const rowSpan = Math.min(spanSize(origin.rowSpan), visibleGrid.length - rowIndex);
              const colSpan = Math.min(spanSize(origin.colSpan), row.length - column);
              if (rowSpan > 1 || colSpan > 1) {
                spans.push({ row: rowIndex, column, rowSpan, colSpan });
              }
              const projection = projectDocument({ blocks: origin.blocks, notes: [] }, options);
              truncated ||= projection.truncated;
              return documentBlocksText(projection.blocks);
            })
          );
          const headerRows = table.headerRows ?? 0;
          if (typeof headerRows !== "number" || !Number.isInteger(headerRows) || headerRows < 0) {
            throw new TypeError("Invalid document table headers");
          }
          append({
            kind: "table",
            rows,
            headerRows: Math.min(headerRows, rows.length),
            ...(spans.length > 0 ? { spans } : {}),
          });
          break;
        }
        case "blockQuote":
          // AnyDoc 0.2.4 represents PPTX speaker notes as block quotes, not document notes.
          if (options.format === "pptx")
            append({ kind: "heading", level: 3, text: "Speaker notes" });
          walk(block.blocks, depth, list);
          break;
        case "codeBlock":
        case "math":
          append({ kind: "paragraph", text: string(block.text) });
          break;
        case "rule":
          append({ kind: "paragraph", text: "---" });
          break;
        default:
          throw new TypeError("Unknown document block");
      }
    }
  };
  walk(source.blocks);
  for (const value of array(source.notes)) {
    const note = record(value);
    append({
      kind: "paragraph",
      text: `${note.kind === "endnote" ? "Endnote" : "Footnote"} [^${string(note.id)}]`,
    });
    walk(note.blocks);
  }
  return { blocks, truncated };
}

export function documentBlocksText(blocks: readonly PreviewBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "heading":
          return `${"#".repeat(Math.max(1, Math.min(6, block.level)))} ${block.text}`;
        case "listItem":
          return `${"  ".repeat(block.depth ?? 0)}${block.marker ?? "-"} ${block.text}`;
        case "table":
          return block.rows.map((row) => row.join("\t")).join("\n");
        case "sheet":
          return [block.name, ...block.rows.map((row) => row.join("\t"))].join("\n");
        case "slide":
          return [block.title, ...block.bullets].join("\n");
        default:
          return block.text;
      }
    })
    .join("\n\n")
    .trim();
}
