/**
 * Writing the three Office formats — Word, Excel and PowerPoint — as OOXML packages.
 *
 * Two choices are settled here, and they are the same two `render.ts` settles for PDF.
 *
 * **The parts are written directly, not through a document library.** `docx`, `exceljs` and
 * `pptxgenjs` are each a large dependency whose whole value is expressiveness we deliberately do
 * not want: an Agent-authored report needs headings, lists, tables and slides, and nothing here
 * needs a chart engine, an image pipeline or a formula evaluator. Writing the parts means the
 * bytes leaving this process are exactly the elements enumerated below — there is no feature an
 * Agent can reach for that we did not write down, which is the property that makes this auditable.
 *
 * **Every part is inert.** An OOXML package can carry a macro (`vbaProject.bin`), an external
 * relationship, an OLE object, a remote image and a DDE link. None of those parts is emitted, no
 * relationship uses `TargetMode="External"`, and the content types below declare the macro-free
 * document types, so a reader that honours the manifest has nothing to activate. Content reaches
 * these files only as XML *text*, escaped by {@link xml}, never as markup.
 *
 * The container is a ZIP with no compression tricks: `fflate` sync deflate, one pass, no streaming
 * and no entry the caller names.
 */

import { zipSync } from "fflate";

/** The macro-free media types. `.docm`/`.xlsm`/`.pptm` are absent on purpose — see the header. */
export const OOXML_MEDIA_TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;

export type OoxmlFormat = keyof typeof OOXML_MEDIA_TYPES;

const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/**
 * Escapes text for an XML text node or attribute value.
 *
 * `<`, `>` and `&` are the markup injection; the two quotes are escaped as well so one helper is
 * correct in both positions and no caller has to remember which it is in. Characters XML 1.0
 * cannot represent at all are dropped rather than escaped, because a numeric reference to them is
 * equally illegal and would produce a file that opens as corrupt.
 */
export function xml(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (char === "&") out += "&amp;";
    else if (char === "<") out += "&lt;";
    else if (char === ">") out += "&gt;";
    else if (char === '"') out += "&quot;";
    else if (char === "'") out += "&apos;";
    else out += char;
  }
  return out;
}

/** One `<Relationship>` line. `TargetMode` is never set, so no target may leave the package. */
function relationship(id: string, type: string, target: string): string {
  return `<Relationship Id="${id}" Type="${OFFICE_REL}/${type}" Target="${target}"/>`;
}

function relationships(entries: readonly string[]): string {
  return `${DECLARATION}<Relationships xmlns="${RELS_NS}">${entries.join("")}</Relationships>`;
}

function packageRels(target: string): string {
  return relationships([relationship("rId1", "officeDocument", target)]);
}

const encoder = new TextEncoder();

/**
 * A fixed timestamp, so the same content always produces byte-identical output.
 *
 * The zip epoch starts in 1980 and fflate rejects anything before it, so this is the earliest
 * value it will accept rather than a date that means anything.
 */
const FIXED_MTIME = new Date(Date.UTC(1980, 0, 1));

/** Zips the parts in the given order; `[Content_Types].xml` must be the entry a reader finds. */
function pack(parts: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, body] of Object.entries(parts)) entries[path] = encoder.encode(body);
  return zipSync(entries, { level: 6, mtime: FIXED_MTIME });
}

// --------------------------------------------------------------------------------------------
// The document model
//
// One small vocabulary all three writers consume, so `render.ts` walks Markdown exactly once and
// each format decides only how a block looks. Anything Markdown can express that is not in this
// union is flattened to a paragraph by the caller rather than silently dropped here.
// --------------------------------------------------------------------------------------------

/** A styled span of text. Every field is presentational; none carries a link or a reference. */
export interface DocSpan {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly code?: boolean;
}

