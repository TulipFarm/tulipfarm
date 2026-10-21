import { PDFDocument, PDFName } from 'pdf-lib';
import { pdf, textStream } from './knowledge-extraction-fixtures.mjs';
import { docx, officeParts, xlsx, zip } from './parser-documents.mjs';

const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
const sheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export const nativeHeading = 'Native heading and explanatory budget policy text';

export function mixedInlinePdf() {
  return pdf([textStream(nativeHeading)], 'inline');
}

export async function paintedPdf(kind, container = 'page') {
  const document = await PDFDocument.load(pdf([textStream(nativeHeading)], kind));
  const page = document.getPage(0);
  const stream = page.node.Contents();
  if (container === 'compressed') {
    page.node.set(
      PDFName.of('Contents'),
      document.context.register(document.context.flateStream(stream.getContents())),
    );
  } else if (container === 'form') {
    const form = document.context.register(
      document.context.flateStream(stream.getContents(), {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 612, 792],
        Resources: page.node.Resources(),
      }),
    );
    page.node.set(PDFName.of('Resources'), document.context.obj({ XObject: { Figure: form } }));
    page.node.set(PDFName.of('Contents'), document.context.register(document.context.flateStream('/Fig#75re Do')));
  }
  return Buffer.from(await document.save());
}

export function pdfLexicalControl() {
  return pdf([
    `% BI /Scan Do\n/BI BMC\n/Span << /Description (BI /Scan Do) >> BDC\n${textStream('Budget BI ID EI Do 450')}\nEMC EMC\nBT /F1 12 Tf 72 700 Td <343530> Tj ET`,
  ]);
}

export async function softMaskPdf(mask = 'raster', applied = true) {
  const document = await PDFDocument.load(mixedInlinePdf());
  const page = document.getPage(0);
  const image = Buffer.from(page.node.Contents().getContents())
    .toString('latin1')
    .split('\n')[0]
    .replace('/BPC 8', '/BPC 8 /D [1 0]');
  const form = document.context.register(
    document.context.flateStream(image, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 612, 792],
      Group: { S: 'Transparency', CS: 'DeviceGray' },
    }),
  );
  const state = document.context.register(
    document.context.obj({
      Type: 'ExtGState',
      ...(mask === 'raster'
        ? { SMask: { S: 'Luminosity', G: form } }
        : mask === 'none'
          ? { SMask: 'None' }
          : { ca: 1, CA: 1 }),
    }),
  );
  page.node.Resources().set(PDFName.of('ExtGState'), document.context.obj({ GS: state }));
  page.node.set(
    PDFName.of('Contents'),
    document.context.register(
      document.context.flateStream(`q ${applied ? '/GS gs ' : ''}0 g 0 0 612 792 re f Q\n${textStream(nativeHeading)}`),
    ),
  );
  return Buffer.from(await document.save());
}

export async function annotationPdf(kind = 'inline', appearance = 'N', stateful = false) {
  const document = await PDFDocument.load(pdf([textStream(nativeHeading)], kind === 'cycle' ? '' : kind));
  const page = document.getPage(0);
  const form = document.context.register(
    document.context.flateStream(page.node.Contents().getContents(), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 612, 792],
      Resources: page.node.Resources(),
    }),
  );
  const outer = document.context.register(
    document.context.flateStream('/Figure Do', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 612, 792],
      Resources: { XObject: { Figure: form } },
    }),
  );
  if (kind === 'cycle')
    document.context
      .lookup(outer)
      .dict.set(PDFName.of('Resources'), document.context.obj({ XObject: { Figure: outer } }));
  page.node.set(
    PDFName.of('Contents'),
    document.context.register(document.context.flateStream(textStream(nativeHeading))),
  );
  page.node.set(
    PDFName.of('Annots'),
    document.context.obj([
      document.context.register(
        document.context.obj({
          Type: 'Annot',
          Subtype: 'Stamp',
          Rect: [0, 0, 612, 792],
          AS: 'Visible',
          AP: { [appearance]: stateful ? { Visible: outer } : outer },
        }),
      ),
    ]),
  );
  return Buffer.from(await document.save());
}

export async function splitPaintPdf(painted) {
  const document = await PDFDocument.load(pdf([textStream(nativeHeading)], 'xobject'));
  const page = document.getPage(0);
  const streams = [textStream(nativeHeading), ...(painted ? ['/Sc#61n', '% BI in a comment\nDo'] : [])];
  if (!painted) page.node.Resources().delete(PDFName.of('XObject'));
  page.node.set(
    PDFName.of('Contents'),
    document.context.obj(streams.map(text => document.context.register(document.context.flateStream(text)))),
  );
  return Buffer.from(await document.save());
}

export function altChunkDocx() {
  const entries = officeParts(docx()).map(([path, text]) => [
    path,
    path === 'word/document.xml'
      ? text
          .replace('<w:document ', `<w:document xmlns:r="${office}" `)
          .replace('</w:body>', '<w:altChunk r:id="chunk"/></w:body>')
      : path === '[Content_Types].xml'
        ? text.replace('</Types>', '<Override PartName="/word/chunk.html" ContentType="text/html"/></Types>')
        : text,
  ]);
  entries.push([
    'word/_rels/document.xml.rels',
    `<Relationships xmlns="${packageNs}"><Relationship Id="chunk" Type="${office}/aFChunk" Target="chunk.html"/></Relationships>`,
  ]);
  entries.push(['word/chunk.html', '<html><body><p>Maximum is 450</p></body></html>']);
  return zip(entries);
}

export function symbolDocx(symbol = true) {
  return zip(
    officeParts(docx()).map(([path, text]) => [
      path,
      path === 'word/document.xml'
        ? text.replace(
            '<w:t>Harvest apples on Tuesday.</w:t>',
            symbol
              ? '<w:t>Balance </w:t><w:sym w:font="Symbol" w:char="F02D"/><w:t>450</w:t>'
              : '<w:t>Balance -450</w:t>',
          )
        : text,
    ]),
  );
}

export function cellXlsx(cell, sharedStrings) {
  const entries = officeParts(xlsx()).map(([path, text]) => [
    path,
    path === 'xl/worksheets/sheet1.xml'
      ? text.replace('<c r="B2"><v>12</v></c>', cell)
      : path === 'xl/_rels/workbook.xml.rels' && sharedStrings !== undefined
        ? text.replace(
            '</Relationships>',
            `<Relationship Id="strings" Type="${office}/sharedStrings" Target="strings.xml"/></Relationships>`,
          )
        : text,
  ]);
  if (sharedStrings !== undefined) {
    entries.push(['xl/strings.xml', `<sst xmlns="${sheet}">${sharedStrings}</sst>`]);
    entries[0][1] = entries[0][1].replace(
      '</Types>',
      '<Override PartName="/xl/strings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
    );
  }
  return zip(entries);
}
