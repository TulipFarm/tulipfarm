import { describe, expect, it } from "vitest";
import { DOCX_MEDIA_TYPE } from "./document-preview";
import { docxParagraph, externalDocx, semanticDocx } from "./docx-fixture.test-support";
import { extractText, MAX_EXTRACTED_CHARS } from "./extract";
import { isExtractableMediaType } from "./limits";
import { renderDocument } from "./render";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

async function pdfOf(content: string, title?: string): Promise<Uint8Array> {
  const rendered = await renderDocument({ format: "pdf", content, title });
  return rendered.bytes;
}

describe("extractText", () => {
  it("reads externally produced DOCX structure and footnotes without consuming source bytes", async () => {
    const bytes = semanticDocx();
    const before = new Uint8Array(bytes);
    const result = await extractText(DOCX_MEDIA_TYPE, bytes);
    expect(bytes).toEqual(before);
    expect(result.kind).toBe("text");
    if (result.kind !== "text") throw new Error("Expected DOCX text");
    expect(result.truncated).toBe(false);
    const ordered = [
      "Approval handbook",
      '5 < 6 & "quoted"',
      "Review the proposal",
      "Confirm the budget",
      "Pune",
      "Approval policy",
      "Footnote",
      "approval expires after 47 days",
    ];
    let position = -1;
    for (const fact of ordered) {
      const next = result.text.indexOf(fact);
      expect(next, fact).toBeGreaterThan(position);
      position = next;
    }
    expect(result.text).toMatch(/\n {2}[-•] Confirm the budget/);
  });

  it("includes a grounded fact past the old 400-block and 200-row preview ceilings", async () => {
    const paragraphs = Array.from({ length: 401 }, (_, index) =>
      docxParagraph(`Paragraph ${index}`)
    ).join("");
    const rows = Array.from(
      { length: 201 },
      (_, index) =>
        `<w:tr><w:tc>${docxParagraph(index === 200 ? "Late table fact: code 7391." : `Row ${index}`)}</w:tc></w:tr>`
    ).join("");
    const result = await extractText(
      DOCX_MEDIA_TYPE,
      externalDocx(
        `${paragraphs}${docxParagraph("Late paragraph fact: renewal is 83 days.")}<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid>${rows}</w:tbl>`
      )
    );
    expect(result).toMatchObject({ kind: "text", truncated: false });
    if (result.kind !== "text") throw new Error("Expected DOCX text");
    expect(result.text).toContain("renewal is 83 days");
    expect(result.text).toContain("code 7391");
  });

  it("applies only the requested character cap, including its exact boundary", async () => {
    const bytes = externalDocx(docxParagraph("abcde"));
    expect(await extractText(DOCX_MEDIA_TYPE, bytes, { maxChars: 5 })).toEqual({
      kind: "text",
      text: "abcde",
      truncated: false,
    });
    expect(await extractText(DOCX_MEDIA_TYPE, bytes, { maxChars: 4 })).toEqual({
      kind: "text",
      text: "abcd",
      truncated: true,
    });
    const long = await extractText(
      DOCX_MEDIA_TYPE,
      externalDocx(docxParagraph("x".repeat(MAX_EXTRACTED_CHARS + 1)))
    );
    expect(long).toMatchObject({ kind: "text", truncated: true });
    if (long.kind === "text") expect(long.text).toHaveLength(MAX_EXTRACTED_CHARS);
  });

  it("returns ordinary DOCX refusals without a legacy conversion fallback", async () => {
    expect(await extractText(DOCX_MEDIA_TYPE, utf8("not a ZIP"))).toEqual({
      kind: "refused",
      reason: "unreadable",
    });
  });

  it("returns a textual File verbatim", async () => {
    const result = await extractText("text/plain", utf8("the quick brown fox"));

    expect(result).toEqual({ kind: "text", text: "the quick brown fox", truncated: false });
  });

  it("reads Markdown and CSV, which are text an Agent should search", async () => {
    const markdown = await extractText("text/markdown", utf8("# Title\n\nbody"));
    const csv = await extractText("text/csv", utf8("a,b\n1,2"));

    expect(markdown).toMatchObject({ kind: "text", text: "# Title\n\nbody" });
    expect(csv).toMatchObject({ kind: "text", text: "a,b\n1,2" });
  });

  it("caps a long document and says that it did", async () => {
    const result = await extractText("text/plain", utf8("x".repeat(50)), { maxChars: 10 });

    expect(result).toEqual({ kind: "text", text: "x".repeat(10), truncated: true });
  });

  it("does not flag truncation for a document that fits exactly", async () => {
    const result = await extractText("text/plain", utf8("xxxxx"), { maxChars: 5 });

    expect(result).toEqual({ kind: "text", text: "xxxxx", truncated: false });
  });

  it("defaults the cap rather than returning an unbounded document", async () => {
    const result = await extractText("text/plain", utf8("x".repeat(MAX_EXTRACTED_CHARS + 100)));

    expect(result).toMatchObject({ truncated: true });
    expect((result as { text: string }).text).toHaveLength(MAX_EXTRACTED_CHARS);
  });

  it("reads back a PDF this package rendered", async () => {
    const bytes = await pdfOf("Retrieval augmented generation is the subject.", "Report");

    const result = await extractText("application/pdf", bytes);

    expect(result.kind).toBe("text");
    expect((result as { text: string }).text).toContain("Retrieval augmented generation");
    expect((result as { text: string }).text).toContain("Report");
    expect(result).toMatchObject({
      visual: {
        kind: "pdf",
        pages: [expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) })],
      },
    });
  });

  it("leaves the caller's bytes intact, so a screened PDF can still be sent to a model", async () => {
    // pdf.js takes ownership of the array it is handed and detaches its buffer. Screening a PDF
    // for the guards therefore used to empty the very bytes the Turn then attached, and the model
    // rejected the request as "empty base64-encoded bytes".
    const bytes = await pdfOf("Retrieval augmented generation is the subject.", "Report");
    const before = bytes.byteLength;

    await extractText("application/pdf", bytes);

    expect(bytes.byteLength).toBe(before);
  });

  it("reads the Office formats it accepts as uploads, so an Agent can be asked about one", async () => {
    // These three are on the upload allowlist, and no model takes them as a binary file part, so
    // text is the only way their contents can reach one at all.
    const xlsx = await renderDocument({
      format: "xlsx",
      content: "| Region | Revenue |\n| --- | --- |\n| Pune | 4200 |",
      title: "Q3",
    });
    const docx = await renderDocument({ format: "docx", content: "# Plan\n\nShip the thing." });

    const sheet = await extractText(xlsx.mediaType, xlsx.bytes);
    const document = await extractText(docx.mediaType, docx.bytes);

    expect(sheet).toMatchObject({ kind: "text" });
    expect((sheet as { text: string }).text).toContain("Pune");
    expect((sheet as { text: string }).text).toContain("4200");
    expect(document).toMatchObject({ kind: "text" });
    expect((document as { text: string }).text).toContain("Ship the thing");
  });

  it("refuses an Office package that will not open, rather than throwing", async () => {
    const result = await extractText(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      utf8("definitely not a zip")
    );

    expect(result).toEqual({ kind: "refused", reason: "unreadable" });
  });

  it("reads the words of a rendered PDF without a legacy text extractor", async () => {
    const bytes = await pdfOf("One two three four five six seven eight nine ten.");

    const result = await extractText("application/pdf", bytes);

    const text = (result as { text: string }).text;
    expect(text).toContain("One two three");
  });

  it("caps a PDF as well, so one upload cannot dominate the index", async () => {
    const bytes = await pdfOf("alpha beta gamma delta epsilon");

    const result = await extractText("application/pdf", bytes, { maxChars: 5 });

    expect(result).toMatchObject({ kind: "text", truncated: true });
    expect((result as { text: string }).text).toHaveLength(5);
  });

  it("refuses bytes that are not really a PDF instead of throwing", async () => {
    const result = await extractText("application/pdf", utf8("not a pdf at all"));

    expect(result).toEqual({ kind: "refused", reason: "unreadable" });
  });

  it("refuses an empty PDF body as unreadable rather than as an empty document", async () => {
    const result = await extractText("application/pdf", new Uint8Array(0));

    expect(result).toEqual({ kind: "refused", reason: "unreadable" });
  });

  it("refuses every image, because OCR would assert what it could not know", async () => {
    for (const mediaType of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(await extractText(mediaType, utf8("binary"))).toEqual({
        kind: "refused",
        reason: "image_not_extractable",
      });
    }
  });

  it("refuses a type it was never meant to read", async () => {
    const result = await extractText("application/zip", utf8("PK"));

    expect(result).toEqual({ kind: "refused", reason: "unsupported_media_type" });
  });
});

describe("isExtractableMediaType", () => {
  it("answers for a type without reading any bytes", () => {
    expect(isExtractableMediaType("text/plain")).toBe(true);
    expect(isExtractableMediaType("text/markdown")).toBe(true);
    expect(isExtractableMediaType("text/csv")).toBe(true);
    expect(isExtractableMediaType("application/pdf")).toBe(true);
    expect(
      isExtractableMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    ).toBe(true);
    expect(isExtractableMediaType("image/png")).toBe(false);
    expect(isExtractableMediaType("application/zip")).toBe(false);
  });
});
