import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';

export function zip(entries, { declaredSize } = {}) {
  const records = [];
  const directory = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(content);
    const compressed = deflateRawSync(bytes);
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredSize ?? bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    records.push(local, filename, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredSize ?? bytes.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, central, end]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeRelationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function packageParts(type, part, body, extra = []) {
  return zip([
    [
      '[Content_Types].xml',
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/></Types>`,
    ],
    [
      '_rels/.rels',
      `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${officeRelationships}/officeDocument" Target="${part}"/></Relationships>`,
    ],
    [part, body],
    ...extra,
  ]);
}

export function docx() {
  return packageParts(
    'wordprocessingml.document.main+xml',
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Orchard policy</w:t></w:r></w:p><w:p><w:r><w:t>Harvest apples on Tuesday.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Fruit</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Count</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Apple</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
  );
}

export function xlsx() {
  return packageParts(
    'spreadsheetml.sheet.main+xml',
    'xl/workbook.xml',
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${officeRelationships}"><sheets><sheet name="Inventory" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    [
      [
        'xl/_rels/workbook.xml.rels',
        `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${officeRelationships}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      ],
      [
        'xl/worksheets/sheet1.xml',
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Fruit</t></is></c><c r="B1" t="inlineStr"><is><t>Count</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Apple</t></is></c><c r="B2"><v>12</v></c></row></sheetData></worksheet>',
      ],
    ],
  );
}

export function pptx() {
  return packageParts(
    'presentationml.presentation.main+xml',
    'ppt/presentation.xml',
    `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${officeRelationships}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    [
      [
        'ppt/_rels/presentation.xml.rels',
        `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${officeRelationships}/slide" Target="slides/slide1.xml"/></Relationships>`,
      ],
      [
        'ppt/slides/slide1.xml',
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Orchard harvest briefing</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
      ],
    ],
  );
}

export function odt() {
  return zip([
    ['mimetype', 'application/vnd.oasis.opendocument.text'],
    [
      'content.xml',
      '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:h text:outline-level="1">Orchard policy</text:h><text:p>Harvest apples on Tuesday.</text:p></office:text></office:body></office:document-content>',
    ],
  ]);
}

export async function pdf(kinds = ['text']) {
  const document = await PDFDocument.create();
  document.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  document.setModificationDate(new Date('2026-01-01T00:00:00Z'));
  const font = await document.embedFont(StandardFonts.Helvetica);
  const image = await document.embedPng(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  for (const kind of kinds) {
    const page = document.addPage([612, 792]);
    if (kind === 'scan' || kind === 'mixed') page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
    if (kind === 'text' || kind === 'mixed')
      page.drawText('Harvest apples on Tuesday. Keep every orchard record.', { x: 40, y: 700, size: 12, font });
  }
  return document.save();
}

export function encryptedPdf() {
  const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
  const pad = password => Buffer.concat([Buffer.from(password), padding]).subarray(0, 32);
  const md5 = bytes => createHash('md5').update(bytes).digest();
  const id = md5(Buffer.from('orchard-encrypted-fixture'));
  const owner = rc4(md5(pad('owner')).subarray(0, 5), pad('secret'));
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  const key = md5(Buffer.concat([pad('secret'), owner, permissions, id])).subarray(0, 5);
  const user = rc4(key, padding);
  const streamKey = md5(Buffer.concat([key, Buffer.from([4, 0, 0, 0, 0])])).subarray(0, 10);
  const content = rc4(streamKey, Buffer.from('BT /F1 12 Tf 40 700 Td (Secret orchard policy) Tj ET'));
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    ),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    Buffer.from(`<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`),
  ];
  const parts = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  let offset = parts[0].length;
  objects.forEach((object, index) => {
    offsets.push(offset);
    const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
    parts.push(part);
    offset += part.length;
  });
  parts.push(
    Buffer.from(
      `xref\n0 7\n0000000000 65535 f \n${offsets
        .slice(1)
        .map(value => `${String(value).padStart(10, '0')} 00000 n \n`)
        .join(
          '',
        )}trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${offset}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

export function officeParts(bytes) {
  const entries = [];
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const length = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const start = offset + 30 + nameLength + bytes.readUInt16LE(offset + 28);
    entries.push([
      bytes.subarray(offset + 30, offset + 30 + nameLength).toString(),
      inflateRawSync(bytes.subarray(start, start + length)).toString(),
    ]);
    offset = start + length;
  }
  return entries;
}

export function incompleteOffice(kind, defect = 'missing-part') {
  const isSlide = kind === 'pptx';
  const entries = officeParts(isSlide ? pptx() : xlsx());
  const main = isSlide ? 'ppt/presentation.xml' : 'xl/workbook.xml';
  const rels = isSlide ? 'ppt/_rels/presentation.xml.rels' : 'xl/_rels/workbook.xml.rels';
  const target = isSlide ? 'slides/slide2.xml' : 'worksheets/sheet2.xml';
  const type = isSlide ? 'slide' : 'worksheet';
  const declaration = isSlide
    ? '<p:sldId id="257" r:id="rId2"/>'
    : '<sheet name="Missing budget" sheetId="2" r:id="rId2"/>';
  for (const entry of entries) {
    if (entry[0] === main)
      entry[1] = entry[1].replace(
        isSlide ? '</p:sldIdLst>' : '</sheets>',
        `${declaration}${isSlide ? '</p:sldIdLst>' : '</sheets>'}`,
      );
    if (entry[0] === rels && defect !== 'missing-relationship')
      entry[1] = entry[1].replace(
        '</Relationships>',
        `<Relationship Id="rId2" Type="${officeRelationships}/${defect === 'wrong-type' ? 'image' : type}" Target="${target}" ${defect === 'external' ? 'TargetMode="External"' : ''}/></Relationships>`,
      );
  }
  if (defect !== 'missing-part')
    entries.push([
      `${isSlide ? 'ppt' : 'xl'}/${target}`,
      defect === 'malformed-part'
        ? '<broken'
        : entries
            .find(([name]) => name.endsWith(isSlide ? 'slide1.xml' : 'sheet1.xml'))[1]
            .replaceAll('Apple', 'Missing budget 450')
            .replaceAll('Orchard harvest briefing', 'Missing budget 450'),
    ]);
  return zip(entries);
}

export function docxFeature(kind, defect = 'complete') {
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const roots = { header: 'hdr', footer: 'ftr', comments: 'comments', footnotes: 'footnotes', endnotes: 'endnotes' };
  const references = {
    header: '<w:sectPr><w:headerReference w:type="default" r:id="feature"/></w:sectPr>',
    footer: '<w:sectPr><w:footerReference w:type="default" r:id="feature"/></w:sectPr>',
    comments:
      '<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>Budget reviewed</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>',
    footnotes: '<w:p><w:r><w:t>Budget</w:t><w:footnoteReference w:id="1"/></w:r></w:p>',
    endnotes: '<w:p><w:r><w:t>Budget</w:t><w:endnoteReference w:id="1"/></w:r></w:p>',
    checkbox:
      '<w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Approved</w:t></w:r></w:p></w:sdtContent></w:sdt>',
    legacyCheckbox:
      '<w:p><w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:checkBox><w:checked w:val="1"/></w:checkBox></w:ffData></w:fldChar></w:r><w:r><w:instrText> FORMCHECKBOX </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t>Approved</w:t></w:r></w:p>',
  };
  const extra = [];
  if (roots[kind]) {
    if (defect !== 'missing-relationship')
      extra.push([
        'word/_rels/document.xml.rels',
        `<Relationships xmlns="${relationships}"><Relationship Id="feature" Type="${officeRelationships}/${kind}" Target="facts/${kind}.xml"/></Relationships>`,
      ]);
    if (defect !== 'missing-part') {
      const inner = kind.endsWith('notes')
        ? `<w:${kind.slice(0, -1)} w:id="${defect === 'missing-id' ? 2 : 1}"><w:p><w:r><w:t>Maximum is 450</w:t></w:r></w:p></w:${kind.slice(0, -1)}>`
        : kind === 'comments'
          ? '<w:comment w:id="1" w:author="Reviewer"><w:p><w:r><w:t>Maximum is 450</w:t></w:r></w:p></w:comment>'
          : '<w:p><w:r><w:t>Maximum is 450</w:t></w:r></w:p>';
      extra.push([`word/facts/${kind}.xml`, `<w:${roots[kind]} xmlns:w="${w}">${inner}</w:${roots[kind]}>`]);
    }
  }
  return packageParts(
    'wordprocessingml.document.main+xml',
    'word/document.xml',
    `<w:document xmlns:w="${w}" xmlns:r="${officeRelationships}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body><w:p><w:r><w:t>Harvest apples on Tuesday.</w:t></w:r></w:p>${references[kind]}</w:body></w:document>`,
    extra,
  );
}

export async function prefixedPdf(kind, prefix = '\n') {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  if (kind === 'text') {
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText('Harvest apples on Tuesday.', { x: 40, y: 700, font, size: 12 });
  } else {
    const glyphs = [
      '101 111 111',
      '101 100 101',
      '101 100 101',
      '111 111 101',
      '001 001 101',
      '001 001 101',
      '001 111 111',
    ];
    const pixels = glyphs
      .join('')
      .replaceAll(' ', '0')
      .split('')
      .map(bit => (bit === '1' ? '00' : 'ff'))
      .join('');
    const image = document.context.register(
      document.context.stream(`${pixels}>`, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 11,
        Height: 7,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
        Filter: 'ASCIIHexDecode',
      }),
    );
    page.node.setXObject(PDFName.of('Scan'), image);
    page.node.addContentStream(document.context.register(document.context.stream('q 612 0 0 792 0 0 cm /Scan Do Q')));
  }
  const bytes = Buffer.from(await document.save({ useObjectStreams: false }));
  let text = bytes.toString('latin1').replace(/^%[^\r\n]*$/m, '%PDF-1.7');
  text = text.replace(/^(%PDF-[^\n]*\n)%[^\r\n]*/, (_, header) => `${header}%%%%%`);
  text = text.replace(
    /^(\d{10}) 00000 n /gm,
    (_, offset) => `${String(Number(offset) + prefix.length).padStart(10, '0')} 00000 n `,
  );
  text = text.replace(/startxref\n(\d+)/, (_, offset) => `startxref\n${Number(offset) + prefix.length}`);
  return Buffer.from(prefix + text, 'latin1');
}

function rc4(key, input) {
  const state = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + state[i] + key[i % key.length]) % 256;
    [state[i], state[j]] = [state[j], state[i]];
  }
  let i = 0;
  j = 0;
  return Buffer.from(
    input.map(byte => {
      i = (i + 1) % 256;
      j = (j + state[i]) % 256;
      [state[i], state[j]] = [state[j], state[i]];
      return byte ^ state[(state[i] + state[j]) % 256];
    }),
  );
}
