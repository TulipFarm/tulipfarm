/**
 * Projecting Agent-authored Markdown and CSV onto the Office document model.
 *
 * `ooxml.ts` decides what the bytes are; this module decides what the *document* is. They are
 * separate because the projection is where content-shaped judgement lives — which heading starts a
 * slide, when a CSV field is a number — and none of that should be tangled with schema-ordered XML.
 *
 * The input contract is the same one PDF already has: Markdown in, never HTML. A model writes
 * Markdown natively, and Markdown carries no scripting, no remote reference and no styling
 * language, so the projection cannot be handed anything it would have to sanitise.
 */

import { marked, type Token, type Tokens } from "marked";
import {
  buildDocx,
  buildPptx,
  buildXlsx,
  type DocBlock,
  type DocSlide,
  type DocSpan,
} from "./ooxml";

/** A slide carrying more lines than this is a document, and is split onto a continuation slide. */
const MAX_BULLETS_PER_SLIDE = 12;

// --------------------------------------------------------------------------------------------
// Markdown -> blocks
// --------------------------------------------------------------------------------------------

function spansOf(tokens: readonly Token[], inherited: Omit<DocSpan, "text"> = {}): DocSpan[] {
  const out: DocSpan[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        out.push(...spansOf((token as Tokens.Strong).tokens ?? [], { ...inherited, bold: true }));
        break;
      case "em":
        out.push(...spansOf((token as Tokens.Em).tokens ?? [], { ...inherited, italic: true }));
        break;
      case "codespan":
        out.push({ ...inherited, code: true, text: (token as Tokens.Codespan).text });
        break;
      case "br":
        out.push({ ...inherited, text: " " });
        break;
      case "link": {
        // The label, not the target. A hyperlink is a relationship part, and this package emits no
        // relationship a reader could follow out of the package — see the `ooxml.ts` header.
        const link = token as Tokens.Link;
        const label = spansOf(link.tokens ?? [], inherited);
        out.push(...(label.length > 0 ? label : [{ ...inherited, text: link.href }]));
        break;
      }
      case "image":
        out.push({ ...inherited, text: (token as Tokens.Image).text });
        break;
      default: {
        const nested = (token as { tokens?: Token[] }).tokens;
        if (nested !== undefined && nested.length > 0) out.push(...spansOf(nested, inherited));
        else out.push({ ...inherited, text: (token as { text?: string }).text ?? "" });
      }
    }
  }
  return out.filter((span) => span.text !== "");
}

function plain(spans: readonly DocSpan[]): string {
  return spans.map((span) => span.text).join("");
}

/** Flattens a list item's block children, whose inline tokens belong on the item's single line. */
function itemSpans(item: Tokens.ListItem): DocSpan[] {
  const inline: Token[] = [];
  for (const child of item.tokens ?? []) {
    if (child.type === "list") continue;
    const nested = (child as { tokens?: Token[] }).tokens;
    if (child.type === "text" || child.type === "paragraph") inline.push(...(nested ?? [child]));
    else inline.push(child);
  }
  return spansOf(inline);
}

function pushList(out: DocBlock[], list: Tokens.List, depth: number): void {
  for (const item of list.items) {
    out.push({ kind: "listItem", ordered: Boolean(list.ordered), depth, spans: itemSpans(item) });
    for (const child of item.tokens ?? []) {
      if (child.type === "list") pushList(out, child as Tokens.List, depth + 1);
    }
  }
}

function pushToken(out: DocBlock[], token: Token, quoted: boolean): void {
  switch (token.type) {
    case "heading": {
      const heading = token as Tokens.Heading;
      out.push({
        kind: "heading",
        level: Math.min(Math.max(heading.depth, 1), 6),
        spans: spansOf(heading.tokens ?? []),
      });
      return;
    }
    case "paragraph": {
      const spans = spansOf((token as Tokens.Paragraph).tokens ?? []);
      if (spans.length > 0) out.push({ kind: quoted ? "quote" : "paragraph", spans });
      return;
    }
    case "code":
      out.push({ kind: "code", text: (token as Tokens.Code).text });
      return;
    case "blockquote":
      for (const child of (token as Tokens.Blockquote).tokens ?? []) pushToken(out, child, true);
      return;
    case "list":
      pushList(out, token as Tokens.List, 0);
      return;
    case "table": {
      const table = token as Tokens.Table;
      out.push({
        kind: "table",
        header: table.header.map((cell) => cell.text),
        rows: table.rows.map((row) => row.map((cell) => cell.text)),
      });
      return;
    }
    case "hr":
      out.push({ kind: "rule" });
      return;
    case "space":
      return;
    default: {
      const text = (token as { text?: string }).text;
      if (text !== undefined && text.trim() !== "") {
        out.push({ kind: quoted ? "quote" : "paragraph", spans: [{ text }] });
      }
    }
  }
}

