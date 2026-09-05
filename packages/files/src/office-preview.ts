/**
 * Reading Office documents back out, so the product can show one without shipping it anywhere.
 *
 * `office.ts` writes these formats; this reads them. The two are deliberately not inverses: a
 * faithful round-trip would need the whole of OOXML, whereas a preview only needs the text a
 * person recognises as their document. So this extracts headings, paragraphs, table rows, cells
 * and slide bullets, and ignores everything about presentation.
 *
 * It stays here, next to the writer, rather than in the web app, because the parsing rules are the
 * same ones the writer encodes and the two drift apart if they live in different packages.
 *
 * The alternative — handing a file to a hosted viewer such as Google's `gview` — cannot work for a
 * self-hosted instance: that viewer is Google fetching a URL from the public internet, so it needs
 * the File to be publicly downloadable, which defeats the File's own access control, and it sends
 * private business documents to a third party. Reading the bytes locally has neither problem.
 */

import { unzipSync } from "fflate";

/** One readable piece of a document, in reading order. */
export type PreviewBlock =
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "listItem"; readonly text: string }
  | { readonly kind: "table"; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: "sheet"; readonly name: string; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: "slide"; readonly title: string; readonly bullets: readonly string[] };

/** How many blocks a preview may hold before it stops, so a huge File cannot hang the tab. */
export const MAX_PREVIEW_BLOCKS = 400;

/** How many rows of any one grid a preview shows. */
export const MAX_PREVIEW_ROWS = 200;

/**
 * How many bytes an Office package may expand to before the rest of it is left unread.
 *
 * An OOXML file is a ZIP, and an upload of a few megabytes can declare gigabytes of contents. The
 * block and row limits below cannot help: they bound what is *parsed*, and the expansion happens
 * before parsing begins. So the budget is spent entry by entry and a part that would exceed it is
 * skipped, which degrades the preview into missing text rather than exhausting the tab.
 */
export const MAX_PREVIEW_UNZIPPED_BYTES = 32 * 1024 * 1024;

/** How many entries of an Office package are read, whatever their sizes. */
export const MAX_PREVIEW_ENTRIES = 512;

/** How many columns of any one sheet a preview shows. */
export const MAX_PREVIEW_COLUMNS = 256;

const DECODER = new TextDecoder();

function partOf(parts: Record<string, Uint8Array>, path: string): string | null {
  const entry = parts[path];
  return entry === undefined ? null : DECODER.decode(entry);
}

/** Undoes the five XML entities an OOXML writer is allowed to emit. */
function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

/**
 * The visible text of one element, from its `<w:t>`/`<a:t>` runs.
 *
 * Reads runs rather than stripping tags, because stripping would also pull in the contents of
 * elements that are not text — field instructions and deleted revisions among them — and show a
 * person words their document does not contain.
 */
function runText(fragment: string, tag: "w:t" | "a:t" | "t"): string {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  return unescapeXml([...fragment.matchAll(pattern)].map((m) => m[1] ?? "").join("")).trim();
}

/**
 * Every occurrence of one element, including the self-closing form.
 *
 * The two alternatives are not cosmetic. A single pattern whose attribute part is `[^>]*` also
 * consumes the `/` of `<c r="B2"/>`, so the match runs on to the *next* closing tag and swallows
 * the following element — which silently shifts every later spreadsheet cell one column left.
 */
function elements(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*/>|<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "g");
  return xml.match(pattern) ?? [];
}

function docxBlocks(parts: Record<string, Uint8Array>): PreviewBlock[] {
  const document = partOf(parts, "word/document.xml");
  if (document === null) return [];
  const body = document.slice(document.indexOf("<w:body"));
  const blocks: PreviewBlock[] = [];

  // Tables and paragraphs interleave, so walk the body in document order rather than collecting
  // each kind separately, which would show every table after every paragraph.
  const pattern = /<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:p>)/g;
  for (const [chunk] of body.matchAll(pattern)) {
    if (blocks.length >= MAX_PREVIEW_BLOCKS) break;
    if (chunk.startsWith("<w:tbl")) {
      const rows = elements(chunk, "w:tr")
        .slice(0, MAX_PREVIEW_ROWS)
        .map((row) => elements(row, "w:tc").map((cell) => runText(cell, "w:t")));
      if (rows.length > 0) blocks.push({ kind: "table", rows });
      continue;
    }
    const text = runText(chunk, "w:t");
    if (text === "") continue;
    const style = /<w:pStyle w:val="([^"]+)"/.exec(chunk)?.[1] ?? "";
    const heading = /^Heading(\d)$/.exec(style);
    if (heading?.[1] !== undefined) {
      blocks.push({ kind: "heading", level: Number(heading[1]), text });
    } else if (chunk.includes("<w:numPr") || style.startsWith("List")) {
      blocks.push({ kind: "listItem", text });
    } else {
      blocks.push({ kind: "paragraph", text });
    }
  }
  return blocks;
}

/**
 * `A12` → 11, and anything past the last previewed column → `null`.
 *
 * The reference is attacker-controlled text in a file this process did not write, and the caller
 * pads a row out to whatever index comes back. Unbounded, a four-letter reference asks for half a
 * million cells and a longer one asks for more memory than the tab has — from an archive small
 * enough to slip under the upload cap.
 */
