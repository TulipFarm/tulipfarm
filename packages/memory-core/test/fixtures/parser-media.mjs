import { crc32, deflateSync } from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { zip } from './parser-documents.mjs';

const packageRelationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const drawingMl = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const pictureUri = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const chartUri = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const presentationMl = 'http://schemas.openxmlformats.org/presentationml/2006/main';

/** A PNG with real pixels, so media mode can decode it. */
export async function png(width = 64, height = 48, color = '#2a7') {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return canvas.encode('png');
}

/** A large but highly compressible PNG: its pixel data is stored uncompressed, so the archive stays small. */
export function storedPng(side) {
  const row = Buffer.alloc(1 + side * 4, 0x80);
  row[0] = 0;
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: side }, () => row)), { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const types = overrides =>
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${overrides
    .map(
      ([part, type]) =>
        `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/>`,
    )
    .join('')}</Types>`;
const rels = entries =>
  `<Relationships xmlns="${packageRelationships}">${entries
    .map(
      ([id, type, target, external]) =>
        `<Relationship Id="${id}" Type="${office}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`,
    )
    .join('')}</Relationships>`;

const wordPicture = (id, alt) =>
  `<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="914400" cy="685800"/><wp:docPr id="1" name="Picture 1" descr="${alt}"/><a:graphic xmlns:a="${drawingMl}"><a:graphicData uri="${pictureUri}"><pic:pic xmlns:pic="${pictureUri}"><pic:nvPicPr><pic:cNvPr id="0" name="map.png" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;

/** DOCX with a paragraph, an embedded picture between runs and a linked picture. */
export async function pictureDocx({ text = 'Orchard plan', alt = 'Orchard map' } = {}) {
  return zip([
    ['[Content_Types].xml', types([['word/document.xml', 'wordprocessingml.document.main+xml']])],
    ['_rels/.rels', rels([['rId1', 'officeDocument', 'word/document.xml']])],
    [
      'word/document.xml',
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${office}"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">See </w:t></w:r><w:r>${wordPicture('rIdImage', alt)}</w:r><w:r><w:t xml:space="preserve"> below.</w:t></w:r></w:p><w:p><w:r>${wordPicture('rIdLinked', 'Remote')}</w:r></w:p></w:body></w:document>`,
    ],
    [
      'word/_rels/document.xml.rels',
      rels([
        ['rIdImage', 'image', 'media/map.png'],
        ['rIdLinked', 'image', 'https://example.com/remote.png', true],
      ]),
    ],
    ['word/media/map.png', await png()],
  ]);
}

const shape = (id, text, placeholder = '') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const slide = content =>
  `<p:sld xmlns:p="${presentationMl}" xmlns:a="${drawingMl}" xmlns:r="${office}"><p:cSld><p:spTree>${content}</p:spTree></p:cSld></p:sld>`;
const picture = (id, alt, extra = '') =>
  `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr="${alt}"/><p:cNvPicPr/><p:nvPr>${extra}</p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImage"/></p:blipFill><p:spPr/></p:pic>`;
const chartFrame = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="${chartUri}"><c:chart xmlns:c="${chartUri}" r:id="rIdChart"/></a:graphicData></a:graphic></p:graphicFrame>`;
const chart = `<c:chartSpace xmlns:c="${chartUri}" xmlns:a="${drawingMl}"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Yield by orchard</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Tonnes</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>North</c:v></c:pt><c:pt idx="1"><c:v>South</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>12</c:v></c:pt><c:pt idx="1"><c:v>30</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`;

/** Two slides: a title, picture, chart and speaker notes, then a slide with a linked video. */
export async function mediaPptx() {
  return zip([
    [
      '[Content_Types].xml',
      types([
        ['ppt/presentation.xml', 'presentationml.presentation.main+xml'],
        ['ppt/slides/slide1.xml', 'presentationml.slide+xml'],
        ['ppt/slides/slide2.xml', 'presentationml.slide+xml'],
        ['ppt/notesSlides/notesSlide1.xml', 'presentationml.notesSlide+xml'],
        ['ppt/charts/chart1.xml', 'drawingml.chart+xml'],
      ]),
    ],
    ['_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml']])],
    [
      'ppt/presentation.xml',
      `<p:presentation xmlns:p="${presentationMl}" xmlns:r="${office}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    ],
    [
      'ppt/_rels/presentation.xml.rels',
      rels([
        ['rId1', 'slide', 'slides/slide2.xml'],
        ['rId2', 'slide', 'slides/slide1.xml'],
      ]),
    ],
    [
      'ppt/slides/slide1.xml',
      slide(`${shape(2, 'Harvest review', '<p:ph type="title"/>')}${picture(3, 'Orchard photo')}${chartFrame}`),
    ],
    [
      'ppt/slides/_rels/slide1.xml.rels',
      rels([
        ['rIdImage', 'image', '../media/photo.png'],
        ['rIdChart', 'chart', '../charts/chart1.xml'],
        ['rIdNotes', 'notesSlide', '../notesSlides/notesSlide1.xml'],
      ]),
    ],
    [
      'ppt/notesSlides/notesSlide1.xml',
      `<p:notes xmlns:p="${presentationMl}" xmlns:a="${drawingMl}"><p:cSld><p:spTree>${shape(2, 'Mention the frost')}</p:spTree></p:cSld></p:notes>`,
    ],
    ['ppt/charts/chart1.xml', chart],
    [
      'ppt/slides/slide2.xml',
      slide(
        `${shape(2, 'Field footage', '<p:ph type="title"/>')}${picture(3, 'Drone video', '<a:videoFile r:link="rIdVideo"/>')}`,
      ),
    ],
    [
      'ppt/slides/_rels/slide2.xml.rels',
      rels([
        ['rIdImage', 'image', '../media/photo.png'],
        ['rIdVideo', 'video', 'https://example.com/drone.mp4', true],
      ]),
    ],
    ['ppt/media/photo.png', await png(80, 60)],
  ]);
}

const sheet = (text, drawing = '') =>
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${office}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row></sheetData>${drawing}</worksheet>`;

/** Two sheets; the second has a picture in its drawing, which AnyDoc alone drops. */
export async function pictureXlsx() {
  return zip([
    [
      '[Content_Types].xml',
      types([
        ['xl/workbook.xml', 'spreadsheetml.sheet.main+xml'],
        ['xl/worksheets/sheet1.xml', 'spreadsheetml.worksheet+xml'],
        ['xl/worksheets/sheet2.xml', 'spreadsheetml.worksheet+xml'],
        ['xl/drawings/drawing1.xml', 'drawing+xml'],
      ]),
    ],
    ['_rels/.rels', rels([['rId1', 'officeDocument', 'xl/workbook.xml']])],
    [
      'xl/workbook.xml',
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${office}"><sheets><sheet name="Totals" sheetId="1" r:id="rId1"/><sheet name="Shelf_1" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      rels([
        ['rId1', 'worksheet', 'worksheets/sheet1.xml'],
        ['rId2', 'worksheet', 'worksheets/sheet2.xml'],
      ]),
    ],
    ['xl/worksheets/sheet1.xml', sheet('Apples 12')],
    ['xl/worksheets/sheet2.xml', sheet('Pears 4', '<drawing r:id="rIdDrawing"/>')],
    ['xl/worksheets/_rels/sheet2.xml.rels', rels([['rIdDrawing', 'drawing', '../drawings/drawing1.xml']])],
    [
      'xl/drawings/drawing1.xml',
      `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="${drawingMl}" xmlns:r="${office}"><xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="1" cy="1"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Picture 1" descr="Shelf photo"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rIdImage"/></xdr:blipFill><xdr:spPr/></xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`,
    ],
    ['xl/drawings/_rels/drawing1.xml.rels', rels([['rIdImage', 'image', '../media/shelf.png']])],
    ['xl/media/shelf.png', await png(40, 90)],
  ]);
}

/** Pages of text, of a full-page image, or of both. */
export async function mediaPdf(kinds) {
  const document = await PDFDocument.create();
  document.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  document.setModificationDate(new Date('2026-01-01T00:00:00Z'));
  const font = await document.embedFont(StandardFonts.Helvetica);
  const image = await document.embedPng(await png(200, 150, '#36c'));
  for (const [index, kind] of kinds.entries()) {
    const page = document.addPage([612, 792]);
    if (kind !== 'text') page.drawImage(image, { x: 40, y: 200, width: 400, height: 300 });
    if (kind !== 'image') page.drawText(`Page ${index + 1} notes on the orchard.`, { x: 40, y: 700, size: 14, font });
  }
  return Buffer.from(await document.save());
}