/** The one Markdown walk both Office writers share. Exported for the tests that pin its shape. */
export function markdownBlocks(markdown: string): DocBlock[] {
  const out: DocBlock[] = [];
  for (const token of marked.lexer(markdown)) pushToken(out, token, false);
  return out;
}

// --------------------------------------------------------------------------------------------
// CSV -> rows
// --------------------------------------------------------------------------------------------

/**
 * Parses RFC 4180 CSV.
 *
 * Written here rather than taken as a dependency because the grammar is four rules and the failure
 * mode of getting it wrong — a quoted field containing a comma splitting into two cells — is a
 * silently wrong spreadsheet rather than an error anyone sees. A lone `"` inside an unquoted field
 * is data, not a quote, which is what a spreadsheet does with it too.
 */
export function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;
  // A UTF-8 BOM would otherwise become part of the first header cell's name.
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;

  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      endField();
      index += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      endRow();
      index += char === "\r" && text[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += char;
    index += 1;
  }

  if (field !== "" || row.length > 0 || quoted) endRow();
  // A trailing newline ends the last row; it does not begin an empty one.
  return rows.filter((cells) => cells.length > 1 || cells[0] !== "");
}

// --------------------------------------------------------------------------------------------
// Slides
// --------------------------------------------------------------------------------------------

/**
 * Splits Markdown into slides at its top two heading levels.
 *
 * A deck is the one Office format with no natural mapping from a flowing document, so the rule is
 * stated rather than inferred: every `#` or `##` starts a slide, everything under it becomes that
 * slide's lines, and a slide that overflows continues onto another rather than running off the
 * bottom edge where nobody would see it.
 */
export function markdownSlides(markdown: string, title?: string): DocSlide[] {
  const blocks = markdownBlocks(markdown);
  const slides: DocSlide[] = [];
  let current: { title: string; bullets: { text: string; depth: number }[] } | undefined;

  const open = (heading: string): void => {
    if (current !== undefined) slides.push(current);
    current = { title: heading, bullets: [] };
  };
  const line = (text: string, depth: number): void => {
    if (text.trim() === "") return;
    if (current === undefined) open(title?.trim() || "Overview");
    current?.bullets.push({ text, depth });
  };

  for (const block of blocks) {
    switch (block.kind) {
      case "heading":
        if (block.level <= 2) open(plain(block.spans));
        else line(plain(block.spans), 0);
        break;
      case "paragraph":
      case "quote":
        line(plain(block.spans), 0);
        break;
      case "listItem":
        line(plain(block.spans), Math.min(block.depth, 4));
        break;
      case "code":
        for (const codeLine of block.text.split("\n")) line(codeLine, 1);
        break;
      case "table":
        line(block.header.join(" | "), 0);
        for (const row of block.rows) line(row.join(" | "), 1);
        break;
      case "rule":
        break;
    }
  }
  if (current !== undefined) slides.push(current);

  if (slides.length === 0) return [{ title: title?.trim() || "Untitled", bullets: [] }];
  return slides.flatMap((slide) => {
    if (slide.bullets.length <= MAX_BULLETS_PER_SLIDE) return [slide];
    const pages: DocSlide[] = [];
    for (let start = 0; start < slide.bullets.length; start += MAX_BULLETS_PER_SLIDE) {
      pages.push({
        title: start === 0 ? slide.title : `${slide.title} (cont.)`,
        bullets: slide.bullets.slice(start, start + MAX_BULLETS_PER_SLIDE),
      });
    }
    return pages;
  });
}

// --------------------------------------------------------------------------------------------
// Entry points
// --------------------------------------------------------------------------------------------

export function renderDocx(markdown: string, title?: string): Uint8Array {
  return buildDocx(markdownBlocks(markdown), title);
}

export function renderXlsx(csv: string, title?: string): Uint8Array {
  const rows = parseCsv(csv);
  return buildXlsx(rows, { ...(title === undefined ? {} : { sheetName: title }), headerRow: true });
}

export function renderPptx(markdown: string, title?: string): Uint8Array {
  return buildPptx(markdownSlides(markdown, title));
}
