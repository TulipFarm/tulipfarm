/**
 * Reading separated-value files into the same grid an Office spreadsheet gets.
 *
 * A CSV is a spreadsheet that happens to be stored as text. Showing one as raw text — a wall of
 * comma-separated lines in a monospace font — is technically the file's contents and useless to
 * read, so this parses it into rows and hands them to the same table renderer `.xlsx` uses.
 *
 * It lives next to `office-preview.ts`, and shares that module's row and column caps, because a
 * reader should not be able to tell which of the two produced the grid it is looking at.
 */

import type { PreviewBlock } from "./office-preview.js";
import { MAX_PREVIEW_COLUMNS, MAX_PREVIEW_ROWS } from "./office-preview.js";

/** The separator each media type uses, and the set this module claims. */
const SEPARATOR_BY_MEDIA_TYPE: ReadonlyMap<string, string> = new Map([
  ["text/csv", ","],
  ["text/tab-separated-values", "\t"],
]);

/** Whether this media type is a grid of values rather than prose. */
export function isDelimitedPreviewable(mediaType: string): boolean {
  return SEPARATOR_BY_MEDIA_TYPE.has(mediaType);
}

/**
 * Splits separated-value text into rows, following RFC 4180's quoting rules.
 *
 * Written by hand rather than taken from a dependency because the whole grammar is four states,
 * and the caps have to be applied while scanning: a parser that builds every row first and slices
 * afterwards has already spent the memory the caps exist to protect.
 */
export function parseDelimited(text: string, separator: string): readonly (readonly string[])[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  const endCell = () => {
    if (row.length < MAX_PREVIEW_COLUMNS) row.push(cell);
    cell = "";
  };
  // Returns false once the row cap is reached, so the scan can stop rather than keep building.
  const endRow = (): boolean => {
    endCell();
    // A file's last line ends with a newline far more often than not, and that trailing break is
    // punctuation rather than an empty final record.
    const empty = row.length === 1 && row[0] === "";
    if (!empty) rows.push(row);
    row = [];
    return rows.length < MAX_PREVIEW_ROWS;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') {
        cell += char;
        continue;
      }
      if (text[i + 1] === '"') {
        cell += '"';
        i += 1;
        continue;
      }
      quoted = false;
      continue;
    }
    if (char === '"' && cell === "") {
      quoted = true;
      continue;
    }
    if (char === separator) {
      endCell();
      continue;
    }
    if (char === "\n" || char === "\r") {
      // Consume the whole CRLF pair so the break does not register twice.
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      if (!endRow()) return rows;
      continue;
    }
    cell += char;
  }
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

/**
 * One separated-value file as a single table block, or nothing when it holds no values.
 *
 * Rows are padded to the widest one because a renderer draws a table from the first row's width,
 * and a short row would otherwise pull the cells after it under the wrong headings.
 */
export function previewDelimited(text: string, mediaType: string): readonly PreviewBlock[] {
  const separator = SEPARATOR_BY_MEDIA_TYPE.get(mediaType) ?? ",";
  // A blank line carries no values, so it becomes a gap in the grid rather than an empty row.
  const rows = parseDelimited(text, separator).filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length === 0) return [];
  const width = rows.reduce((widest, r) => Math.max(widest, r.length), 0);
  if (width === 0) return [];
  const padded = rows.map((r) =>
    r.length === width ? r : [...r, ...Array(width - r.length).fill("")]
  );
  return [{ kind: "table", rows: padded }];
}
