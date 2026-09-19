import { type Format, toDocument } from "@firecrawl/anydoc";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  documentBlocksText,
  documentFormat,
  MAX_OFFICE_ENTRIES,
  PPTX_MEDIA_TYPE,
  projectDocument,
  XLSX_MEDIA_TYPE,
} from "./document-preview";
import { extractText } from "./extract";
import { renderPptx, renderXlsx } from "./office";
import { externalPptx, externalXlsx, manySheetXlsx } from "./office-fixture.test-support";

describe("shared local Office extraction", () => {
  it("does not apply the preview block budget to a workbook with many visible sheets", async () => {
    const bytes = manySheetXlsx();
    const document = await toDocument(bytes, "xlsx" as Format);
    const preview = projectDocument(document, { format: "xlsx", maxBlocks: 400, maxRows: 200 });
    expect(preview.truncated).toBe(true);
    expect(documentBlocksText(preview.blocks)).not.toContain("947 tulips");
    expect(await extractText(XLSX_MEDIA_TYPE, bytes)).toMatchObject({
      kind: "text",
      text: expect.stringContaining("Final sheet contains 947 tulips."),
      truncated: false,
    });
  });
  it("extracts visible stored values beyond row 200 without cropping extraction or consuming bytes", async () => {
    const bytes = externalXlsx();
    const original = bytes.slice();
    const result = await extractText(XLSX_MEDIA_TYPE, bytes);
    expect(bytes).toEqual(original);
    expect(result.kind).toBe("text");
    if (result.kind !== "text") return;
    for (const text of ["731 tulips", "2024-01-01", "12.50%", "$1,234.50", "Cached formula\t42"]) {
      expect(result.text).toContain(text);
    }
    expect(result.text).not.toMatch(/Hidden (row|column|sheet) secret|6\*7/);
    expect(result.text.indexOf("Visible inventory")).toBeLessThan(
      result.text.indexOf("Visible summary")
    );
    expect(result.text).toContain("\tSparse associated value");
    expect(result.truncated).toBe(false);
    const document = await toDocument(bytes, "xlsx" as Format);
    const preview = projectDocument(document, { format: "xlsx", maxRows: 200, maxBlocks: 400 });
    expect(preview.truncated).toBe(true);
    expect(documentBlocksText(preview.blocks)).not.toContain("731 tulips");
    const table = preview.blocks.find((block) => block.kind === "table");
    expect(table?.kind === "table" && table.rows[5]).toEqual(["Merged label", ""]);
    expect(table?.kind === "table" && table.spans).toContainEqual({
      row: 5,
      column: 0,
      colSpan: 2,
      rowSpan: 1,
    });
  });

  it("labels speaker notes, preserves semantic source order and tables, without invented slides", async () => {
    const bytes = externalPptx();
    const original = bytes.slice();
    const result = await extractText(PPTX_MEDIA_TYPE, bytes);
    expect(bytes).toEqual(original);
    expect(result.kind).toBe("text");
    if (result.kind !== "text") return;
    const ordered = [
      "Approval briefing",
      "Visible review instructions",
      "Check the budget",
      "Pune\t4200",
      "Speaker notes",
      "47 days",
      "Follow-up actions",
    ];
    expect(ordered.map((text) => result.text.indexOf(text))).toEqual(
      ordered.map((text) => result.text.indexOf(text)).sort((a, b) => a - b)
    );
    for (const text of ordered) expect(result.text).toContain(text);
    expect(result.text).not.toMatch(/Slide \d|slide number|position/i);
  });

  it.each([
    [XLSX_MEDIA_TYPE, () => renderXlsx("Item,Count\nTulips,731", "Inventory"), "Tulips\t731"],
    [
      PPTX_MEDIA_TYPE,
      () => renderPptx("# Briefing\n\n- Review the budget", "Briefing"),
      "Review the budget",
    ],
  ] as const)(
    "reads generated Files through the same extraction path (%s)",
    async (mediaType, make, fact) => {
      expect(await extractText(mediaType, make())).toMatchObject({
        kind: "text",
        text: expect.stringContaining(fact),
      });
    }
  );

  it.each([XLSX_MEDIA_TYPE, PPTX_MEDIA_TYPE])(
    "uses explicit refusals and post-conversion caps (%s)",
    async (mediaType) => {
      const make = mediaType === XLSX_MEDIA_TYPE ? externalXlsx : externalPptx;
      const bytes = make();
      const full = await extractText(mediaType, bytes);
      const capped = await extractText(mediaType, bytes, { maxChars: 80 });
      expect(full.kind).toBe("text");
      expect(capped).toMatchObject({ kind: "text", truncated: true });
      if (full.kind === "text" && capped.kind === "text")
        expect(capped.text).toBe(full.text.slice(0, 80));
      expect(await extractText(mediaType, bytes.slice(0, 50))).toMatchObject({
        kind: "refused",
        reason: "unreadable",
      });
      const entries = Object.fromEntries(
        Array.from({ length: MAX_OFFICE_ENTRIES + 1 }, (_, index) => [
          `part${index}`,
          new Uint8Array(),
        ])
      );
      expect(await extractText(mediaType, zipSync(entries))).toMatchObject({
        kind: "refused",
        reason: "resource_limit",
      });
      expect(documentFormat(mediaType)).not.toBeNull();
    }
  );
});
