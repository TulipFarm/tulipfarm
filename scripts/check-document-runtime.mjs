import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(resolve("package.json"));
const fromFiles = createRequire(require.resolve("@tulipfarm/files"));
const nativePath = fromFiles.resolve("@firecrawl/anydoc");
const fromNative = createRequire(nativePath);
assert.equal(fromFiles("@firecrawl/anydoc/package.json").version, "0.2.4");
const libc =
  process.platform === "linux"
    ? process.report.getReport().header.glibcVersionRuntime
      ? "-gnu"
      : "-musl"
    : "";
fromNative.resolve(`@firecrawl/anydoc-${process.platform}-${process.arch}${libc}`);

const { zipSync } = fromFiles("fflate");
const encode = (text) => new TextEncoder().encode(text);
const archive = (parts) =>
  zipSync(Object.fromEntries(Object.entries(parts).map(([name, text]) => [name, encode(text)])));
const marker = "Local packaged conversion 7391";
const docx = archive({
  "[Content_Types].xml":
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  "_rels/.rels":
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${marker}</w:t></w:r></w:p></w:body></w:document>`,
});
const xlsx = archive({
  "[Content_Types].xml":
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  "_rels/.rels":
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  "xl/workbook.xml":
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Packaged budget" sheetId="1" r:id="rId1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels":
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Total</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>${marker}</t></is></c><c r="B2"><v>7391</v></c></row></sheetData></worksheet>`,
});
const pptx = archive({
  "[Content_Types].xml":
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
  "_rels/.rels":
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
  "ppt/presentation.xml":
    '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>',
  "ppt/_rels/presentation.xml.rels":
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
  "ppt/slides/slide1.xml": `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Packaged slide"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${marker}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
});

function pdfFixture(imageOnly = false) {
  const content = imageOnly
    ? "q 612 0 0 792 0 0 cm /Scan Do Q"
    : `BT /Heading 24 Tf 72 720 Td (Packaged handbook) Tj ET\nBT /Body 12 Tf 72 680 Td (${marker}) Tj ET`;
  const image = "ffffff000000000000ffffff>";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /Body 4 0 R /Heading 5 0 R >> ${imageOnly ? "/XObject << /Scan 7 0 R >>" : ""} >> /Contents 6 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  if (imageOnly) {
    objects.push(
      `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${image.length} >>\nstream\n${image}\nendstream`
    );
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encode(pdf);
}

async function convert(format, bytes, maxChars = 200_000) {
  const original = Buffer.from(bytes);
  const child = fork(resolve("document-child.cjs"), [], {
    execArgv: [],
    serialization: "advanced",
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: { FIRECRAWL_API_KEY: "packaging-no-network", FIRECRAWL_API_URL: "http://127.0.0.1:9" },
  });
  const outcome = await new Promise((complete, reject) => {
    let message;
    let failure;
    const timer = setTimeout(() => {
      failure = new Error(`Packaged ${format} child exceeded deadline`);
      child.kill("SIGKILL");
    }, 10_000);
    child.once("error", (error) => {
      failure = error;
      child.kill("SIGKILL");
    });
    child.once("message", (result) => {
      message = result;
      child.kill("SIGKILL");
    });
    child.once("close", () => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else complete(message);
    });
    child.send({ bytes, format, maxChars }, (error) => {
      if (error) {
        failure = error;
        child.kill("SIGKILL");
      }
    });
  });
  assert.deepEqual(Buffer.from(bytes), original, `${format} source bytes must remain intact`);
  return outcome;
}

const fixtures = { docx, xlsx, pptx, pdf: pdfFixture() };
const visual = { kind: "pdf", pages: [{ width: 1224, height: 1584 }] };
for (const format of ["docx", "xlsx", "pptx", "pdf"]) {
  const outcome = await convert(format, fixtures[format]);
  assert.equal(outcome?.kind, "text", `${format}: ${JSON.stringify(outcome)}`);
  assert.ok(outcome.text.includes(marker), `${format} lost the fixture text`);
  assert.equal(outcome.truncated, false);
  if (format === "docx") assert.equal(outcome.text, marker);
  if (format === "xlsx") assert.ok(outcome.text.includes("Total"));
  if (format === "pdf") {
    assert.match(outcome.text, /^#{1,6} Packaged handbook\s*$/m);
    assert.deepEqual(outcome.visual, visual);
    const capped = await convert(format, fixtures[format], 12);
    assert.deepEqual(capped, {
      kind: "text",
      text: outcome.text.slice(0, 12),
      truncated: true,
      visual,
    });
  }
  process.stdout.write(
    `${format.toUpperCase()} runtime verified: ${process.platform}/${process.arch}${libc}\n`
  );
}
assert.deepEqual(await convert("pdf", pdfFixture(true)), {
  kind: "refused",
  reason: "needs_ocr",
  visual,
});
process.stdout.write("PDF OCR rejected locally; page dimensions retained\n");
