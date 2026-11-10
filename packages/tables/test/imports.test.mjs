import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { importWorkbook as workbook } from './import-object-fixture.mjs';
import {
  fileImportSelectionSchema,
  fitFileImportSelection,
  lenientFileImportSelection,
  parseImportFile,
  TableImportError,
  tableImportFailure,
} from '../../tables/dist/imports.js';

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

test('a file selection defaults to a first-row header, no conversions and empty cells as null', async () => {
  const expected = [{ 'Order ID': { kind: 'text', value: 'A-1' }, Amount: null }];
  const file = bytes('Order ID;Amount\nA-1;\n');
  assert.deepEqual(await parseImportFile(file, { format: 'csv', delimiter: ';' }), expected);
  assert.deepEqual(await parseImportFile(file, { format: 'csv', delimiter: ';', header: true }), expected);
  assert.deepEqual(await parseImportFile(file, { format: 'csv', delimiter: ';', header: 1 }), expected);
});

test('a failed preparation names the data row, file row, column and value, and both next steps', async () => {
  const file = bytes(
    'Order ID;Customer;Status;Amount;Order date\nA-1;Stark;Paid;99.99;2026-11-06\nA-2;Wayne;New;abc;2026-11-07\n',
  );
  const error = await parseImportFile(file, {
    format: 'csv',
    delimiter: ';',
    conversions: { Amount: 'numeric' },
  }).catch(error => error);
  assert.ok(error instanceof TableImportError);
  assert.equal(error.code, 'invalid-value');
  assert.deepEqual(error.location, { row: 2, sourceRow: 3, source: 'file', column: 'Amount', value: 'abc' });
  const failure = tableImportFailure(error);
  assert.equal(failure.error, 'import-file-failed');
  assert.equal(
    failure.reason,
    'A value doesn’t fit its column’s conversion: data row 2 (row 3 of the file), column "Amount", value "abc". Correct the value in the file and attach it again.',
  );
  assert.match(failure.instruction, /not a permission denial, and tables\.import\.file is available/);
  for (const code of ['invalid-selection', 'malformed-file', 'import-unavailable']) {
    const { reason } = tableImportFailure(new TableImportError(code));
    assert.ok(reason.length <= 200 && /\. (Ask again|Fix the file|Try again)/.test(reason), reason);
  }
});

