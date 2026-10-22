import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import { extractKnowledge } from '../src/knowledge-extraction.ts';

function pdf(text) {
  const stream = text === null ? '' : `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(output);
  output += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(output);
}

function docx(text) {
  const entries = [
    [
      '[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      'word/document.xml',
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ],
  ];
  const local = [],
    central = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name),
      data = Buffer.from(value);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
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

test('reads UTF-8 text, Markdown and source code without removing content', async () => {
  for (const name of ['brief.txt', 'brief.MD', 'code.ts']) {
    assert.equal(
      await extractKnowledge(name, Buffer.from('# Brief\nCafé 🌿\nconst budget = 450;')),
      '# Brief\nCafé 🌿\nconst budget = 450;',
    );
  }
});

test('extracts a real text PDF and DOCX as normalized Markdown', async () => {
  assert.equal((await extractKnowledge('brief.pdf', pdf('Marketing budget 450'))).trim(), '## Marketing budget 450');
  assert.equal((await extractKnowledge('brief.docx', docx('Marketing budget 450'))).trim(), 'Marketing budget 450');
});

test('compiled export uses the shared parser for real document bytes', async () => {
  const compiled = await import('../dist/knowledge-extraction.js');
  assert.equal((await compiled.extractKnowledge('brief.pdf', pdf('Compiled PDF'))).trim(), '## Compiled PDF');
  assert.equal((await compiled.extractKnowledge('brief.docx', docx('Compiled DOCX'))).trim(), 'Compiled DOCX');
});

test('rejects scans, corrupt documents, invalid text and unsupported formats', async () => {
  for (const [name, bytes] of [
    ['scan.pdf', pdf(null)],
    ['broken.pdf', Buffer.from('%PDF-invalid')],
    ['broken.docx', Buffer.from('invalid zip')],
    ['blank.docx', docx('')],
    ['bad.txt', Buffer.from([255])],
    ['nul.txt', Buffer.from('a\0b')],
    ['empty.md', Buffer.from('  ')],
    ['large.txt', Buffer.alloc(1048577, 65)],
    ['huge.pdf', Buffer.alloc(10 * 1024 * 1024 + 1)],
  ])
    await assert.rejects(extractKnowledge(name, bytes), { message: 'unreadable-file' });
  for (const name of ['image.png', 'sheet.xlsx', 'slides.pptx', 'data.csv']) {
    await assert.rejects(extractKnowledge(name, Buffer.from('not supported')), { message: 'unsupported-file' });
  }
});
