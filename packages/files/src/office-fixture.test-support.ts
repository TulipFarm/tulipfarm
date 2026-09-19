import { unzipSync, zipSync } from "fflate";

const S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const rels = (body: string) =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
const relationship = (id: string, type: string, target: string) =>
  `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`;

function archive(parts: Record<string, string | Uint8Array>, level: 0 | 6): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(parts).map(([name, value]) => [
        name,
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      ])
    ),
    { level }
  );
}

function contentTypes(overrides: readonly [string, string][]): string {
  return `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.map(([name, type]) => `<Override PartName="/${name}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`).join("")}</Types>`;
}

const cell = (reference: string, text: string) =>
  `<c r="${reference}" t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`;

/** Independent synthetic OOXML producer, not a round-trip through the product writer. */
export function externalXlsx(
  fact = "Reserve lot contains 731 tulips.",
  precedingRows = 220,
  extra: Record<string, Uint8Array> = {},
  level: 0 | 6 = 6
): Uint8Array {
  const rows = [
    `<row r="1">${cell("A1", "Inventory")}${cell("B1", "Stored value")}${cell("C1", "Hidden column secret")}</row>`,
    `<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" s="1"><v>45292</v></c></row>`,
    `<row r="3">${cell("A3", "Percentage")}<c r="B3" s="2"><v>0.125</v></c></row>`,
    `<row r="4">${cell("A4", "Currency")}<c r="B4" s="3"><v>1234.5</v></c></row>`,
    `<row r="5">${cell("A5", "Cached formula")}<c r="B5"><f>6*7</f><v>42</v></c></row>`,
    `<row r="6">${cell("A6", "Merged label")}</row>`,
    `<row r="7">${cell("B7", "Sparse associated value")}</row>`,
    `<row r="8" hidden="1">${cell("A8", "Hidden row secret")}</row>`,
    ...Array.from({ length: precedingRows }, (_, index) => {
      const row = index + 9;
      return `<row r="${row}">${cell(`A${row}`, `Inventory item ${index + 1}`)}${cell(`B${row}`, "1")}</row>`;
    }),
    `<row r="${precedingRows + 9}">${cell(`A${precedingRows + 9}`, fact)}</row>`,
  ].join("");
  const sheet = (body: string) =>
    `<worksheet xmlns="${S}"><sheetData>${body}</sheetData></worksheet>`;
  return archive(
    {
      "[Content_Types].xml": contentTypes([
        ["xl/workbook.xml", "spreadsheetml.sheet.main"],
        ["xl/styles.xml", "spreadsheetml.styles"],
        ["xl/sharedStrings.xml", "spreadsheetml.sharedStrings"],
        ...[1, 2, 3].map((index): [string, string] => [
          `xl/worksheets/sheet${index}.xml`,
          "spreadsheetml.worksheet",
        ]),
      ]),
      "_rels/.rels": rels(relationship("office", "officeDocument", "xl/workbook.xml")),
      "xl/workbook.xml": `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="Visible inventory" sheetId="2" r:id="second"/><sheet name="Private budget" sheetId="1" state="hidden" r:id="first"/><sheet name="Visible summary" sheetId="3" r:id="third"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": rels(
        relationship("first", "worksheet", "worksheets/sheet1.xml") +
          relationship("second", "worksheet", "worksheets/sheet2.xml") +
          relationship("third", "worksheet", "worksheets/sheet3.xml") +
          relationship("styles", "styles", "styles.xml") +
          relationship("strings", "sharedStrings", "sharedStrings.xml")
      ),
      "xl/sharedStrings.xml": `<sst xmlns="${S}" count="1" uniqueCount="1"><si><t>Stored date</t></si></sst>`,
      "xl/styles.xml": `<styleSheet xmlns="${S}"><numFmts count="1"><numFmt numFmtId="164" formatCode="$#,##0.00"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="10" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`,
      "xl/worksheets/sheet1.xml": sheet(`<row r="1">${cell("A1", "Hidden sheet secret")}</row>`),
      "xl/worksheets/sheet2.xml": `<worksheet xmlns="${S}" xmlns:r="${R}"><cols><col min="3" max="3" hidden="1"/></cols><sheetData>${rows}</sheetData><mergeCells count="1"><mergeCell ref="A6:B6"/></mergeCells><hyperlinks><hyperlink ref="B7" r:id="external"/></hyperlinks></worksheet>`,
      "xl/worksheets/_rels/sheet2.xml.rels": rels(
        `<Relationship Id="external" Type="${R}/hyperlink" Target="https://example.invalid/workbook-tracker" TargetMode="External"/>`
      ),
      "xl/worksheets/sheet3.xml": sheet(
        `<row r="1">${cell("A1", "Summary follows inventory")}</row>`
      ),
      ...extra,
    },
    level
  );
}

const paragraph = (text: string, bullet = false) =>
  `<a:p>${bullet ? '<a:pPr lvl="0"><a:buChar char="•"/></a:pPr>' : ""}<a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p>`;
const shape = (id: number, body: string, placeholder = "") =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>`;

export function externalPptx(
  note = "Speaker-only approval expires after 47 days.",
  extra: Record<string, Uint8Array> = {},
  level: 0 | 6 = 6
): Uint8Array {
  const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Budget table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="${A}/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid>${[
    ["Region", "Budget"],
    ["Pune", "4200"],
  ]
    .map(
      (row) =>
        `<a:tr h="300000">${row.map((value) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paragraph(value)}</a:txBody><a:tcPr/></a:tc>`).join("")}</a:tr>`
    )
    .join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  return archive(
    {
      "[Content_Types].xml": contentTypes([
        ["ppt/presentation.xml", "presentationml.presentation.main"],
        ["ppt/slides/slide2.xml", "presentationml.slide"],
        ["ppt/slides/slide1.xml", "presentationml.slide"],
        ["ppt/notesSlides/notesSlide1.xml", "presentationml.notesSlide"],
      ]),
      "_rels/.rels": rels(relationship("office", "officeDocument", "ppt/presentation.xml")),
      "ppt/presentation.xml": `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="257" r:id="second"/><p:sldId id="256" r:id="first"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": rels(
        relationship("first", "slide", "slides/slide1.xml") +
          relationship("second", "slide", "slides/slide2.xml")
      ),
      "ppt/slides/slide2.xml": `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree>${shape(2, paragraph("Approval briefing"), '<p:ph type="title"/>')}${shape(3, paragraph("Visible review instructions") + paragraph("Check the budget", true))}${table}<p:pic><p:nvPicPr><p:cNvPr id="6" name="External diagram" descr="External diagram"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:link="external"/></p:blipFill><p:spPr/></p:pic></p:spTree></p:cSld></p:sld>`,
      "ppt/slides/slide1.xml": `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree>${shape(2, paragraph("Follow-up actions"), '<p:ph type="title"/>')}${shape(3, paragraph("Publish the decision"))}</p:spTree></p:cSld></p:sld>`,
      "ppt/slides/_rels/slide2.xml.rels": rels(
        relationship("notes", "notesSlide", "../notesSlides/notesSlide1.xml") +
          `<Relationship Id="external" Type="${R}/image" Target="https://example.invalid/presentation-tracker" TargetMode="External"/>`
      ),
      "ppt/notesSlides/notesSlide1.xml": `<p:notes xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree>${shape(2, paragraph(note), '<p:ph type="body" idx="1"/>')}</p:spTree></p:cSld></p:notes>`,
      ...extra,
    },
    level
  );
}

