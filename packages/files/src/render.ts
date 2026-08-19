/**
 * Turning Agent-authored Markdown into a document a person can forward to someone else.
 *
 * Three choices are settled here.
 *
 * **Markdown in, not HTML.** Models write Markdown natively, and it carries no scripting, no
 * remote references and no styling language. HTML would be more expressive and would drag in a
 * sanitiser whose failure mode is silent — a missed vector renders rather than throws.
 *
 * **A pure-JS engine, not a headless browser.** A browser is the high-fidelity answer and a
 * ~300 MB, continuously-CVE'd dependency in the image, spawning a subprocess that can outlive its
 * caller. Everything an operations report needs — headings, lists, tables, code, pagination — is
 * reachable without one, so the fidelity is not worth the attack surface or the image weight.
 *
 * **Bounds are structural, not hopeful.** The walk below is the only thing driving work: Markdown
 * has no loops and this renderer evaluates nothing, so non-termination is not reachable by
 * construction. What *is* reachable is pathological-but-finite input — a million-item list, a
 * table that paginates forever — and that is what the input, page, byte and deadline caps catch.
 * The deadline is checked at every block boundary, which preempts because our loop owns the
 * stack.
 *
 * Model-authored content is untrusted input, so this module is hosted in the durable runtime and
 * never in the control plane. See `apps/worker/src/tools/local-host.ts`.
 */

import { marked, type Token, type Tokens } from "marked";
import PDFDocument from "pdfkit";

/** What an Agent may ask for. Every one of these is an allowed media type on the way back in. */
export const RENDER_FORMATS = ["pdf", "markdown", "text", "csv"] as const;
export type RenderFormat = (typeof RENDER_FORMATS)[number];

/**
 * Ceiling on what may be handed to the renderer.
 *
 * Sized at roughly a 100-page report. A model that wants more than this is not writing a document
 * a person will read; it is looping.
 */
export const MAX_RENDER_INPUT_CHARS = 200_000;

/** Ceiling on what comes out, enforced as the bytes arrive rather than after the fact. */
export const MAX_RENDER_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Pagination is where finite input turns into unbounded output, so it is capped directly. */
export const MAX_RENDER_PAGES = 200;

/** Wall clock the whole render must finish inside, checked at every block boundary. */
export const RENDER_TIMEOUT_MS = 10_000;

export type RenderRejection =
  | "input_too_large"
  | "empty"
  | "output_too_large"
  | "too_many_pages"
  | "timed_out";

export class RenderError extends Error {
  constructor(
    readonly reason: RenderRejection,
    message: string
  ) {
    super(message);
    this.name = "RenderError";
  }
}

export interface RenderRequest {
  readonly format: RenderFormat;
  /** Markdown for `pdf`; taken verbatim for every other format. */
  readonly content: string;
  /** Becomes the document's title metadata and its opening heading. */
  readonly title?: string;
}

export interface Rendered {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  /** Appended to the Agent's filename when it did not supply one that already matches. */
  readonly extension: string;
}

const PASSTHROUGH: Record<string, { mediaType: string; extension: string }> = {
  markdown: { mediaType: "text/markdown", extension: ".md" },
  text: { mediaType: "text/plain", extension: ".txt" },
  csv: { mediaType: "text/csv", extension: ".csv" },
};

/** The suffix a format lands as, so a caller can name the File before spending the render. */
export function extensionForFormat(format: RenderFormat): string {
  return format === "pdf" ? ".pdf" : PASSTHROUGH[format].extension;
}

export async function renderDocument(request: RenderRequest): Promise<Rendered> {
  const content = request.content;
  if (content.length > MAX_RENDER_INPUT_CHARS) {
    throw new RenderError(
      "input_too_large",
      `content is ${content.length} characters, over the ${MAX_RENDER_INPUT_CHARS} limit`
    );
  }
  if (content.trim() === "") throw new RenderError("empty", "content carried nothing to render");

  if (request.format !== "pdf") {
    const shape = PASSTHROUGH[request.format];
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength > MAX_RENDER_OUTPUT_BYTES) {
      throw new RenderError("output_too_large", "content exceeds the output size limit");
    }
    return { bytes, mediaType: shape.mediaType, extension: shape.extension };
  }

  return {
    bytes: await renderPdf(content, request.title),
    mediaType: "application/pdf",
    extension: ".pdf",
  };
}

