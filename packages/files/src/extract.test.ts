import { describe, expect, it } from "vitest";
import {
  extractText,
  IMAGES_ARE_NOT_INDEXED,
  isExtractableMediaType,
  MAX_EXTRACTED_CHARS,
} from "./extract";
import { renderDocument } from "./render";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

async function pdfOf(content: string, title?: string): Promise<Uint8Array> {
  const rendered = await renderDocument({ format: "pdf", content, title });
  return rendered.bytes;
}

describe("extractText", () => {
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
  });

  it("collapses the incidental whitespace a text layer arrives with", async () => {
    const bytes = await pdfOf("One two three four five six seven eight nine ten.");

    const result = await extractText("application/pdf", bytes);

    const text = (result as { text: string }).text;
    expect(text).not.toMatch(/ {2}/);
    expect(text).not.toMatch(/\n{3}/);
    expect(text.trim()).toBe(text);
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
    expect(IMAGES_ARE_NOT_INDEXED).toBe(true);
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
    expect(isExtractableMediaType("image/png")).toBe(false);
    expect(isExtractableMediaType("application/zip")).toBe(false);
  });
});
