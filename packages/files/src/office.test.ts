import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  markdownBlocks,
  markdownSlides,
  parseCsv,
  renderDocx,
  renderPptx,
  renderXlsx,
} from "./office";
import { columnName, isNumericCell, xml } from "./ooxml";
import { extensionForFormat, RENDER_FORMATS, renderDocument } from "./render";

/** Reads the stored file names out of a zip's central directory without unzipping the entries. */
function zipEntryNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at + 4 <= bytes.byteLength; at += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(at + 28, true);
    names.push(new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)));
  }
  return names;
}

/** Inflates the whole package and returns one part as text. Entries are deflated, not stored. */
function partText(bytes: Uint8Array, path: string): string {
  const entry = unzipSync(bytes)[path];
  if (entry === undefined) throw new Error(`no part at ${path}`);
  return new TextDecoder().decode(entry);
}

/**
 * The OPC rules Word, Excel and PowerPoint enforce before they will open a package.
 *
 * Returns a list of complaints rather than asserting, so a failure names every broken edge at once.
 * These three are what produce the "unreadable content, do you want us to recover it" prompt: an
 * `r:id` with no matching relationship, a relationship pointing at a part that was never written,
 * or a part the reader cannot type. None of them is visible to a parser that reads only the parts
 * it already expects, which is why round-tripping through a library is not enough on its own.
 */