export function manySheetXlsx(): Uint8Array {
  const parts: Record<string, string | Uint8Array> = unzipSync(externalXlsx());
  const count = 201;
  parts["xl/workbook.xml"] =
    `<workbook xmlns="${S}" xmlns:r="${R}"><sheets>${Array.from({ length: count }, (_, index) => `<sheet name="Visible ${index + 1}" sheetId="${index + 1}" r:id="sheet${index + 1}"/>`).join("")}</sheets></workbook>`;
  parts["xl/_rels/workbook.xml.rels"] = rels(
    Array.from({ length: count }, (_, index) =>
      relationship(`sheet${index + 1}`, "worksheet", `worksheets/sheet${index + 1}.xml`)
    ).join("")
  );
  parts["[Content_Types].xml"] = contentTypes([
    ["xl/workbook.xml", "spreadsheetml.sheet.main"],
    ...Array.from({ length: count }, (_, index): [string, string] => [
      `xl/worksheets/sheet${index + 1}.xml`,
      "spreadsheetml.worksheet",
    ]),
  ]);
  for (let index = 0; index < count; index += 1) {
    parts[`xl/worksheets/sheet${index + 1}.xml`] =
      `<worksheet xmlns="${S}"><sheetData><row r="1">${cell("A1", index === count - 1 ? "Final sheet contains 947 tulips." : `Inventory ${index + 1}`)}</row></sheetData></worksheet>`;
  }
  return archive(parts, 6);
}
