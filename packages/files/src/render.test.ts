import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MAX_RENDER_INPUT_CHARS, MAX_RENDER_PAGES, RenderError, renderDocument } from "./render";

/**
 * Reads the text back out of a rendered PDF.
 *
 * Asserting on byte count would pass for a document that renders a blank page, which is exactly
 * the regression worth catching. pdfkit Flate-compresses each page's content stream and writes
 * glyphs as hex runs inside `TJ` arrays, so this inflates the streams and decodes the runs.
 */
function pdfStreams(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  let content = "";
  let cursor = 0;
  for (;;) {
    const start = buffer.indexOf("stream", cursor);
    if (start < 0) break;
    let begin = start + "stream".length;
    if (buffer[begin] === 0x0d) begin += 1;
    if (buffer[begin] === 0x0a) begin += 1;
    const end = buffer.indexOf("endstream", begin);
    if (end < 0) break;
    try {
      content += inflateSync(buffer.subarray(begin, end)).toString("latin1");
    } catch {
      // Not every stream in a PDF is compressed text; the font programs are not, and are skipped.
    }
    cursor = end + "endstream".length;
  }
  return content;
}

function pdfText(bytes: Uint8Array): string {
  return [...pdfStreams(bytes).matchAll(/<([0-9a-f]+)>/gi)]
    .map(([, hex]) => Buffer.from(hex, "hex").toString("utf8"))
    .join("");
}

/** Each drawn run paired with the baseline it was drawn at, in the order pdfkit emitted them. */
function pdfRuns(bytes: Uint8Array): { y: number; text: string }[] {
  const pattern = /1 0 0 1 [\d.]+ ([\d.]+) Tm[\s\S]*?\[((?:<[0-9a-f]*>|-?\d+|\s)*)\]\s*TJ/gi;
  return [...pdfStreams(bytes).matchAll(pattern)].map(([, y, run]) => ({
    y: Number(y),
    text: [...run.matchAll(/<([0-9a-f]+)>/gi)]
      .map(([, hex]) => Buffer.from(hex, "hex").toString("utf8"))
      .join(""),
  }));
}

function fontsUsed(bytes: Uint8Array): Set<string> {
  return new Set(
    [
      ...Buffer.from(bytes)
        .toString("latin1")
        .matchAll(/\/BaseFont\s*\/([A-Za-z-]+)/g),
    ].map(([, name]) => name)
  );
}

describe("renderDocument", () => {
  it("renders Markdown into a PDF that actually contains the words", async () => {
    const out = await renderDocument({
      format: "pdf",
      content: "# Quarterly\n\nRevenue rose by twelve percent.\n",
      title: "Q3 Report",
    });
    expect(out.mediaType).toBe("application/pdf");
    expect(Buffer.from(out.bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    const text = pdfText(out.bytes);
    expect(text).toContain("Q3 Report");
    expect(text).toContain("Quarterly");
    expect(text).toContain("Revenue rose by twelve percent.");
  });

  it("keeps every block kind a report is made of", async () => {
    const out = await renderDocument({
      format: "pdf",
      content: [
        "## Highlights",
        "",
        "- Churn fell",
        "- Two new markets",
        "  - Berlin",
        "",
        "1. First",
        "2. Second",
        "",
        "| Region | Revenue |",
        "| --- | --- |",
        "| EMEA | 1.2M |",
        "",
        "> A quoted line.",
        "",
        "```",
        "const answer = 42;",
        "```",
      ].join("\n"),
    });
    const text = pdfText(out.bytes);
    for (const fragment of [
      "Highlights",
      "Churn fell",
      "Berlin",
      "First",
      "Region",
      "EMEA",
      "A quoted line.",
      "const answer = 42;",
    ]) {
      expect(text).toContain(fragment);
    }
  });

  it("renders emphasis and code as different faces rather than dropping the markup", async () => {
    const out = await renderDocument({
      format: "pdf",
      content: "Revenue was **up** thanks to `renewals` and *timing*.",
    });
    expect(pdfText(out.bytes)).toContain("up");
    // If inline tokens were flattened to plain text these three faces would collapse to one.
    expect(fontsUsed(out.bytes)).toEqual(
      new Set(["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Courier"])
    );
  });

  it("closes the last inline run so the next block does not land on top of it", async () => {
    // A run left open (`continued: true` on the final segment) makes pdfkit hold the line, and the
    // following heading overprints it. The symptom is only visible in the y-coordinates.
    const out = await renderDocument({
      format: "pdf",
      content: "A paragraph ending in **bold**.\n\n## After\n",
    });
    const runs = pdfRuns(out.bytes);
    const paragraph = runs.find((run) => run.text.startsWith("A paragraph"));
    const heading = runs.find((run) => run.text.includes("After"));
    expect(paragraph).toBeDefined();
    expect(heading).toBeDefined();
    // pdfkit's y grows upward here, so a following block must sit strictly lower. An unclosed run
    // leaves the cursor on the paragraph's line and the heading lands at the same baseline.
    expect(heading?.y ?? 0).toBeLessThan(paragraph?.y ?? 0);
  });

  it("stores the other formats verbatim, with the media type they claim", async () => {
    for (const [format, mediaType] of [
      ["markdown", "text/markdown"],
      ["text", "text/plain"],
      ["csv", "text/csv"],
    ] as const) {
      const out = await renderDocument({ format, content: "a,b\n1,2\n" });
      expect(out.mediaType).toBe(mediaType);
      expect(new TextDecoder().decode(out.bytes)).toBe("a,b\n1,2\n");
    }
  });

  it("refuses input past the cap before rendering anything", async () => {
    await expect(
      renderDocument({ format: "pdf", content: "x".repeat(MAX_RENDER_INPUT_CHARS + 1) })
    ).rejects.toMatchObject({ reason: "input_too_large" });
  });

  it("refuses content that carries nothing", async () => {
    await expect(renderDocument({ format: "pdf", content: "   \n" })).rejects.toMatchObject({
      reason: "empty",
    });
  });

  it("bounds pagination rather than letting finite input produce unbounded output", async () => {
    // Well inside the input cap, and far past the page cap: this is the gap the page bound covers.
    const content = Array.from({ length: 15_000 }, (_, index) => `Line ${index}\n`).join("\n");
    expect(content.length).toBeLessThan(MAX_RENDER_INPUT_CHARS);
    await expect(renderDocument({ format: "pdf", content })).rejects.toMatchObject({
      reason: "too_many_pages",
    });
  });

  it("reports a refusal as a RenderError the caller can turn into advice", async () => {
    const error = await renderDocument({ format: "pdf", content: "" }).catch((e) => e);
    expect(error).toBeInstanceOf(RenderError);
    expect(MAX_RENDER_PAGES).toBeGreaterThan(0);
  });
});