function opcComplaints(bytes: Uint8Array): string[] {
  const parts = unzipSync(bytes);
  const names = new Set(Object.keys(parts));
  const complaints: string[] = [];
  const decode = (name: string): string => new TextDecoder().decode(parts[name] as Uint8Array);

  const types = decode("[Content_Types].xml");
  const defaults = new Set(
    [...types.matchAll(/<Default Extension="([^"]+)"/g)].map((m) => m[1]?.toLowerCase())
  );
  const overrides = new Set(
    [...types.matchAll(/<Override PartName="\/([^"]+)"/g)].map((m) => m[1])
  );

  for (const name of names) {
    if (name === "[Content_Types].xml") continue;
    const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    // A `Default` for "xml" types every part as generic application/xml, which satisfies the
    // package but not the reader: Word finds its document, styles and numbering by content type,
    // and opens the "recover it?" prompt when one falls back to the Default. So every XML part
    // that is not a relationship part must carry its own Override.
    if (extension === "xml" && !name.endsWith(".rels")) {
      if (!overrides.has(name)) complaints.push(`${name} has no content-type Override`);
      continue;
    }
    if (overrides.has(name) || defaults.has(extension)) continue;
    complaints.push(`${name} has no content type`);
  }

  for (const name of names) {
    if (!name.endsWith(".rels")) continue;
    const directory = name.slice(0, name.lastIndexOf("_rels/"));
    const targets = [
      ...decode(name).matchAll(/Target="([^"]+)"[^>]*?(TargetMode="External")?\/>/g),
    ];
    for (const [, target, external] of targets) {
      if (external !== undefined || target === undefined || /^[a-z]+:/.test(target)) continue;
      const resolved = target.startsWith("/")
        ? target.slice(1)
        : `${directory}${target}`.replace(/[^/]+\/\.\.\//g, "");
      if (!names.has(resolved)) complaints.push(`${name} points at missing part ${resolved}`);
    }
  }

  for (const name of names) {
    if (!name.endsWith(".xml") || name.endsWith(".rels")) continue;
    const used = new Set([...decode(name).matchAll(/r:(?:id|embed)="([^"]+)"/g)].map((m) => m[1]));
    if (used.size === 0) continue;
    const relsName = `${name.slice(0, name.lastIndexOf("/") + 1)}_rels/${name.slice(name.lastIndexOf("/") + 1)}.rels`;
    const declared = names.has(relsName)
      ? new Set([...decode(relsName).matchAll(/Id="([^"]+)"/g)].map((m) => m[1]))
      : new Set<string>();
    for (const id of used) {
      if (!declared.has(id as string)) complaints.push(`${name} uses undeclared ${id}`);
    }
  }

  return complaints;
}

describe("xml", () => {
  it("escapes every character that could close or open markup", () => {
    expect(xml(`<a href="x" & 'y'>`)).toBe("&lt;a href=&quot;x&quot; &amp; &apos;y&apos;&gt;");
  });

  it("drops control characters XML 1.0 cannot represent, keeping tab and newline", () => {
    expect(xml("a\u0000b\u001fc\td\ne")).toBe("abc\td\ne");
  });

  it("leaves astral characters intact rather than splitting a surrogate pair", () => {
    expect(xml("emoji \u{1f600} end")).toBe("emoji \u{1f600} end");
  });
});

describe("columnName", () => {
  it("counts in bijective base-26 the way a spreadsheet does", () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual([
      "A",
      "Z",
      "AA",
      "AB",
      "AZ",
      "BA",
      "ZZ",
      "AAA",
    ]);
  });
});

describe("isNumericCell", () => {
  it("treats a value as a number only when the round trip is lossless", () => {
    expect(isNumericCell("42")).toBe(true);
    expect(isNumericCell("-3.5")).toBe(true);
    // An identifier with a leading zero is not a quantity; storing it numerically loses the zero.
    expect(isNumericCell("007")).toBe(false);
    expect(isNumericCell("1,200")).toBe(false);
    expect(isNumericCell("")).toBe(false);
    expect(isNumericCell(" 5 ")).toBe(false);
  });
});

describe("parseCsv", () => {
  it("keeps a comma and a newline that sit inside a quoted field", () => {
    expect(parseCsv('a,"b,c","d\ne"\n')).toEqual([["a", "b,c", "d\ne"]]);
  });

  it("reads a doubled quote as one literal quote", () => {
    expect(parseCsv('x,"he said ""ok"""')).toEqual([["x", 'he said "ok"']]);
  });

  it("accepts CRLF and does not invent a row after the trailing newline", () => {
    expect(parseCsv("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("strips a byte order mark so it cannot become part of the first header", () => {
    expect(parseCsv("\ufeffid,name\n1,x")[0]?.[0]).toBe("id");
  });

  it("preserves empty trailing fields, which carry meaning in a column", () => {
    expect(parseCsv("a,,c\n")).toEqual([["a", "", "c"]]);
  });
});

describe("markdownBlocks", () => {
  it("carries emphasis onto the spans rather than flattening to text", () => {
    const [block] = markdownBlocks("plain **bold** and *italic* and `code`");
    expect(block).toMatchObject({ kind: "paragraph" });
    expect(block?.kind === "paragraph" && block.spans).toEqual([
      { text: "plain " },
      { bold: true, text: "bold" },
      { text: " and " },
      { italic: true, text: "italic" },
      { text: " and " },
      { code: true, text: "code" },
    ]);
  });

  it("records nesting depth so an indented list stays indented", () => {
    const blocks = markdownBlocks("- one\n  - two\n- three");
    expect(blocks.map((block) => (block.kind === "listItem" ? block.depth : -1))).toEqual([
      0, 1, 0,
    ]);
  });

  it("keeps a link's label and drops the target, which no relationship points at", () => {
    const [block] = markdownBlocks("see [the docs](https://example.com/x)");
    expect(block?.kind === "paragraph" && block.spans.map((span) => span.text).join("")).toBe(
      "see the docs"
    );
  });
});

describe("markdownSlides", () => {
  it("starts a slide at each top-level heading", () => {
    const slides = markdownSlides("# One\n\ntext a\n\n## Two\n\n- b\n\n### Three\n\ntext c");
    expect(slides.map((slide) => slide.title)).toEqual(["One", "Two"]);
    expect(slides[1]?.bullets.map((bullet) => bullet.text)).toEqual(["b", "Three", "text c"]);
  });

  it("continues an overlong slide instead of running off the bottom edge", () => {
    const slides = markdownSlides(
      `# Long\n\n${Array.from({ length: 30 }, (_, i) => `- item ${i}`).join("\n")}`
    );
    expect(slides.length).toBe(3);
    expect(slides[1]?.title).toBe("Long (cont.)");
    expect(slides.every((slide) => slide.bullets.length <= 12)).toBe(true);
  });

  it("falls back to the title when the content opens with no heading", () => {
    expect(markdownSlides("just a line", "My Deck")[0]?.title).toBe("My Deck");
  });
});

describe("office packages", () => {
  it("emits the parts a Word reader requires", () => {
    const names = zipEntryNames(renderDocx("# Title\n\nBody", "T"));
    expect(names).toEqual(
      expect.arrayContaining([
        "[Content_Types].xml",
        "_rels/.rels",
        "word/document.xml",
        "word/_rels/document.xml.rels",
        "word/styles.xml",
        "word/numbering.xml",
      ])
    );
  });

  it("emits the parts an Excel reader requires", () => {
    const names = zipEntryNames(renderXlsx("a,b\n1,2\n"));
    expect(names).toEqual(
      expect.arrayContaining([
        "[Content_Types].xml",
        "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels",
        "xl/worksheets/sheet1.xml",
        "xl/styles.xml",
      ])
    );
  });

  it("emits one slide part per slide plus the master and layout", () => {
    const names = zipEntryNames(renderPptx("# A\n\n- x\n\n# B\n\n- y"));
    expect(names).toEqual(
      expect.arrayContaining([
        "ppt/presentation.xml",
        "ppt/slideMasters/slideMaster1.xml",
        "ppt/slideLayouts/slideLayout1.xml",
        "ppt/slides/slide1.xml",
        "ppt/slides/slide2.xml",
      ])
    );
    expect(names.filter((name) => name.startsWith("ppt/slides/slide")).length).toBe(2);
  });

  it("never writes an external relationship, so nothing resolves outside the package", () => {
    const bytes = renderDocx("[x](https://evil.example/x)\n\n![y](https://evil.example/y.png)");
    for (const [path, entry] of Object.entries(unzipSync(bytes))) {
      const text = new TextDecoder().decode(entry);
      expect(text.includes("evil.example"), path).toBe(false);
      expect(text.includes('TargetMode="External"'), path).toBe(false);
    }
  });

  it("does not print the title twice when the content already opens with one", () => {
    const body = partText(renderDocx("# Report\n\nbody", "Report"), "word/document.xml");
    expect(body.split(">Report</w:t>").length - 1).toBe(1);
    // Content with no heading of its own still gets the title, so the file is never untitled.
    const untitled = partText(renderDocx("body", "Report"), "word/document.xml");
    expect(untitled.includes(">Report</w:t>")).toBe(true);
  });

  it("gives every list level a bullet glyph and a style a reader can resolve", () => {
    const numbering = partText(renderDocx("- one\n", "T"), "word/numbering.xml");
    const levels = [...numbering.matchAll(/<w:lvlText w:val="([^"]*)"\/>/g)].map((m) => m[1]);
    expect(levels.length).toBeGreaterThan(0);
    // An empty `lvlText` is valid XML and renders a list with no bullet at all, so the glyph
    // being present matters more than which glyph it is.
    for (const [index, glyph] of levels.entries()) {
      expect(glyph, `level ${index} has no glyph`).not.toBe("");
    }
    // Word reads the paragraph's own `numPr`; leaner importers only follow this back-reference.
    expect(numbering).toContain('<w:pStyle w:val="ListBullet"/>');
    expect(numbering).toContain('<w:pStyle w:val="ListNumber"/>');
    const styles = partText(renderDocx("- one\n", "T"), "word/styles.xml");
    expect(styles).toContain('w:styleId="ListBullet"');
    expect(styles).toContain('w:styleId="ListNumber"');
  });

  it("satisfies the OPC rules an Office reader checks before opening", () => {
    const packages = {
      docx: renderDocx("# R\n\n- a\n\n1. b\n\n| h |\n| --- |\n| c |\n\n`x`\n\n> q\n", "R"),
      xlsx: renderXlsx("a,b\n1,2\n", "Sheet"),
      pptx: renderPptx("# One\n\n- a\n\n# Two\n\n- b\n", "Deck"),
    };
    for (const [format, bytes] of Object.entries(packages)) {
      expect(opcComplaints(bytes), format).toEqual([]);
    }
  });
});

describe("renderDocument", () => {
  it("offers the three Office formats alongside the text ones", () => {
    expect(RENDER_FORMATS).toContain("docx");
    expect(RENDER_FORMATS).toContain("xlsx");
    expect(RENDER_FORMATS).toContain("pptx");
  });

  it("names each Office format with its own suffix", () => {
    expect(extensionForFormat("docx")).toBe(".docx");
    expect(extensionForFormat("xlsx")).toBe(".xlsx");
    expect(extensionForFormat("pptx")).toBe(".pptx");
  });

  it("returns the macro-free OOXML media type for each", async () => {
    const docx = await renderDocument({ format: "docx", content: "# a", title: "a" });
    const xlsx = await renderDocument({ format: "xlsx", content: "a,b\n1,2", title: "a" });
    const pptx = await renderDocument({ format: "pptx", content: "# a\n\n- b", title: "a" });
    expect(docx.mediaType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    expect(xlsx.mediaType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    expect(pptx.mediaType).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
    // A zip local file header; a reader that sees anything else rejects the file outright.
    for (const out of [docx, xlsx, pptx]) {
      expect(Array.from(out.bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    }
  });

  it("rejects an Office render with nothing in it, the same as every other format", async () => {
    await expect(renderDocument({ format: "docx", content: "   " })).rejects.toThrow();
  });
});
