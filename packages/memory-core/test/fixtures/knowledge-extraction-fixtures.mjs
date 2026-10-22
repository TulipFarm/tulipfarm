import { crc32 } from 'node:zlib';

export const paragraph = text => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
export const textStream = text => `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;

export function pdf(streams, image = '') {
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
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${streams.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${streams.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  const imageId = 4 + streams.length * 2;
  const imageResource = image === 'xobject' || image === 'mask' ? `/XObject << /Scan ${imageId} 0 R >>` : '';
  for (const [i, stream] of streams.entries()) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> ${imageResource} >> /Contents ${5 + i * 2} 0 R >>`,
    );
    const paint = image === 'inline' ? `BI /W 11 /H 7 /CS /G /BPC 8 /F /AHx ID ${pixels}> EI` : '/Scan Do';
    const contents = `${image ? `q 330 0 0 210 72 300 cm ${paint} Q\n` : ''}${stream}`;
    objects.push(`<< /Length ${Buffer.byteLength(contents)} >>\nstream\n${contents}\nendstream`);
  }
  const imageData = image === 'mask' ? '80>' : `${pixels}>`;
  if (imageResource)
    objects.push(
      `<< /Type /XObject /Subtype /Image /Width ${image === 'mask' ? 1 : 11} /Height ${image === 'mask' ? 1 : 7} ${image === 'mask' ? '/ImageMask true /BitsPerComponent 1' : '/ColorSpace /DeviceGray /BitsPerComponent 8'} /Filter /ASCIIHexDecode /Length ${imageData.length} >>\nstream\n${imageData}\nendstream`,
    );
  let output = '%PDF-1.4\n';
  const offsets = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(output);
}

export function docx(body, extra = [], contentTypes = '') {
  const noteTypes = ['footnote', 'endnote']
    .filter(kind => extra.some(([path]) => path === `word/${kind}s.xml`))
    .map(
      kind =>
        `<Override PartName="/word/${kind}s.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}s+xml"/>`,
    )
    .join('');
  const entries = [
    [
      '[Content_Types].xml',
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${noteTypes}${contentTypes}</Types>`,
    ],
    [
      'word/document.xml',
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml"><w:body>${body}</w:body></w:document>`,
    ],
    ...extra,
  ];
  const local = [],
    central = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name),
      data = Buffer.from(value);
    const header = Buffer.alloc(30),
      directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc32(data), 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, filename, data);
    central.push(directory, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export const relationships = entries => [
  'word/_rels/document.xml.rels',
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.join('')}</Relationships>`,
];
export const relationship = (type, target, extra = '') =>
  `<Relationship Id="${type}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}" ${extra}/>`;
export const note = type => [
  `word/${type}s.xml`,
  `<w:${type}s xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:${type} w:id="1">${paragraph(type === 'footnote' ? 'Maximum is 450' : 'Due Friday')}</w:${type}></w:${type}s>`,
];

export function imageDocx(external = false) {
  return docx(
    '<w:p><w:r><w:t>Budget</w:t><w:pict><v:shape><v:imagedata r:id="image"/></v:shape></w:pict></w:r></w:p>',
    [
      relationships([
        relationship(
          'image',
          external ? 'file:///unavailable/scan.png' : 'media/scan.png',
          external ? 'TargetMode="External"' : '',
        ),
      ]),
      [
        'word/media/scan.png',
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=',
          'base64',
        ),
      ],
    ],
    '<Default Extension="png" ContentType="image/png"/>',
  );
}

export function sectionDocx(kind, pageType = 'default', partName = `${kind}1.xml`, declared = true) {
  const root = kind === 'header' ? 'hdr' : 'ftr';
  return docx(
    `${paragraph('Budget')}<w:sectPr><w:${kind}Reference w:type="${pageType}" r:id="${kind}"/></w:sectPr>`,
    [
      relationships([relationship(kind, partName)]),
      [
        `word/${partName}`,
        `<w:${root} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${paragraph(kind === 'header' ? 'Maximum is 450' : 'Due Friday')}</w:${root}>`,
      ],
    ],
    declared
      ? `<Override PartName="/word/${partName}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml"/>`
      : '',
  );
}