test('preparation numbers data rows after a later header row and names the sheet row', async () => {
  const sheet = await workbook([
    ['Orders export'],
    ['id', 'date'],
    ['001', new Date('2026-10-01T00:00:00Z')],
    ['002', 'next tuesday, after the long weekend has ended'],
  ]);
  const error = await parseImportFile(sheet, {
    ...xlsx,
    header: 2,
    conversions: { date: 'date' },
  }).catch(error => error);
  assert.deepEqual(error.location, {
    row: 2,
    sourceRow: 4,
    source: 'sheet',
    column: 'date',
    value: 'next tuesday, after the long weekend ha…',
  });
  assert.match(
    tableImportFailure(error).reason,
    /: data row 2 \(row 4 of the sheet\), column "date", value "next tuesday/,
  );
  const width = await parseImportFile(bytes('a,b\n1,2\n3\n'), csv).catch(error => error);
  assert.deepEqual(width.location, { row: 2, sourceRow: 3, source: 'file' });
  assert.match(
    tableImportFailure(width).reason,
    /^A row has a different number of cells than the header: data row 2 \(row 3 of the file\)\./,
  );
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

test('a loose file selection from chat becomes a valid one', () => {
  for (const [loose, expected] of [
    [
      { format: '.TSV', hasHeader: true, conversions: [{ column: 'Total', type: 'number' }], empty: 'empty_string' },
      { format: 'csv', delimiter: '\t', header: true, conversions: { Total: 'numeric' }, empty: 'text' },
    ],
    [
      { sheetName: 'Orders', headerRow: '2', conversions: { Placed: 'datetime' }, note: 'x' },
      { format: 'xlsx', sheet: 'Orders', header: 2, conversions: { Placed: 'timestamp' } },
    ],
    [
      { format: 'csv', separator: 'semicolon', empty: null },
      { format: 'csv', delimiter: ';', empty: 'null' },
    ],
  ]) {
    const selection = lenientFileImportSelection(loose);
    assert.deepEqual(selection, expected);
    assert.ok(fileImportSelectionSchema.safeParse(selection).success, JSON.stringify(selection));
  }
});

test('a selection is fitted to the file, and every change is listed as an adjustment', async () => {
  const file = bytes('Order ID;Total;Placed\nA-1;12.5;2026-01-02T10:00:00Z\nA-2;n/a;2026-01-03T10:00:00Z\n');
  const { selection, adjustments } = await fitFileImportSelection(file, {
    ...csv,
    conversions: { 'order  id': 'numeric', Total: 'numeric', Placed: 'date', Missing: 'boolean' },
  });
  assert.equal(selection.delimiter, ';');
  assert.deepEqual(selection.conversions, { 'Order ID': 'text', Total: 'text', Placed: 'timestamp' });
  assert.deepEqual(adjustments, [
    { kind: 'delimiter', requested: ',', used: ';' },
    { kind: 'column', requested: 'order  id', used: 'Order ID' },
    { kind: 'conversion-dropped', column: 'Missing', conversion: 'boolean' },
    { kind: 'conversion-changed', column: 'Order ID', requested: 'numeric', used: 'text', example: 'A-1' },
    {
      kind: 'conversion-changed',
      column: 'Placed',
      requested: 'date',
      used: 'timestamp',
      example: '2026-01-02T10:00:00Z',
    },
    { kind: 'conversion-changed', column: 'Total', requested: 'numeric', used: 'text', example: 'n/a' },
  ]);
  assert.equal((await parseImportFile(file, selection)).length, 2);
});

test('a sheet named in another case is used and listed', async () => {
  const file = await workbook([['count'], [1]]);
  assert.deepEqual((await fitFileImportSelection(file, { ...xlsx, sheet: 'tickets', conversions: {} })).adjustments, [
    { kind: 'sheet', requested: 'tickets', used: 'Tickets', only: false },
  ]);
});

test('preparation discovers CSV delimiters and the only XLSX sheet without format or header hints', async () => {
  for (const delimiter of [',', ';']) {
    const file = bytes(`ID${delimiter}Total\nA-1${delimiter}12\nA-2${delimiter}15\nA-3${delimiter}18\n`);
    for (const input of [{}, lenientFileImportSelection({ separator: delimiter === ',' ? 'comma' : 'semicolon' })]) {
      const { selection } = await fitFileImportSelection(file, input);
      assert.equal(selection.format, 'csv');
      assert.equal(selection.delimiter, delimiter);
      assert.equal((await parseImportFile(file, selection)).length, 3);
    }
  }
  const file = await workbook([
    ['ID', 'Total'],
    ['A-1', 12],
    ['A-2', 15],
    ['A-3', 18],
  ]);
  for (const input of [{}, { format: 'xlsx' }]) {
    const { selection } = await fitFileImportSelection(file, input);
    assert.equal(selection.sheet, 'Tickets');
    assert.deepEqual(selection.header, { kind: 'row', row: 1 });
    assert.equal((await parseImportFile(file, selection)).length, 3);
    assert.ok(fileImportSelectionSchema.safeParse(selection).success);
  }
});

test('preparation finds the unique sheet and later header matching the destination fields', async () => {
  const file = await workbook(
    [['Orders export'], [], ['Order ID', 'Total'], ['A-1', 12], ['A-2', 15], ['A-3', 18]],
    book => book.addWorksheet('Notes').addRow(['Read me']),
  );
  const fields = [['Order ID', 'Total']];
  const { selection } = await fitFileImportSelection(file, { format: 'xlsx' }, fields);
  assert.equal(selection.sheet, 'Tickets');
  assert.deepEqual(selection.header, { kind: 'row', row: 3 });
  assert.equal((await parseImportFile(file, selection)).length, 3);
  const csvFile = bytes('Orders export\n\nOrder ID;Total\nA-1;12\nA-2;15\nA-3;18\n');
  const fitted = await fitFileImportSelection(csvFile, {}, fields);
  assert.equal(fitted.selection.delimiter, ';');
  assert.deepEqual(fitted.selection.header, { kind: 'row', row: 3 });
  assert.equal((await parseImportFile(csvFile, fitted.selection)).length, 3);
});

test('ambiguous sheets name their candidates and a next step rather than guessing', async () => {
  const file = await workbook(
    [
      ['ID', 'Total'],
      ['A-1', 12],
    ],
    book => {
      book.addWorksheet('Archive').addRows([
        ['ID', 'Total'],
        ['A-2', 15],
      ]);
    },
  );
  for (const fields of [[], [['ID', 'Total']]]) {
    const error = await fitFileImportSelection(file, { format: 'xlsx' }, fields).catch(error => error);
    assert.ok(error instanceof TableImportError);
    const failure = tableImportFailure(error);
    assert.equal(failure.code, 'ambiguous-selection');
    assert.match(failure.reason, /Tickets.*Archive/);
    assert.match(failure.reason, /Specify the sheet and header row/);
    assert.match(failure.instruction, /not a permission denial/);
  }
  const { selection } = await fitFileImportSelection(file, { format: 'xlsx', sheet: 'Archive' }, [['ID', 'Total']]);
  assert.equal(selection.sheet, 'Archive');
});

test('explicit sheet and header choices are authoritative during preparation', async () => {
  const file = await workbook([
    ['ID', 'Total'],
    ['Order ID', 'Amount'],
    ['A-1', 12],
  ]);
  const { selection } = await fitFileImportSelection(file, { format: 'xlsx', sheet: 'Tickets', header: 1 }, [
    ['Order ID', 'Amount'],
  ]);
  assert.deepEqual(selection.header, { kind: 'row', row: 1 });
  await rejects(fitFileImportSelection(file, { format: 'xlsx', sheet: 'Missing' }), 'invalid-selection');
});

test('an exact worksheet name wins when another name differs only by surrounding spaces', async () => {
  for (const columns of [['ID'], ['ID', 'Total']]) {
    const file = await workbook([columns, columns.map(() => 'A-1')], book =>
      book.addWorksheet(' Tickets ').addRows([
        ['ID', 'Total'],
        ['A-2', '12'],
      ]),
    );
    for (const sheet of ['Tickets', ' Tickets ']) {
      const { selection } = await fitFileImportSelection(file, { format: 'xlsx', sheet, header: 1 }, [['ID', 'Total']]);
      assert.equal(selection.sheet, sheet);
      assert.equal((await parseImportFile(file, selection)).length, 1);
    }
  }
});

test('a selection that already fits the file is unchanged', async () => {
  const file = bytes('a,b\n1,2\n');
  assert.deepEqual(await fitFileImportSelection(file, { ...csv, conversions: { a: 'numeric' } }), {
    selection: { ...csv, conversions: { a: 'numeric' } },
    adjustments: [],
  });
});
