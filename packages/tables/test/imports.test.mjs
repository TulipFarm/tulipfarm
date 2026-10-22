import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import { parseImportFile, TableImportError } from '../../tables/dist/imports.js';

const csv = { format: 'csv', delimiter: ',', header: { kind: 'row', row: 1 }, conversions: {}, empty: 'null' };
const xlsx = {
  format: 'xlsx',
  sheet: 'Tickets',
  header: { kind: 'row', row: 1 },
  conversions: { count: 'numeric', active: 'boolean' },
  empty: 'null',
};
const bytes = text => Buffer.from(text);
const rejects = (operation, code) =>
  assert.rejects(
    operation,
    error => error instanceof TableImportError && error.code === code && error.message === code,
  );
async function workbook(rows, edit = () => {}) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Tickets');
  rows.forEach(row => sheet.addRow(row));
  edit(book, sheet);
  return Buffer.from(await book.xlsx.writeBuffer());
}

test('CSV preserves quoted delimiters, escaped quotes, BOM, multiline Unicode and leading zeros', async () => {
  assert.deepEqual(
    await parseImportFile(
      bytes('\ufeffid,description,count,active\r\n001,"Hello, ""bird""\n🌿",12.50,true\r\n002,,0,false\r\n'),
      { ...csv, conversions: { count: 'numeric', active: 'boolean' } },
    ),
    [
      {
        id: { kind: 'text', value: '001' },
        description: { kind: 'text', value: 'Hello, "bird"\n🌿' },
        count: { kind: 'numeric', value: '12.50' },
        active: { kind: 'boolean', value: true },
      },
      {
        id: { kind: 'text', value: '002' },
        description: null,
        count: { kind: 'numeric', value: '0' },
        active: { kind: 'boolean', value: false },
      },
    ],
  );
  assert.deepEqual(
    await parseImportFile(bytes('001;=SUM(A1)\n'), {
      ...csv,
      delimiter: ';',
      header: { kind: 'provided', names: ['id', 'literal'] },
    }),
    [{ id: { kind: 'text', value: '001' }, literal: { kind: 'text', value: '=SUM(A1)' } }],
  );
});

test('CSV rejects duplicate headers, missing decisions, malformed widths, invalid quoting and invalid UTF-8 without disclosing values', async () => {
  await rejects(parseImportFile(bytes('secret, secret\n1,2'), csv), 'duplicate-header');
  await rejects(parseImportFile(bytes('a,b\nprivate-secret'), csv), 'malformed-row');
  await rejects(parseImportFile(bytes('a\n1,private-secret'), csv), 'malformed-row');
  await rejects(parseImportFile(bytes('a\n"private-secret'), csv), 'malformed-file');
  await rejects(parseImportFile(Buffer.from([0xff]), csv), 'malformed-file');
  await rejects(parseImportFile(bytes('a\nb'), { format: 'csv' }), 'invalid-selection');
  await rejects(parseImportFile(bytes('a\nb'), { ...csv, conversions: { missing: 'date' } }), 'invalid-selection');
  await rejects(parseImportFile(bytes(',b\n1,2'), csv), 'invalid-header');
});

test('real XLSX selects exact sheet, preserves blanks and requires explicit native date conversion', async () => {
  const data = await workbook(
    [
      ['id', 'count', 'active', 'date'],
      ['001', 12.5, true, new Date('2026-10-01T00:00:00Z')],
      ['002', null, false],
    ],
    book => book.addWorksheet('Other').addRow(['unselected']),
  );
  const before = createHash('sha256').update(data).digest('hex');
  assert.deepEqual(await parseImportFile(data, { ...xlsx, conversions: { ...xlsx.conversions, date: 'date' } }), [
    {
      id: { kind: 'text', value: '001' },
      count: { kind: 'numeric', value: '12.5' },
      active: { kind: 'boolean', value: true },
      date: { kind: 'date', value: '2026-10-01' },
    },
    { id: { kind: 'text', value: '002' }, count: null, active: { kind: 'boolean', value: false }, date: null },
  ]);
  assert.equal(createHash('sha256').update(data).digest('hex'), before);
  await rejects(parseImportFile(data, xlsx), 'invalid-value');
  await rejects(parseImportFile(data, { ...xlsx, sheet: 'Missing' }), 'invalid-selection');
});

test('XLSX rejects formulas even with cached values, merged cells, duplicate headers and extra cells', async () => {
  await rejects(
    parseImportFile(await workbook([['a'], [{ formula: '1+1', result: 2 }]]), { ...xlsx, conversions: {} }),
    'unsupported-cell',
  );
  await rejects(
    parseImportFile(
      await workbook([
        ['a', 'a'],
        [1, 2],
      ]),
      { ...xlsx, conversions: {} },
    ),
    'duplicate-header',
  );
  await rejects(parseImportFile(await workbook([['a'], [1, 2]]), { ...xlsx, conversions: {} }), 'malformed-row');
  await rejects(
    parseImportFile(
      await workbook(
        [
          ['a', 'b'],
          [1, 2],
        ],
        (_, sheet) => sheet.mergeCells('A2:B2'),
      ),
      { ...xlsx, conversions: {} },
    ),
    'unsupported-cell',
  );
});

test('bounds accept exactly 100000 rows and reject the next row, excess bytes, columns and oversized cells', async () => {
  const rows = await parseImportFile(bytes(`id\n${'x\n'.repeat(100000)}`), csv);
  assert.equal(rows.length, 100000);
  assert.deepEqual(rows[99999], { id: { kind: 'text', value: 'x' } });
  await rejects(parseImportFile(bytes(`id\n${'x\n'.repeat(100001)}`), csv), 'row-limit');
  await rejects(parseImportFile(Buffer.alloc(10 * 1024 * 1024 + 1), csv), 'byte-limit');
  await rejects(
    parseImportFile(bytes(`${Array.from({ length: 65 }, (_, i) => `c${i}`).join(',')}\n`), csv),
    'column-limit',
  );
  await rejects(parseImportFile(bytes(`a\n${'x'.repeat(10001)}`), csv), 'invalid-value');
  await rejects(parseImportFile(bytes('a\n1e3'), { ...csv, conversions: { a: 'numeric' } }), 'invalid-value');
});

test('CSV object-like column names remain literal and values require explicit conversions', async () => {
  assert.deepEqual(await parseImportFile(bytes('constructor,toString,__proto__\na,b,c\n'), csv), [
    Object.fromEntries([
      ['constructor', { kind: 'text', value: 'a' }],
      ['toString', { kind: 'text', value: 'b' }],
      ['__proto__', { kind: 'text', value: 'c' }],
    ]),
  ]);
  assert.deepEqual(
    await parseImportFile(bytes('date,time\n2026-10-01,2026-10-01T12:00:00+02:00\n'), {
      ...csv,
      conversions: { date: 'date', time: 'timestamp' },
    }),
    [{ date: { kind: 'date', value: '2026-10-01' }, time: { kind: 'timestamp', value: '2026-10-01T10:00:00.000Z' } }],
  );
});

test('ZIP expansion limit is checked before XLSX decoding', async () => {
  const name = Buffer.from('xl/workbook.xml');
  const compressed = deflateRawSync(Buffer.alloc(64 * 1024 * 1024 + 1));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(64 * 1024 * 1024 + 1, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(64 * 1024 * 1024 + 1, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  await rejects(parseImportFile(Buffer.concat([local, name, compressed, central, name, end]), xlsx), 'byte-limit');
});