function columnIndex(reference: string): number | null {
  let index = 0;
  for (const character of reference) {
    const position = character.charCodeAt(0) - 64;
    if (position < 1 || position > 26) break;
    index = index * 26 + position;
    if (index > MAX_PREVIEW_COLUMNS) return null;
  }
  return index === 0 ? 0 : index - 1;
}

function xlsxBlocks(parts: Record<string, Uint8Array>): PreviewBlock[] {
  // Real spreadsheets keep their strings in one shared table; the ones this package writes use
  // inline strings. A preview has to read both or half the files it meets come out blank. The
  // shared table uses a bare `<t>`, not the `<w:t>` a Word document uses.
  const sharedPart = partOf(parts, "xl/sharedStrings.xml");
  const shared =
    sharedPart === null ? [] : elements(sharedPart, "si").map((entry) => runText(entry, "t"));

  const names = new Map<string, string>();
  const workbook = partOf(parts, "xl/workbook.xml");
  if (workbook !== null) {
    for (const [, name] of workbook.matchAll(/<sheet[^>]*name="([^"]*)"/g)) {
      names.set(String(names.size + 1), unescapeXml(name ?? ""));
    }
  }

  const blocks: PreviewBlock[] = [];
  const sheetPaths = Object.keys(parts)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
    .sort();

  for (const path of sheetPaths) {
    const sheet = partOf(parts, path);
    if (sheet === null) continue;
    const number = /sheet(\d+)\.xml$/.exec(path)?.[1] ?? "1";
    const rows: string[][] = [];
    for (const row of elements(sheet, "row").slice(0, MAX_PREVIEW_ROWS)) {
      const cells: string[] = [];
      for (const cell of elements(row, "c")) {
        const reference = /r="([A-Z]+)\d+"/.exec(cell)?.[1];
        const at = reference === undefined ? cells.length : columnIndex(reference);
        if (at === null || at >= MAX_PREVIEW_COLUMNS) continue;
        while (cells.length < at) cells.push("");
        const type = /t="([^"]+)"/.exec(cell)?.[1];
        const raw = /<v>([\s\S]*?)<\/v>/.exec(cell)?.[1];
        const value =
          type === "s" && raw !== undefined
            ? (shared[Number(raw)] ?? "")
            : type === "inlineStr"
              ? runText(cell, "t")
              : unescapeXml(raw ?? "");
        cells[at] = value;
      }
      rows.push(cells);
    }
    if (rows.length > 0) {
      blocks.push({ kind: "sheet", name: names.get(number) ?? `Sheet ${number}`, rows });
    }
  }
  return blocks;
}

function pptxBlocks(parts: Record<string, Uint8Array>): PreviewBlock[] {
  const paths = Object.keys(parts)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    // Numeric sort: a plain sort puts slide10 before slide2 and reorders the deck.
    .sort(
      (a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0)
    );

  return paths.slice(0, MAX_PREVIEW_BLOCKS).flatMap((path) => {
    const slide = partOf(parts, path);
    if (slide === null) return [];
    const lines = elements(slide, "a:p")
      .map((paragraph) => runText(paragraph, "a:t"))
      .filter((line) => line !== "");
    if (lines.length === 0) return [];
    return [{ kind: "slide" as const, title: lines[0] ?? "", bullets: lines.slice(1) }];
  });
}

/** The three Office media types this module can read. */
export const PREVIEWABLE_OFFICE_TYPES = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": docxBlocks,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": xlsxBlocks,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": pptxBlocks,
} as const;

export function isOfficePreviewable(mediaType: string): boolean {
  return mediaType in PREVIEWABLE_OFFICE_TYPES;
}

/**
 * Reads an Office file into blocks a viewer can lay out.
 *
 * @throws when the bytes are not a readable package of that type, so a caller can offer the
 * download it would otherwise have hidden behind a viewer showing nothing.
 */
export function previewOffice(bytes: Uint8Array, mediaType: string): readonly PreviewBlock[] {
  const read = PREVIEWABLE_OFFICE_TYPES[mediaType as keyof typeof PREVIEWABLE_OFFICE_TYPES];
  if (read === undefined) throw new Error(`cannot preview ${mediaType}`);
  return read(boundedUnzip(bytes));
}

/**
 * Expands an Office package under a fixed byte and entry budget.
 *
 * The budget is spent against the larger of the two sizes an entry declares. `originalSize` is
 * what fflate inflates a deflated entry into, but a *stored* entry is copied at its compressed
 * `size` — so charging `originalSize` alone lets an archive declare zero and hand back a payload
 * of any length it likes, which is the bomb this bound exists to refuse.
 */
export function boundedUnzip(bytes: Uint8Array): Record<string, Uint8Array> {
  let remaining = MAX_PREVIEW_UNZIPPED_BYTES;
  let entries = 0;
  return unzipSync(bytes, {
    filter: (file) => {
      const cost = Math.max(file.originalSize, file.size);
      if (entries >= MAX_PREVIEW_ENTRIES || cost > remaining) return false;
      entries += 1;
      remaining -= cost;
      return true;
    },
  });
}
