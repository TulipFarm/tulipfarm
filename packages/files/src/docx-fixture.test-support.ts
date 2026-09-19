import { zipSync } from "fflate";

const encode = (text: string) => new TextEncoder().encode(text);
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export function docxParagraph(text: string): string {
  return `<w:p><w:r><w:t>${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</w:t></w:r></w:p>`;
}

/** Synthetic producer fixture, intentionally independent of TulipFarm's Office writer. */
export function externalDocx(
  body: string,
  extra: Record<string, Uint8Array> = {},
  level: 0 | 6 = 6
): Uint8Array {
  return zipSync(
    {
      "[Content_Types].xml": encode(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>`
      ),
      "_rels/.rels": encode(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`
      ),
      "word/document.xml": encode(
        `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}<w:sectPr/></w:body></w:document>`
      ),
      "word/_rels/document.xml.rels": encode(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="${R}/styles" Target="styles.xml"/><Relationship Id="numbering" Type="${R}/numbering" Target="numbering.xml"/><Relationship Id="footnotes" Type="${R}/footnotes" Target="footnotes.xml"/></Relationships>`
      ),
      "word/styles.xml": encode(
        `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>`
      ),
      "word/numbering.xml": encode(
        `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`
      ),
      "word/footnotes.xml": encode(`<w:footnotes xmlns:w="${W}"/>`),
      ...extra,
    },
    { level }
  );
}

export function semanticDocx(): Uint8Array {
  const list = (depth: number, text: string) =>
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="${depth}"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const rows = [
    ["Region", "Budget"],
    ["Pune", "4200"],
  ]
    .map(
      (row) => `<w:tr>${row.map((cell) => `<w:tc>${docxParagraph(cell)}</w:tc>`).join("")}</w:tr>`
    )
    .join("");
  return externalDocx(
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Approval handbook</w:t></w:r></w:p>` +
      docxParagraph('5 < 6 & "quoted"') +
      list(0, "Review the proposal") +
      list(1, "Confirm the budget") +
      `<w:tbl><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>${rows}</w:tbl>` +
      `<w:p><w:r><w:t>Approval policy</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>`,
    {
      "word/footnotes.xml": encode(
        `<w:footnotes xmlns:w="${W}"><w:footnote w:id="1">${docxParagraph("Footnote fact: approval expires after 47 days.")}</w:footnote></w:footnotes>`
      ),
    }
  );
}