export type DocBlock =
  | { readonly kind: "heading"; readonly level: number; readonly spans: readonly DocSpan[] }
  | { readonly kind: "paragraph"; readonly spans: readonly DocSpan[] }
  | { readonly kind: "quote"; readonly spans: readonly DocSpan[] }
  | { readonly kind: "code"; readonly text: string }
  | {
      readonly kind: "listItem";
      readonly ordered: boolean;
      readonly depth: number;
      readonly spans: readonly DocSpan[];
    }
  | {
      readonly kind: "table";
      readonly header: readonly string[];
      readonly rows: readonly (readonly string[])[];
    }
  | { readonly kind: "rule" };

/** One slide: a title and the bullet lines beneath it, already flattened by the caller. */
export interface DocSlide {
  readonly title: string;
  readonly bullets: readonly { readonly text: string; readonly depth: number }[];
}

// --------------------------------------------------------------------------------------------
// Word
// --------------------------------------------------------------------------------------------

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const HEADING_STYLES = ["Heading1", "Heading2", "Heading3", "Heading4", "Heading5", "Heading6"];

function runs(spans: readonly DocSpan[]): string {
  if (spans.length === 0) return "";
  return spans
    .filter((span) => span.text !== "")
    .map((span) => {
      const properties = [
        span.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : "",
        span.bold ? "<w:b/>" : "",
        span.italic ? "<w:i/>" : "",
      ].join("");
      const rPr = properties === "" ? "" : `<w:rPr>${properties}</w:rPr>`;
      return `<w:r>${rPr}<w:t xml:space="preserve">${xml(span.text)}</w:t></w:r>`;
    })
    .join("");
}

function paragraph(spans: readonly DocSpan[], properties = ""): string {
  const pPr = properties === "" ? "" : `<w:pPr>${properties}</w:pPr>`;
  return `<w:p>${pPr}${runs(spans)}</w:p>`;
}

