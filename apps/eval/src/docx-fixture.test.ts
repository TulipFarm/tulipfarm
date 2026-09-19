import { describe, expect, it } from "vitest";
import { synthesizeAttachment } from "./case.ts";
import { DOCX_MEDIA_TYPE } from "./docx-fixture.ts";

describe("binary DOCX Case fixtures", () => {
  it("encodes the grounded fact after 400 real OOXML paragraphs in a deterministic archive", () => {
    const fixture = {
      fileId: "file-policy",
      name: "policy.docx",
      mediaType: DOCX_MEDIA_TYPE,
      content: "Claims close after 73 days & require <proof>.",
      docx: { precedingParagraphs: 400 },
    };
    const { data } = synthesizeAttachment(fixture);
    expect([...data.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(synthesizeAttachment(fixture).data).toEqual(data);
    const xml = new TextDecoder().decode(data);
    expect(xml).toContain("[Content_Types].xml");
    expect(xml).toContain("_rels/.rels");
    expect(xml).toContain("word/document.xml");
    expect(xml.match(/<w:p>/g)).toHaveLength(401);
    expect(xml.indexOf("Policy paragraph 400.")).toBeLessThan(xml.indexOf("Claims close"));
    expect(xml).toContain("73 days &amp; require &lt;proof&gt;.");
  });

  it("preserves ordinary plain-text, PDF, and content-free fixture bytes", () => {
    const base = { fileId: "file-note", name: "note.txt", mediaType: "text/plain" };
    expect(new TextDecoder().decode(synthesizeAttachment({ ...base, content: "hello" }).data)).toBe(
      "hello"
    );
    expect(new TextDecoder().decode(synthesizeAttachment(base).data)).toBe("eval-bytes:file-note");
    const pdf = synthesizeAttachment({ ...base, mediaType: "application/pdf", content: "hello" });
    expect(new TextDecoder().decode(pdf.data)).toMatch(/^%PDF-1\.4/);
    expect(new TextDecoder().decode(pdf.data)).toContain("(hello) Tj");
  });

  it.each(["malformed", "empty", "entry-limit"] as const)(
    "creates a real binary %s fixture without scripted extracted content",
    (variant) => {
      const fixture = {
        fileId: "file-policy",
        name: "policy.docx",
        mediaType: DOCX_MEDIA_TYPE,
        docx: { variant },
      };
      const { data } = synthesizeAttachment(fixture);
      expect([...data.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
      expect(synthesizeAttachment(fixture).data).toEqual(data);
      if (variant === "malformed") expect(data.length).toBe(64);
      else if (variant === "empty") {
        expect(new TextDecoder().decode(data)).toContain("<w:body><w:sectPr/></w:body>");
      } else {
        expect(Buffer.from(data).readUInt16LE(data.length - 12)).toBe(513);
      }
    }
  );
});
