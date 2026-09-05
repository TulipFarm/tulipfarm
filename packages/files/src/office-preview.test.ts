import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { renderDocx, renderPptx, renderXlsx } from "./office";
import {
  boundedUnzip,
  isOfficePreviewable,
  MAX_PREVIEW_UNZIPPED_BYTES,
  previewOffice,
} from "./office-preview";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

describe("previewOffice", () => {
  it("reads back the document this package writes", () => {
    const blocks = previewOffice(
      renderDocx("# Title\n\nA paragraph.\n\n## Sub\n\n- one\n- two\n", "Title"),
      DOCX
    );
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", text: "A paragraph." },
      { kind: "heading", level: 2, text: "Sub" },
      { kind: "listItem", text: "one" },
      { kind: "listItem", text: "two" },
    ]);
  });

  it("keeps a table's rows together and in document order", () => {
    const blocks = previewOffice(
      renderDocx("Before\n\n| h1 | h2 |\n| --- | --- |\n| a | b |\n\nAfter\n", "T"),
      DOCX
    );
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "table", "paragraph"]);
    const table = blocks[2];
    if (table?.kind !== "table") throw new Error("expected a table");
    expect(table.rows).toEqual([
      ["h1", "h2"],
      ["a", "b"],
    ]);
  });

  it("reads a worksheet's grid and its name", () => {
    const blocks = previewOffice(renderXlsx("id,name\n1,Muskan\n2,Jane\n", "Orders"), XLSX);
    expect(blocks).toEqual([
      {
        kind: "sheet",
        name: "Orders",
        rows: [
          ["id", "name"],
          ["1", "Muskan"],
          ["2", "Jane"],
        ],
      },
    ]);
  });

  it("leaves a gap where a row skips a column rather than shifting later cells left", () => {
    // A real spreadsheet omits empty cells entirely, so a reader that appends in encounter order
    // silently moves every following value one column left.
    const blocks = previewOffice(renderXlsx("a,b,c\n1,,3\n", "S"), XLSX);
    const sheet = blocks[0];
    if (sheet?.kind !== "sheet") throw new Error("expected a sheet");
    expect(sheet.rows[1]).toEqual(["1", "", "3"]);
  });

  it("reads slides in deck order, not lexical order", () => {
    const many = Array.from({ length: 12 }, (_, i) => `# S${i + 1}\n\n- b${i + 1}`).join("\n\n");
    const blocks = previewOffice(renderPptx(many, "Deck"), PPTX);
    expect(blocks).toHaveLength(12);
    const titles = blocks.map((b) => (b.kind === "slide" ? b.title : ""));
    expect(titles[9]).toBe("S10");
    expect(titles[11]).toBe("S12");
  });

  it("resolves a shared-string cell, which is how real spreadsheets store text", () => {
    // Hand-built rather than rendered, because this package writes inline strings and would
    // otherwise never exercise the path every uploaded .xlsx takes.
    const parts = unzipToRecord(renderXlsx("a\n1\n", "S"));
    parts["xl/sharedStrings.xml"] = encode('<?xml version="1.0"?><sst><si><t>Hello</t></si></sst>');
    parts["xl/worksheets/sheet1.xml"] = encode(
      '<?xml version="1.0"?><worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' +
        "</sheetData></worksheet>"
    );
    const sheet = previewOffice(zipFromRecord(parts), XLSX)[0];
    if (sheet?.kind !== "sheet") throw new Error("expected a sheet");
    expect(sheet.rows[0]).toEqual(["Hello"]);
  });

  it("unescapes entities instead of showing their markup", () => {
    const blocks = previewOffice(renderDocx('5 < 6 & "quoted"\n', "T"), DOCX);
    expect(blocks.some((b) => b.kind === "paragraph" && b.text === '5 < 6 & "quoted"')).toBe(true);
  });

  it("knows which media types it can read", () => {
    expect(isOfficePreviewable(DOCX)).toBe(true);
    expect(isOfficePreviewable("application/pdf")).toBe(false);
    expect(() => previewOffice(new Uint8Array(), "application/pdf")).toThrow();
  });
});

