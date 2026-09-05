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

import { parseYamlDocument } from "@tulipfarm/schema";
import { marked, type Token, type Tokens } from "marked";
import type PDFDocument from "pdfkit";
import { renderDocx, renderPptx, renderXlsx } from "./office";
import { OOXML_MEDIA_TYPES } from "./ooxml";

/** What an Agent may ask for. Every one of these is an allowed media type on the way back in. */
export const RENDER_FORMATS = [
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "markdown",
  "text",
  "csv",
  "json",
  "xml",
  "yaml",
] as const;
export type RenderFormat = (typeof RENDER_FORMATS)[number];

/** The Office formats, which are OOXML packages rather than a single serialized body. */
const OFFICE: Record<string, { mediaType: string; extension: string }> = {
  docx: { mediaType: OOXML_MEDIA_TYPES.docx, extension: ".docx" },
  xlsx: { mediaType: OOXML_MEDIA_TYPES.xlsx, extension: ".xlsx" },
  pptx: { mediaType: OOXML_MEDIA_TYPES.pptx, extension: ".pptx" },
};

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
  | "invalid_content"
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
  /** Markdown for `pdf`; structured formats are validated, and plain formats stay verbatim. */
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

type PassthroughFormat = "markdown" | "text" | "csv" | "json" | "xml" | "yaml";

const PASSTHROUGH: Record<string, { mediaType: string; extension: string }> = {
  markdown: { mediaType: "text/markdown", extension: ".md" },
  text: { mediaType: "text/plain", extension: ".txt" },
  csv: { mediaType: "text/csv", extension: ".csv" },
  json: { mediaType: "application/json", extension: ".json" },
  xml: { mediaType: "application/xml", extension: ".xml" },
  yaml: { mediaType: "application/yaml", extension: ".yaml" },
};