function wordBlock(block: DocBlock): string {
  switch (block.kind) {
    case "heading": {
      const style = HEADING_STYLES[Math.min(block.level, HEADING_STYLES.length) - 1];
      return paragraph(block.spans, `<w:pStyle w:val="${style}"/>`);
    }
    case "paragraph":
      return paragraph(block.spans);
    case "quote":
      return paragraph(block.spans, '<w:pStyle w:val="Quote"/>');
    case "code":
      // Split so a fenced block keeps its line breaks: Word has no multi-line text run.
      return block.text
        .split("\n")
        .map((line) => paragraph([{ text: line, code: true }], '<w:pStyle w:val="Code"/>'))
        .join("");
    case "listItem": {
      const numId = block.ordered ? 2 : 1;
      const level = Math.min(block.depth, 8);
      const style = block.ordered ? "ListNumber" : "ListBullet";
      return paragraph(
        block.spans,
        `<w:pStyle w:val="${style}"/>` +
          `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`
      );
    }
    case "table": {
      const cell = (text: string, bold: boolean): string =>
        `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraph([{ text, bold }])}</w:tc>`;
      const header = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${block.header
        .map((text) => cell(text, true))
        .join("")}</w:tr>`;
      const body = block.rows
        .map((row) => `<w:tr>${row.map((text) => cell(text, false)).join("")}</w:tr>`)
        .join("");
      return (
        '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>' +
        '<w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0"/></w:tblPr>' +
        `${header}${body}</w:tbl>${paragraph([])}`
      );
    }
    case "rule":
      return paragraph(
        [],
        '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr>'
      );
  }
}

/**
 * Numbering reaches a reader two ways, and lenient importers only honour one of them.
 *
 * Word resolves the `w:numPr` written inline on the paragraph, so that alone is correct per the
 * spec. But several importers — macOS Quick Look and some web viewers among them — only apply a
 * list when the paragraph's *style* is a recognised list style, and silently drop the bullet
 * otherwise. Carrying the same `numId` in both places costs nothing and renders in both.
 */
const LIST_STYLES = [
  { id: "ListBullet", name: "List Bullet", numId: 1 },
  { id: "ListNumber", name: "List Number", numId: 2 },
] as const;

const WORD_STYLES = `${DECLARATION}<w:styles xmlns:w="${W_NS}">\
<w:docDefaults><w:rPrDefault><w:rPr>\
<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/>\
</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>\
<w:spacing w:after="160" w:line="264" w:lineRule="auto"/>\
</w:pPr></w:pPrDefault></w:docDefaults>\
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>\
${HEADING_STYLES.map((style, index) => {
  const size = [36, 30, 26, 24, 22, 22][index];
  return `<w:style w:type="paragraph" w:styleId="${style}"><w:name w:val="heading ${index + 1}"/>\
<w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="${index}"/>\
<w:spacing w:before="${index === 0 ? 240 : 200}" w:after="120"/></w:pPr>\
<w:rPr><w:b/><w:color w:val="1F2933"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
}).join("")}\
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>\
<w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/><w:color w:val="52606D"/></w:rPr></w:style>\
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="HTML Preformatted"/>\
<w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/>\
<w:ind w:left="360"/></w:pPr>\
<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>\
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>\
<w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="80"/><w:contextualSpacing/></w:pPr></w:style>\
${LIST_STYLES.map(
  ({ id, name, numId }) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>\
<w:basedOn w:val="ListParagraph"/>\
<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr></w:style>`
).join("")}\
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>\
<w:tblPr><w:tblBorders>\
${["top", "left", "bottom", "right", "insideH", "insideV"]
  .map((edge) => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="BFC7D1"/>`)
  .join("")}\
</w:tblBorders><w:tblCellMar>\
<w:top w:w="60" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>\
<w:bottom w:w="60" w:type="dxa"/><w:right w:w="108" w:type="dxa"/>\
</w:tblCellMar></w:tblPr></w:style>\
</w:styles>`;

/**
 * Nine levels each, so a deeply nested list still resolves to a real numbering definition.
 *
 * Level 0 carries a `w:pStyle` back-reference to the matching list style. Word does not need it —
 * it resolves the paragraph's own `w:numPr` — but importers that key numbering off the paragraph
 * style follow this edge to find the level, and drop the bullet entirely without it.
 */
const WORD_NUMBERING = `${DECLARATION}<w:numbering xmlns:w="${W_NS}">\
<w:abstractNum w:abstractNumId="0"><w:nsid w:val="0A1B2C3D"/>\
<w:multiLevelType w:val="hybridMultilevel"/>\
${Array.from({ length: 9 }, (_, level) => {
  // Escapes, not literals: these are Symbol/Wingdings private-use codepoints, and an editor or
  // pipeline that normalises the file can silently eat the raw glyph, leaving a bullet-less list.
  const bullet = ["\uf0b7", "o", "\uf0a7"][level % 3];
  const font = level % 3 === 0 ? "Symbol" : level % 3 === 1 ? "Courier New" : "Wingdings";
  return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>\
${level === 0 ? '<w:pStyle w:val="ListBullet"/>' : ""}\
<w:lvlText w:val="${xml(bullet)}"/><w:lvlJc w:val="left"/>\
<w:pPr><w:ind w:left="${(level + 1) * 360}" w:hanging="360"/></w:pPr>\
<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:hint="default"/></w:rPr></w:lvl>`;
}).join("")}</w:abstractNum>\
<w:abstractNum w:abstractNumId="1"><w:nsid w:val="0A1B2C3E"/>\
<w:multiLevelType w:val="hybridMultilevel"/>\
${Array.from({ length: 9 }, (_, level) => {
  const format = ["decimal", "lowerLetter", "lowerRoman"][level % 3];
  return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>\
${level === 0 ? '<w:pStyle w:val="ListNumber"/>' : ""}\
<w:lvlText w:val="%${level + 1}."/><w:lvlJc w:val="left"/>\
<w:pPr><w:ind w:left="${(level + 1) * 360}" w:hanging="360"/></w:pPr></w:lvl>`;
}).join("")}</w:abstractNum>\
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>\
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>\
</w:numbering>`;

export function buildDocx(blocks: readonly DocBlock[], title?: string): Uint8Array {
  const trimmed = title?.trim() ?? "";
  const first = blocks[0];
  // The title is a fallback, not an addition. Content that already opens with its own top-level
  // heading owns the first line, and prepending here would print the same heading twice.
  const opensWithHeading = first !== undefined && first.kind === "heading" && first.level === 1;
  const heading =
    trimmed === "" || opensWithHeading
      ? ""
      : paragraph([{ text: trimmed }], '<w:pStyle w:val="Heading1"/>');
  const body = blocks.map(wordBlock).join("");
  const sectPr =
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" ' +
    'w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>';

  return pack({
    "[Content_Types].xml":
      `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/word/document.xml" ContentType="${OOXML_MEDIA_TYPES.docx.replace(
        ".document",
        ".document.main+xml"
      )}"/>` +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
      "</Types>",
    "_rels/.rels": packageRels("word/document.xml"),
    "word/_rels/document.xml.rels": relationships([
      relationship("rId1", "styles", "styles.xml"),
      relationship("rId2", "numbering", "numbering.xml"),
    ]),
    "word/document.xml": `${DECLARATION}<w:document xmlns:w="${W_NS}"><w:body>${heading}${body}${sectPr}</w:body></w:document>`,
    "word/styles.xml": WORD_STYLES,
    "word/numbering.xml": WORD_NUMBERING,
  });
}

// --------------------------------------------------------------------------------------------
// Excel
// --------------------------------------------------------------------------------------------

const S_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/** `0 -> A`, `26 -> AA`. Excel addresses are base-26 with no zero digit, so this is not a radix. */
export function columnName(index: number): string {
  let name = "";
  let remaining = index;
  while (remaining >= 0) {
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26) - 1;
  }
  return name;
}

/**
 * True when the cell should be stored as a number rather than as text.
 *
 * Deliberately narrow. A leading zero, a `+`, whitespace or an exponent all round-trip badly — an
 * order id like `007` becoming `7` is a data loss no spreadsheet user asked for — so anything that
 * is not exactly how JavaScript prints the number stays text.
 */
export function isNumericCell(value: string): boolean {
  if (value === "" || value.length > 15) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && String(parsed) === value;
}

/**
 * Cells are written as inline strings, so there is no shared-string table.
 *
 * The table is an interning optimisation for workbooks with heavy repetition; here it would add a
 * second part that must stay index-consistent with the sheet, and an inconsistency between them
 * is a file that opens with the wrong text in every cell. Inline is bigger and cannot desync.
 */
function sheetCell(row: number, column: number, value: string, header: boolean): string {
  const reference = `${columnName(column)}${row}`;
  const style = header ? ' s="1"' : "";
  if (isNumericCell(value)) return `<c r="${reference}"${style}><v>${value}</v></c>`;
  if (value === "") return `<c r="${reference}"${style}/>`;
  return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(
    value
  )}</t></is></c>`;
}

export function buildXlsx(
  rows: readonly (readonly string[])[],
  options: { readonly sheetName?: string; readonly headerRow?: boolean } = {}
): Uint8Array {
  const headerRow = options.headerRow ?? true;
  // Excel rejects a sheet name carrying any of these, and silently truncates past 31 characters.
  const sheetName = (options.sheetName ?? "Sheet1").replace(/[[\]:*?/\\]/g, " ").slice(0, 31);
  const widest = rows.reduce((most, row) => Math.max(most, row.length), 0);

  const body = rows
    .map((row, index) => {
      const cells = row
        .map((value, column) => sheetCell(index + 1, column, value, headerRow && index === 0))
        .join("");
      return `<row r="${index + 1}">${cells}</row>`;
    })
    .join("");

  const dimension =
    rows.length === 0 ? "A1" : `A1:${columnName(Math.max(widest, 1) - 1)}${rows.length}`;
  const frozen =
    headerRow && rows.length > 1
      ? '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView>'
      : '<sheetView workbookViewId="0"/>';

  return pack({
    "[Content_Types].xml":
      `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      "</Types>",
    "_rels/.rels": packageRels("xl/workbook.xml"),
    "xl/_rels/workbook.xml.rels": relationships([
      relationship("rId1", "worksheet", "worksheets/sheet1.xml"),
      relationship("rId2", "styles", "styles.xml"),
    ]),
    "xl/workbook.xml":
      `${DECLARATION}<workbook xmlns="${S_NS}" xmlns:r="${OFFICE_REL}">` +
      `<sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/worksheets/sheet1.xml":
      `${DECLARATION}<worksheet xmlns="${S_NS}"><sheetViews>${frozen}</sheetViews>` +
      `<dimension ref="${dimension}"/>` +
      `<sheetFormatPr defaultRowHeight="15"/><sheetData>${body}</sheetData></worksheet>`,
    "xl/styles.xml":
      `${DECLARATION}<styleSheet xmlns="${S_NS}">` +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
      "</styleSheet>",
  });
}

// --------------------------------------------------------------------------------------------
// PowerPoint
// --------------------------------------------------------------------------------------------

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
/** 16:9 at 914400 EMU per inch: 13.333in x 7.5in. */
const SLIDE_WIDTH = 12192000;
const SLIDE_HEIGHT = 6858000;

function shapeTree(shapes: string): string {
  return (
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    `${shapes}</p:spTree>`
  );
}

function textShape(
  id: number,
  name: string,
  placeholder: string,
  frame: { x: number; y: number; cx: number; cy: number },
  paragraphs: string
): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xml(name)}"/>` +
    '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    `<p:nvPr><p:ph type="${placeholder}"${placeholder === "body" ? ' idx="1"' : ""}/></p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${frame.x}" y="${frame.y}"/>` +
    `<a:ext cx="${frame.cx}" cy="${frame.cy}"/></a:xfrm></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
  );
}

const TITLE_FRAME = { x: 838200, y: 685800, cx: SLIDE_WIDTH - 1676400, cy: 1143000 };
const BODY_FRAME = { x: 838200, y: 2000250, cx: SLIDE_WIDTH - 1676400, cy: 3810000 };

function slidePart(slide: DocSlide): string {
  const title = `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${xml(slide.title)}</a:t></a:r></a:p>`;
  const bullets =
    slide.bullets.length === 0
      ? "<a:p/>"
      : slide.bullets
          .map((bullet) => {
            const level = Math.min(bullet.depth, 8);
            const pPr = level === 0 ? "" : `<a:pPr lvl="${level}"/>`;
            return `<a:p>${pPr}<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${xml(
              bullet.text
            )}</a:t></a:r></a:p>`;
          })
          .join("");

  return (
    `${DECLARATION}<p:sld xmlns:a="${A_NS}" xmlns:r="${OFFICE_REL}" xmlns:p="${P_NS}"><p:cSld>` +
    shapeTree(
      textShape(2, "Title 1", "title", TITLE_FRAME, title) +
        textShape(3, "Content Placeholder 2", "body", BODY_FRAME, bullets)
    ) +
    "</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
  );
}

const THEME = `${DECLARATION}<a:theme xmlns:a="${A_NS}" name="TulipFarm"><a:themeElements>\
<a:clrScheme name="TulipFarm"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>\
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2933"/></a:dk2>\
<a:lt2><a:srgbClr val="F5F7FA"/></a:lt2><a:accent1><a:srgbClr val="E8543F"/></a:accent1>\
<a:accent2><a:srgbClr val="2E5AAC"/></a:accent2><a:accent3><a:srgbClr val="3C9D6E"/></a:accent3>\
<a:accent4><a:srgbClr val="C99A2E"/></a:accent4><a:accent5><a:srgbClr val="7A5AA8"/></a:accent5>\
<a:accent6><a:srgbClr val="4A7C8C"/></a:accent6><a:hlink><a:srgbClr val="2E5AAC"/></a:hlink>\
<a:folHlink><a:srgbClr val="7A5AA8"/></a:folHlink></a:clrScheme>\
<a:fontScheme name="TulipFarm"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/>\
<a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/>\
<a:cs typeface=""/></a:minorFont></a:fontScheme>\
<a:fmtScheme name="TulipFarm">\
<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>\
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>\
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>\
<a:lnStyleLst>\
<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>\
<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>\
<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>\
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>\
<a:effectStyle><a:effectLst/></a:effectStyle>\
<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>\
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>\
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>\
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>\
</a:fmtScheme></a:themeElements></a:theme>`;

const SLIDE_MASTER = `${DECLARATION}<p:sldMaster xmlns:a="${A_NS}" xmlns:r="${OFFICE_REL}" xmlns:p="${P_NS}">\
<p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="lt1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>\
${shapeTree(
  textShape(2, "Title Placeholder 1", "title", TITLE_FRAME, "<a:p/>") +
    textShape(3, "Text Placeholder 2", "body", BODY_FRAME, "<a:p/>")
)}</p:cSld>\
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" \
accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" \
folHlink="folHlink"/>\
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>\
<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4000" b="1"/></a:lvl1pPr></p:titleStyle>\
<p:bodyStyle>${Array.from({ length: 9 }, (_, level) => {
  const size = [2400, 2000, 1800, 1600, 1600, 1400, 1400, 1400, 1400][level];
  return `<a:lvl${level + 1}pPr marL="${(level + 1) * 342900}" indent="-342900">\
<a:buFont typeface="Arial"/><a:buChar char="\u2022"/><a:defRPr sz="${size}"/></a:lvl${level + 1}pPr>`;
}).join("")}</p:bodyStyle>\
<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;

const SLIDE_LAYOUT = `${DECLARATION}<p:sldLayout xmlns:a="${A_NS}" xmlns:r="${OFFICE_REL}" \
xmlns:p="${P_NS}" type="obj" preserve="1"><p:cSld name="Title and Content">\
${shapeTree(
  textShape(2, "Title 1", "title", TITLE_FRAME, "<a:p/>") +
    textShape(3, "Content Placeholder 2", "body", BODY_FRAME, "<a:p/>")
)}</p:cSld>\
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

export function buildPptx(slides: readonly DocSlide[]): Uint8Array {
  const present = slides.length === 0 ? [{ title: "Untitled", bullets: [] }] : slides;
  const parts: Record<string, string> = {
    "[Content_Types].xml":
      `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
      '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      present
        .map(
          (_, index) =>
            `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
        )
        .join("") +
      "</Types>",
    "_rels/.rels": packageRels("ppt/presentation.xml"),
    "ppt/_rels/presentation.xml.rels": relationships([
      relationship("rId1", "slideMaster", "slideMasters/slideMaster1.xml"),
      relationship("rId2", "theme", "theme/theme1.xml"),
      ...present.map((_, index) =>
        relationship(`rId${index + 3}`, "slide", `slides/slide${index + 1}.xml`)
      ),
    ]),
    "ppt/presentation.xml":
      `${DECLARATION}<p:presentation xmlns:a="${A_NS}" xmlns:r="${OFFICE_REL}" xmlns:p="${P_NS}">` +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      `<p:sldIdLst>${present
        .map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 3}"/>`)
        .join("")}</p:sldIdLst>` +
      `<p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}"/>` +
      '<p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
    "ppt/slideMasters/slideMaster1.xml": SLIDE_MASTER,
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": relationships([
      relationship("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"),
      relationship("rId2", "theme", "../theme/theme1.xml"),
    ]),
    "ppt/slideLayouts/slideLayout1.xml": SLIDE_LAYOUT,
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": relationships([
      relationship("rId1", "slideMaster", "../slideMasters/slideMaster1.xml"),
    ]),
    "ppt/theme/theme1.xml": THEME,
  };

  present.forEach((slide, index) => {
    parts[`ppt/slides/slide${index + 1}.xml`] = slidePart(slide);
    parts[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = relationships([
      relationship("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"),
    ]);
  });

  return pack(parts);
}
