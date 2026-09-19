import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  DOCX_MEDIA_TYPE,
  docxFormat,
  MAX_DOCUMENT_BYTES,
  MAX_OFFICE_ENTRIES,
  MAX_OFFICE_EXPANDED_BYTES,
  projectDocument,
  validateOfficeArchive,
} from "./document-preview";

const paragraph = (text: string) => ({ kind: "paragraph", content: [{ kind: "text", text }] });

describe("shared DOCX semantics", () => {
  it("maps only the authorized DOCX media type, not every detectable format", () => {
    expect(docxFormat(DOCX_MEDIA_TYPE)).toBe("docx");
    for (const mediaType of ["application/zip", "application/msword", "application/pdf"]) {
      expect(docxFormat(mediaType)).toBeNull();
    }
  });

  it("keeps extraction uncapped while explicitly limiting preview blocks and rows", () => {
    const grid = Array.from({ length: 201 }, (_, row) => [
      { kind: "origin", cell: { blocks: [paragraph(`row ${row}`)] } },
    ]);
    const document = {
      blocks: [
        { kind: "table", table: { grid } },
        ...Array.from({ length: 401 }, (_, row) => paragraph(`paragraph ${row}`)),
      ],
      notes: [],
    };
    const full = projectDocument(document);
    expect(full.blocks).toHaveLength(402);
    expect(full.truncated).toBe(false);
    const preview = projectDocument(document, { maxBlocks: 400, maxRows: 200 });
    expect(preview.blocks).toHaveLength(400);
    expect(preview.truncated).toBe(true);
    expect(full.blocks[0]).toMatchObject({ rows: expect.arrayContaining([["row 200"]]) });
    expect(preview.blocks[0]).not.toMatchObject({ rows: expect.arrayContaining([["row 200"]]) });
  });

  it("preserves nested lists and notes without projecting executable assets or destinations", () => {
    const output = projectDocument({
      blocks: [
        {
          kind: "paragraph",
          content: [
            {
              kind: "link",
              content: [{ kind: "text", text: "<script>literal</script>" }],
              target: { value: "https://private.invalid" },
            },
            { kind: "image", alt: "Diagram", source: { url: "https://private.invalid/pixel.svg" } },
            { kind: "noteRef", noteId: "1" },
          ],
        },
        {
          kind: "list",
          list: {
            marker: "decimal",
            start: 1,
            items: [
              {
                blocks: [
                  paragraph("Parent"),
                  {
                    kind: "list",
                    list: { marker: "bullet", start: 1, items: [{ blocks: [paragraph("Child")] }] },
                  },
                ],
              },
            ],
          },
        },
      ],
      notes: [{ id: "1", kind: "footnote", blocks: [paragraph("Supporting fact")] }],
      assets: [{ data: new Uint8Array([1, 2, 3]) }],
    });
    expect(output.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "listItem", depth: 0, ordered: true, text: "Parent" }),
        expect.objectContaining({ kind: "listItem", depth: 1, ordered: false, text: "Child" }),
        { kind: "paragraph", text: "Footnote [^1]" },
        { kind: "paragraph", text: "Supporting fact" },
      ])
    );
    expect(JSON.stringify(output)).not.toContain("private.invalid");
    expect(JSON.stringify(output)).not.toContain('"data"');
  });

  it("retains table headers and merged origins, clamping spans at the display boundary", () => {
    const document = {
      blocks: [
        {
          kind: "table",
          table: {
            headerRows: 0,
            grid: [
              [
                {
                  kind: "origin",
                  cell: { blocks: [paragraph("Merged label")], rowSpan: 2, colSpan: 2 },
                },
                { kind: "covered", originRow: 0, originCol: 0 },
              ],
              [
                { kind: "covered", originRow: 0, originCol: 0 },
                { kind: "covered", originRow: 0, originCol: 0 },
              ],
            ],
          },
        },
      ],
      notes: [],
    };
    expect(projectDocument(document)).toEqual({
      blocks: [
        {
          kind: "table",
          rows: [
            ["Merged label", ""],
            ["", ""],
          ],
          headerRows: 0,
          spans: [{ row: 0, column: 0, rowSpan: 2, colSpan: 2 }],
        },
      ],
      truncated: false,
    });
    expect(projectDocument(document, { maxRows: 1 })).toEqual({
      blocks: [
        {
          kind: "table",
          rows: [["Merged label", ""]],
          headerRows: 0,
          spans: [{ row: 0, column: 0, rowSpan: 1, colSpan: 2 }],
        },
      ],
      truncated: true,
    });
    document.blocks[0].table.headerRows = 2;
    expect(projectDocument(document, { maxRows: 1 }).blocks[0]).toMatchObject({ headerRows: 1 });
  });
});

describe("rejecting Office preflight", () => {
  it.each([MAX_OFFICE_ENTRIES - 1, MAX_OFFICE_ENTRIES])("accepts %i complete entries", (count) => {
    const bytes = zipSync(
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`${index}.xml`, new Uint8Array([index % 255])])
      )
    );
    expect(() => validateOfficeArchive(bytes)).not.toThrow();
  });

  it("refuses the whole package at the first excess entry", () => {
    const bytes = zipSync(
      Object.fromEntries(
        Array.from({ length: MAX_OFFICE_ENTRIES + 1 }, (_, index) => [
          `${index}.xml`,
          new Uint8Array(),
        ])
      )
    );
    expect(() => validateOfficeArchive(bytes)).toThrow(
      expect.objectContaining({ reason: "resource_limit" })
    );
  });

  it.each([MAX_OFFICE_EXPANDED_BYTES - 1, MAX_OFFICE_EXPANDED_BYTES])(
    "accepts %i actual expanded bytes",
    (size) => {
      expect(() => validateOfficeArchive(zipSync({ data: new Uint8Array(size) }))).not.toThrow();
    }
  );

  it("counts actual inflation even when every expanded-size header lies", () => {
    const bytes = zipSync({ data: new Uint8Array(MAX_OFFICE_EXPANDED_BYTES + 1) });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at + 46 < bytes.length; at += 1) {
      const signature = view.getUint32(at, true);
      if (signature === 0x04034b50) view.setUint32(at + 22, 1, true);
      if (signature === 0x02014b50) view.setUint32(at + 24, 1, true);
    }
    expect(() => validateOfficeArchive(bytes)).toThrow(
      expect.objectContaining({ reason: "resource_limit" })
    );
  });

  it("rejects excess input before trying to read its archive", () => {
    expect(() => validateOfficeArchive(new Uint8Array(MAX_DOCUMENT_BYTES + 1))).toThrow(
      expect.objectContaining({ reason: "resource_limit" })
    );
  });

  it("refuses damaged archives instead of reporting selected parts as a success", () => {
    expect(() => validateOfficeArchive(new Uint8Array([1, 2, 3]))).toThrow(
      expect.objectContaining({ reason: "unreadable" })
    );
  });
});