/** The suffix a format lands as, so a caller can name the File before spending the render. */
export function extensionForFormat(format: RenderFormat): string {
  if (format === "pdf") return ".pdf";
  return (OFFICE[format] ?? PASSTHROUGH[format]).extension;
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

  if (request.format in OFFICE) return renderOffice(request);

  if (request.format !== "pdf") {
    const serialized = serializeStructuredText(request.format as PassthroughFormat, content);
    const shape = PASSTHROUGH[request.format];
    const bytes = new TextEncoder().encode(serialized);
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

/**
 * Builds an OOXML package.
 *
 * Output is bounded the same way the text formats are — after the fact rather than mid-stream,
 * because a zip is only measurable once it is closed. The input ceiling upstream is what actually
 * keeps that from being a memory problem; deflate never expands 200k characters past the ceiling.
 */
function renderOffice(request: RenderRequest): Rendered {
  const shape = OFFICE[request.format];
  let bytes: Uint8Array;
  try {
    if (request.format === "xlsx") bytes = renderXlsx(request.content, request.title);
    else if (request.format === "pptx") bytes = renderPptx(request.content, request.title);
    else bytes = renderDocx(request.content, request.title);
  } catch (error) {
    if (error instanceof RenderError) throw error;
    throw new RenderError("invalid_content", `${request.format} content could not be rendered`);
  }
  if (bytes.byteLength > MAX_RENDER_OUTPUT_BYTES) {
    throw new RenderError("output_too_large", "content exceeds the output size limit");
  }
  return { bytes, mediaType: shape.mediaType, extension: shape.extension };
}

function serializeStructuredText(format: PassthroughFormat, content: string): string {
  try {
    if (format === "json") return `${JSON.stringify(JSON.parse(content), null, 2)}\n`;
    if (format === "yaml") {
      if (/(?:^|[\s[{,:-])(?:![^\s]|[&*][A-Za-z0-9_-]+)|(?:^|\n)\s*<<\s*:/m.test(content)) {
        throw new RenderError(
          "invalid_content",
          "yaml tags, anchors, aliases, and merge keys are not supported"
        );
      }
      return `${serializeYaml(parseYamlDocument(content))}\n`;
    }
    if (format === "xml") validateXml(content);
    return content;
  } catch (error) {
    if (error instanceof RenderError) throw error;
    throw new RenderError("invalid_content", `${format} content is not valid`);
  }
}

function yamlScalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new RenderError("invalid_content", "yaml content contains a non-finite number");
  }
  return String(value);
}

function serializeYaml(value: unknown, depth = 0): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return yamlScalar(value);
  }
  const indent = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        const rendered = serializeYaml(item, depth + 1);
        return rendered.includes("\n")
          ? `${indent}-\n${rendered}`
          : `${indent}- ${rendered.trimStart()}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    if (entries.length === 0) return "{}";
    return entries
      .map(([key, item]) => {
        const rendered = serializeYaml(item, depth + 1);
        const prefix = `${indent}${JSON.stringify(key)}:`;
        return rendered.includes("\n")
          ? `${prefix}\n${rendered}`
          : `${prefix} ${rendered.trimStart()}`;
      })
      .join("\n");
  }
  throw new RenderError("invalid_content", "yaml content contains an unsupported value");
}

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*/;
const XML_ENTITY = /&(?:amp|lt|gt|apos|quot|#\d+|#x[0-9a-fA-F]+);/g;

function validateXmlEntities(value: string): void {
  if (value.replace(XML_ENTITY, "").includes("&")) {
    throw new RenderError("invalid_content", "xml content contains an unsupported entity");
  }
}

function xmlTagEnd(source: string, start: number): number {
  let quote: "'" | '"' | undefined;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === ">") return index;
  }
  return -1;
}

function validateXmlTag(raw: string): { name: string; selfClosing: boolean } {
  const trimmed = raw.trim();
  const selfClosing = trimmed.endsWith("/");
  const body = selfClosing ? trimmed.slice(0, -1).trimEnd() : trimmed;
  const name = body.match(XML_NAME)?.[0];
  if (name === undefined) throw new RenderError("invalid_content", "xml tag name is invalid");
  if (/(?:^|:)include$/i.test(name)) {
    throw new RenderError("invalid_content", "xml include elements are not supported");
  }

  let rest = body.slice(name.length);
  const names = new Set<string>();
  while (rest.trim().length > 0) {
    const match = rest.match(/^\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/);
    if (match === null) throw new RenderError("invalid_content", "xml attributes are invalid");
    const attribute = match[1];
    if (names.has(attribute)) {
      throw new RenderError("invalid_content", `xml attribute ${attribute} is duplicated`);
    }
    names.add(attribute);
    const value = match[3] ?? match[4] ?? "";
    if (value.includes("<")) {
      throw new RenderError("invalid_content", "xml attributes cannot contain '<'");
    }
    validateXmlEntities(value);
    rest = rest.slice(match[0].length);
  }
  return { name, selfClosing };
}

function validateXml(source: string): void {
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(source)) {
    throw new RenderError(
      "invalid_content",
      "xml declarations with external behavior are not supported"
    );
  }

  const stack: string[] = [];
  let roots = 0;
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    const text = open === -1 ? source.slice(cursor) : source.slice(cursor, open);
    if (text.includes("]]>")) {
      throw new RenderError("invalid_content", "xml text contains an invalid CDATA terminator");
    }
    validateXmlEntities(text);
    if (stack.length === 0 && text.trim().length > 0) {
      throw new RenderError("invalid_content", "xml content must have one root element");
    }
    if (open === -1) break;

    if (source.startsWith("<!--", open)) {
      const close = source.indexOf("-->", open + 4);
      if (close === -1 || source.slice(open + 4, close).includes("--")) {
        throw new RenderError("invalid_content", "xml comment is invalid");
      }
      cursor = close + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      if (stack.length === 0) {
        throw new RenderError("invalid_content", "xml CDATA must be inside the root element");
      }
      const close = source.indexOf("]]>", open + 9);
      if (close === -1) throw new RenderError("invalid_content", "xml CDATA is not closed");
      cursor = close + 3;
      continue;
    }
    if (source.startsWith("<?xml", open) && source.slice(0, open).trim().length === 0) {
      const close = source.indexOf("?>", open + 5);
      if (close === -1) throw new RenderError("invalid_content", "xml declaration is not closed");
      cursor = close + 2;
      continue;
    }
    if (source.startsWith("<!", open) || source.startsWith("<?", open)) {
      throw new RenderError("invalid_content", "xml directives are not supported");
    }

    const close = xmlTagEnd(source, open + 1);
    if (close === -1) throw new RenderError("invalid_content", "xml tag is not closed");
    const raw = source.slice(open + 1, close);
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      if (!XML_NAME.test(name) || XML_NAME.exec(name)?.[0] !== name) {
        throw new RenderError("invalid_content", "xml closing tag is invalid");
      }
      if (stack.pop() !== name) {
        throw new RenderError("invalid_content", `xml closing tag ${name} does not match`);
      }
    } else {
      if (stack.length === 0) roots += 1;
      const tag = validateXmlTag(raw);
      if (!tag.selfClosing) stack.push(tag.name);
    }
    cursor = close + 1;
  }
  if (roots !== 1 || stack.length > 0) {
    throw new RenderError("invalid_content", "xml content must have one closed root element");
  }
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
  // Loaded here rather than at module scope because this module is reachable from the package
  // barrel, and the web client imports constants from that barrel. A static import makes a bundler
  // pull pdfkit — which touches `process` — into the browser, where evaluating it kills the page.
  // `unpdf` in extract.ts and `jimp` in bound.ts are deferred for the same reason.
  const { default: PdfDocument } = await import("pdfkit");
  const budget = new Budget();
  const doc = new PdfDocument({
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