const MARGIN = 54;
const BODY_SIZE = 11;
const CODE_SIZE = 9.5;
const HEADING_SIZES = [22, 17, 14, 12, 11, 11];

/** Tracks the caps that only a running render can observe, so every check reads one object. */
class Budget {
  private readonly deadline = Date.now() + RENDER_TIMEOUT_MS;
  bytes = 0;
  pages = 0;

  /** Called at every block boundary — the only points at which this renderer holds the stack. */
  checkpoint(): void {
    if (Date.now() > this.deadline) {
      throw new RenderError("timed_out", `render exceeded ${RENDER_TIMEOUT_MS}ms`);
    }
    if (this.pages > MAX_RENDER_PAGES) {
      throw new RenderError("too_many_pages", `render exceeded ${MAX_RENDER_PAGES} pages`);
    }
    if (this.bytes > MAX_RENDER_OUTPUT_BYTES) {
      throw new RenderError("output_too_large", "render exceeded the output size limit");
    }
  }
}

async function renderPdf(markdown: string, title?: string): Promise<Uint8Array> {
  const budget = new Budget();
  const doc = new PDFDocument({
    size: "A4",
    margin: MARGIN,
    info: title === undefined ? undefined : { Title: title },
    autoFirstPage: true,
  });

  const chunks: Uint8Array[] = [];
  doc.on("data", (chunk: Uint8Array) => {
    budget.bytes += chunk.byteLength;
    chunks.push(chunk);
  });
  doc.on("pageAdded", () => {
    budget.pages += 1;
  });
  budget.pages = 1;

  const finished = new Promise<void>((resolve, reject) => {
    doc.on("end", resolve);
    doc.on("error", reject);
  });

  try {
    if (title !== undefined && title.trim() !== "") {
      doc.font("Helvetica-Bold").fontSize(HEADING_SIZES[0]).text(title);
      doc.moveDown(0.8);
    }
    writeTokens(doc, marked.lexer(markdown), budget);
  } catch (error) {
    // The document is abandoned mid-stream; nothing downstream ever sees a partial file because
    // the bytes only leave this function on the success path.
    doc.end();
    await finished.catch(() => undefined);
    throw error;
  }

  doc.end();
  await finished;
  budget.checkpoint();
  return concatChunks(chunks, budget.bytes);
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

type Doc = InstanceType<typeof PDFDocument>;

function writeTokens(doc: Doc, tokens: readonly Token[], budget: Budget, depth = 0): void {
  for (const token of tokens) {
    budget.checkpoint();
    writeToken(doc, token, budget, depth);
  }
}

function writeToken(doc: Doc, token: Token, budget: Budget, depth: number): void {
  switch (token.type) {
    case "heading": {
      const heading = token as Tokens.Heading;
      const size = HEADING_SIZES[Math.min(heading.depth, HEADING_SIZES.length) - 1];
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(size).text(heading.text);
      doc.moveDown(0.35);
      return;
    }
    case "paragraph": {
      doc.font("Helvetica").fontSize(BODY_SIZE);
      writeInline(doc, (token as Tokens.Paragraph).tokens ?? [], BODY_SIZE);
      doc.moveDown(0.6);
      return;
    }
    case "code": {
      const code = token as Tokens.Code;
      doc.font("Courier").fontSize(CODE_SIZE).text(code.text, { indent: 12, lineGap: 1 });
      doc.moveDown(0.6);
      return;
    }
    case "blockquote": {
      const quote = token as Tokens.Blockquote;
      doc.font("Helvetica-Oblique").fontSize(BODY_SIZE);
      writeTokens(doc, quote.tokens ?? [], budget, depth + 1);
      return;
    }
    case "list": {
      writeList(doc, token as Tokens.List, budget, depth);
      return;
    }
    case "table": {
      writeTable(doc, token as Tokens.Table, budget);
      return;
    }
    case "hr": {
      const y = doc.y + 4;
      doc
        .moveTo(MARGIN, y)
        .lineTo(doc.page.width - MARGIN, y)
        .strokeColor("#cccccc")
        .stroke();
      doc.moveDown(1);
      return;
    }
    case "space":
      return;
    default: {
      const text = (token as { text?: string }).text;
      if (text === undefined || text.trim() === "") return;
      doc.font("Helvetica").fontSize(BODY_SIZE).text(text);
      doc.moveDown(0.4);
    }
  }
}

function writeList(doc: Doc, list: Tokens.List, budget: Budget, depth: number): void {
  const indent = 14 + depth * 14;
  let ordinal = Number(list.start === "" || list.start === undefined ? 1 : list.start);
  for (const item of list.items) {
    budget.checkpoint();
    const marker = list.ordered ? `${ordinal++}.` : "•";
    doc.font("Helvetica").fontSize(BODY_SIZE);
    const nested: Token[] = [];
    const inline: Token[] = [];
    for (const child of item.tokens ?? []) {
      (child.type === "list" ? nested : inline).push(child);
    }
    doc.text(`${marker}  `, { indent, continued: true });
    writeInline(doc, flattenInline(inline), BODY_SIZE);
    if (nested.length > 0) writeTokens(doc, nested, budget, depth + 1);
  }
  doc.moveDown(0.5);
}

/** A list item's children are blocks; their inline tokens are what a single line should carry. */
function flattenInline(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  for (const token of tokens) {
    const inner = (token as { tokens?: Token[] }).tokens;
    if (token.type === "text" || token.type === "paragraph") out.push(...(inner ?? [token]));
    else out.push(token);
  }
  return out;
}

function writeTable(doc: Doc, table: Tokens.Table, budget: Budget): void {
  const columns = table.header.length;
  if (columns === 0) return;
  const usable = doc.page.width - MARGIN * 2;
  const width = usable / columns;

  const row = (cells: readonly string[], bold: boolean): void => {
    budget.checkpoint();
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(BODY_SIZE - 1);
    const top = doc.y;
    let tallest = 0;
    cells.forEach((cell, index) => {
      doc.text(cell, MARGIN + index * width, top, { width: width - 8 });
      tallest = Math.max(tallest, doc.y - top);
      doc.y = top;
    });
    doc.y = top + tallest + 4;
  };

  row(
    table.header.map((cell) => cell.text),
    true
  );
  for (const cells of table.rows) {
    row(
      cells.map((cell) => cell.text),
      false
    );
  }
  doc.x = MARGIN;
  doc.moveDown(0.6);
}

/**
 * Emits inline tokens as one continued run so bold and code sit inside a wrapped paragraph.
 *
 * The final segment must close the run (`continued: false`); leaving it open makes pdfkit hold
 * the line and the next block lands on top of it.
 */
function writeInline(doc: Doc, tokens: readonly Token[], size: number): void {
  const segments =
    tokens.length === 0 ? [{ text: "", font: "Helvetica", size }] : inlineRuns(tokens, size);
  segments.forEach((segment, index) => {
    doc
      .font(segment.font)
      .fontSize(segment.size)
      .text(segment.text, { continued: index < segments.length - 1 });
  });
}

interface InlineRun {
  readonly text: string;
  readonly font: string;
  readonly size: number;
}

function inlineRuns(tokens: readonly Token[], size: number, font = "Helvetica"): InlineRun[] {
  const out: InlineRun[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        out.push(...inlineRuns((token as Tokens.Strong).tokens ?? [], size, "Helvetica-Bold"));
        break;
      case "em":
        out.push(...inlineRuns((token as Tokens.Em).tokens ?? [], size, "Helvetica-Oblique"));
        break;
      case "codespan":
        out.push({ text: (token as Tokens.Codespan).text, font: "Courier", size: size - 1 });
        break;
      case "br":
        out.push({ text: "\n", font, size });
        break;
      case "link": {
        const link = token as Tokens.Link;
        out.push(...inlineRuns(link.tokens ?? [], size, font));
        break;
      }
      default: {
        const nested = (token as { tokens?: Token[] }).tokens;
        if (nested !== undefined && nested.length > 0) out.push(...inlineRuns(nested, size, font));
        else out.push({ text: (token as { text?: string }).text ?? "", font, size });
      }
    }
  }
  return out.length === 0 ? [{ text: "", font, size }] : out;
}