describe("an Office package that expands far beyond its own size", () => {
  it("reads what fits in the budget and leaves the rest, rather than allocating it", () => {
    // A ZIP of a few kilobytes can declare gigabytes of contents. Nothing downstream can help: the
    // block and row limits bound what is parsed, and the expansion happens before parsing starts.
    const bomb = new Uint8Array(MAX_PREVIEW_UNZIPPED_BYTES + 1024);
    const parts = {
      "word/document.xml": encode(
        `<w:document><w:body><w:p><w:r><w:t>readable</w:t></w:r></w:p></w:body></w:document>`
      ),
      "word/media/huge.bin": bomb,
    };
    const packed = zipFromRecord(parts);
    expect(packed.byteLength).toBeLessThan(MAX_PREVIEW_UNZIPPED_BYTES);

    const blocks = previewOffice(
      packed,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );

    expect(blocks).toEqual([{ kind: "paragraph", text: "readable" }]);
    // The document part is read; the entry that would blow the budget is never expanded.
    expect(Object.keys(boundedUnzip(packed))).toEqual(["word/document.xml"]);
  });
});

describe("a spreadsheet that places a cell beyond the last column", () => {
  it("drops the cell instead of padding a row out to the index it names", () => {
    // The reference is text from a file this process did not write, and the row is padded out to
    // whatever index it decodes to. `ZZZZZZ1` asks for three hundred million cells from an archive
    // of a few hundred bytes.
    const sheet = `<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>kept</t></is></c><c r="ZZZZZZ1" t="inlineStr"><is><t>absurd</t></is></c></row></sheetData></worksheet>`;
    const packed = zipFromRecord({
      "xl/workbook.xml": encode(`<workbook><sheets><sheet name="Sheet1"/></sheets></workbook>`),
      "xl/worksheets/sheet1.xml": encode(sheet),
    });

    const blocks = previewOffice(
      packed,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    expect(blocks).toEqual([{ kind: "sheet", name: "Sheet1", rows: [["kept"]] }]);
  });
});

describe("an Office package whose entries lie about their size", () => {
  it("charges a stored entry the bytes it actually carries, not the zero it declares", () => {
    // `originalSize` is metadata the archive author chose. A stored entry is copied at its
    // compressed size, so an entry declaring zero and carrying megabytes would pass a budget spent
    // on the declaration alone — and the bound would refuse only honest bombs.
    const payload = new Uint8Array(MAX_PREVIEW_UNZIPPED_BYTES / 2 + 1024);
    const packed = liesAboutUncompressedSize(
      zipSync(
        {
          "word/document.xml": encode(
            `<w:document><w:body><w:p><w:r><w:t>readable</w:t></w:r></w:p></w:body></w:document>`
          ),
          "word/media/a.bin": payload,
          "word/media/b.bin": payload,
        },
        { level: 0 }
      ),
      "word/media/"
    );

    const read = Object.keys(boundedUnzip(packed));

    expect(read).toContain("word/document.xml");
    // Two of them together exceed the budget, so at most one may be admitted.
    expect(read.filter((name) => name.startsWith("word/media/")).length).toBeLessThan(2);
  });
});

/** Rewrites the declared uncompressed size of every matching entry to zero, headers and all. */
function liesAboutUncompressedSize(zip: Uint8Array, prefix: string): Uint8Array {
  const forged = new Uint8Array(zip);
  const view = new DataView(forged.buffer);
  const decoder = new TextDecoder();
  for (let at = 0; at + 4 <= forged.length; at += 1) {
    const signature = view.getUint32(at, true);
    // Local file header and central directory header put the name at a different offset, and the
    // uncompressed size four bytes after the compressed one in both.
    const layout =
      signature === 0x04034b50
        ? { name: 30, nameLen: 26, extraLen: 28, size: 22 }
        : signature === 0x02014b50
          ? { name: 46, nameLen: 28, extraLen: 30, size: 24 }
          : null;
    if (layout === null) continue;
    const nameLength = view.getUint16(at + layout.nameLen, true);
    const name = decoder.decode(forged.subarray(at + layout.name, at + layout.name + nameLength));
    if (name.startsWith(prefix)) view.setUint32(at + layout.size, 0, true);
  }
  return forged;
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function unzipToRecord(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

function zipFromRecord(parts: Record<string, Uint8Array>): Uint8Array {
  return zipSync(parts);
}
