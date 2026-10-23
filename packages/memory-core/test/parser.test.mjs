import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEncoding } from 'js-tiktoken';
import {
  parseKnowledgeDocument,
  KnowledgeParseError,
  parserRetry,
  retryTransientParse,
  transientParseFailure,
} from '../dist/parser.js';
import { chunkMarkdown } from '../dist/parser/chunks.js';
import {
  docx,
  xlsx,
  pptx,
  odt,
  pdf,
  encryptedPdf,
  zip,
  incompleteOffice,
  docxFeature,
  prefixedPdf,
  officeParts,
} from './fixtures/parser-documents.mjs';
import { strictAdmissionFixtures, rewriteDocx } from './fixtures/knowledge-extraction-admission-fixtures.mjs';

const encoding = getEncoding('cl100k_base');
const parse = (bytes, filename = 'policy.md', mediaType = 'text/markdown') =>
  parseKnowledgeDocument({ bytes: Buffer.from(bytes), filename, mediaType });
const failure = code => error => error instanceof KnowledgeParseError && error.failure === code && error.code === code;

test('DOCX rejects proven native semantic loss before returning any chunks', async () => {
  const fixtures = new Map(strictAdmissionFixtures());
  for (const name of [
    'unknown WordML element with a fact',
    'text in paragraph properties',
    'text in section properties',
    'text in run properties',
    'spoofed WordML text namespace',
    'unqualified lookalike text element',
  ]) {
    await assert.rejects(parse(await fixtures.get(name), 'facts.docx'), failure('unsupported'), name);
  }
  const aligned = async alignment =>
    rewriteDocx(await fixtures.get('superscript exponent'), [
      ['word/document.xml', xml => xml.replace('superscript', alignment)],
    ]);
  // Raised and lowered text keeps a mark, so an exponent cannot read as a larger number.
  for (const [alignment, text] of [
    ['superscript', 'Area 10^2 square metres\n'],
    ['subscript', 'Area 10_2 square metres\n'],
    ['baseline', 'Area 102 square metres\n'],
  ])
    assert.equal((await parse(await aligned(alignment), 'facts.docx')).markdown, text, alignment);
  for (const container of ['p', 'r']) {
    const bytes = await rewriteDocx(await fixtures.get('unknown WordML element with a fact'), [
      [
        'word/document.xml',
        xml =>
          xml
            .replace('<w:unknown>450</w:unknown>', '')
            .replace(`</w:${container}>`, `<w:unknown>450</w:unknown></w:${container}>`),
      ],
    ]);
    await assert.rejects(parse(bytes, 'facts.docx'), failure('unsupported'), container);
  }
  const aliased = await rewriteDocx(await fixtures.get('superscript exponent'), [
    ['word/document.xml', xml => xml.replaceAll('w:', 'word:').replace('xmlns:w=', 'xmlns:word=')],
  ]);
  // An aliased WordML prefix is the same namespace, so the raised digit is still marked.
  assert.equal((await parse(aliased, 'facts.docx')).markdown, 'Area 10^2 square metres\n');
  const result = await parse(await fixtures.get('struck out amount'), 'facts.docx');
  assert.equal(result.markdown, 'Limit ~~450~~ 500\n');
  assert.equal(result.chunks[0].text, 'Limit ~~450~~ 500');
});

test('native DOCX loses vertical alignment and unknown facts but retains strikethrough', async () => {
  const { toMarkdownBytes } = await import('@firecrawl/anydoc/index.js');
  const fixtures = new Map(strictAdmissionFixtures());
  assert.equal(await toMarkdownBytes(await fixtures.get('superscript exponent')), 'Area 102 square metres\n');
  assert.equal(await toMarkdownBytes(await fixtures.get('struck out amount')), 'Limit ~~450~~ 500\n');
  for (const name of [
    'unknown WordML element with a fact',
    'text in paragraph properties',
    'text in section properties',
    'text in run properties',
    'spoofed WordML text namespace',
    'unqualified lookalike text element',
  ]) {
    assert.equal(await toMarkdownBytes(await fixtures.get(name)), 'Budget\n', name);
  }
});

test('normalizes UTF-8, preserves headings, and measures actual embedding text', async () => {
  const result = await parse('\uFEFF# Orchard\r\n\r\nCafe\u0301 records.\r\n');
  assert.equal(result.markdown, '# Orchard\n\nCafé records.\n');
  assert.equal(result.pages, 0);
  assert.equal(result.profile.engine, 'text');
  assert.equal(result.profile.ocr, 'disabled');
  assert.deepEqual(result.chunks, [
    {
      heading: 'Orchard',
      text: '# Orchard\n\nCafé records.',
      tokens: encoding.encode('# Orchard\n\nCafé records.').length,
      offset: { kind: 'passage' },
    },
  ]);
  assert.equal(result.tokens, result.chunks[0].tokens);
});

test('splits with heading context, bounded overlap, and lossless Unicode', async () => {
  const body = Array.from({ length: 1100 }, (_, i) => `Record${i} 🌻 apples are ready.\n`).join('');
  const result = await parse(`# Orchard\n\n## Harvest\n\n${body}`);
  const passages = result.chunks.filter(chunk => chunk.heading === 'Orchard > Harvest');
  assert.ok(passages.length > 5);
  for (const chunk of passages) {
    assert.ok(chunk.text.startsWith('# Orchard\n## Harvest\n\n'));
    assert.equal(chunk.tokens, encoding.encode(chunk.text, [], []).length);
    assert.ok(chunk.tokens <= 800);
    assert.ok(!chunk.text.includes('\uFFFD'));
  }
  for (let i = 0; i < 1100; i += 1)
    assert.ok(
      passages.some(chunk => chunk.text.includes(`Record${i} 🌻 apples are ready.`)),
      `missing record ${i}`,
    );
  assert.equal(
    result.tokens,
    result.chunks.reduce((sum, chunk) => sum + chunk.tokens, 0),
  );
});

test('long tables repeat their header without losing rows', async () => {
  const rows = Array.from({ length: 400 }, (_, i) => `| Apple ${i} | ${i + 12} |`).join('\n');
  const result = await parse(`# Inventory\n\n| Fruit | Count |\n| --- | --- |\n${rows}`);
  assert.ok(result.chunks.length > 2);
  for (const chunk of result.chunks) {
    assert.ok(chunk.text.includes('| Fruit | Count |\n| --- | --- |'));
    assert.ok(chunk.tokens <= 800);
  }
  for (let i = 0; i < 400; i += 1)
    assert.ok(result.chunks.some(chunk => chunk.text.includes(`| Apple ${i} | ${i + 12} |`)));
});

for (const position of ['first', 'later']) {
  test(`oversized ${position} table row splits cells losslessly with section and header context`, async () => {
    const header = '| Key | Value | Notes |\n| --- | --- | --- |';
    const cells = [
      'row-key',
      Array.from({ length: 400 }, (_, i) => `fact${i} 🌻 東京 \\| `).join(''),
      'tail🪻'.repeat(300),
    ];
    const oversized = `|${cells.join('|')}|`;
    const before = position === 'later' ? '| earlier | short | retained |\n' : '';
    const after = '| later | short | retained |';
    const markdown = `# Orchard\n\n## Inventory\n\n${header}\n${before}${oversized}\n${after}\n`;
    const result = await parse(markdown);
    assert.equal(result.markdown, markdown);
    const tableChunks = result.chunks.filter(chunk => chunk.text.includes(header));
    assert.ok(tableChunks.length > 2);
    const reconstructed = ['', ''];
    for (const chunk of tableChunks) {
      assert.ok(chunk.text.startsWith('# Orchard\n## Inventory\n\n'));
      assert.equal(chunk.heading, 'Orchard > Inventory');
      assert.equal(chunk.tokens, encoding.encode(chunk.text, [], []).length);
      assert.ok(chunk.tokens <= 800);
      assert.ok(chunk.text.isWellFormed());
      for (const row of chunk.text.split(`${header}\n`)[1].split('\n')) {
        if (row === '| earlier | short | retained |' || row === after) continue;
        const fragments = row.split(/(?<!\\)\|/).slice(1, -1);
        assert.equal(fragments.length, cells.length);
        assert.equal(fragments[0], cells[0], 'every continuation retains its row identity');
        assert.ok(
          fragments.slice(1).some(fragment => fragment.length > 0),
          'every continuation consumes new content',
        );
        fragments.slice(1).forEach((fragment, index) => {
          reconstructed[index] += fragment;
        });
      }
    }
    assert.deepEqual(reconstructed, cells.slice(1));
    assert.ok(tableChunks.some(chunk => chunk.text.includes(after)));
    if (before) assert.ok(tableChunks.some(chunk => chunk.text.includes(before.trim())));
    assert.equal(
      result.tokens,
      result.chunks.reduce((sum, chunk) => sum + chunk.tokens, 0),
    );
  });
}

test('ordinary table rows and cells remain unchanged in one chunk', async () => {
  const markdown = '# Inventory\n\n| Fruit | Notes |\n| --- | --- |\n| Apple | red \\| green |\n| Pear | 🌻 |\n';
  const result = await parse(markdown);
  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0].text, markdown.trim());
  assert.ok(result.chunks[0].tokens <= 800);
});

test('oversized tables without outer pipes retain column positions and whitespace', async () => {
  const header = 'Key | Value\n--- | ---';
  const cells = ['key ', ' 🌻 apples '.repeat(1200)];
  const result = await parse(`# Inventory\n\n${header}\n${cells.join('|')}\n`);
  let restored = '';
  assert.ok(result.chunks.length > 1);
  for (const chunk of result.chunks) {
    assert.ok(chunk.tokens <= 800);
    const row = chunk.text.split(`${header}\n`)[1];
    const fragments = row.split('|').slice(1, -1);
    assert.equal(fragments.length, 2);
    assert.equal(fragments[0], cells[0]);
    assert.ok(fragments[1].length > 0);
    restored += fragments[1];
  }
  assert.equal(restored, cells[1]);
});

test('table continuations repeat bounded short cells left-to-right without dropping other columns', () => {
  const header = '| Customer | Context | Excluded | Terms | Status |\n| --- | --- | --- | --- | --- |';
  const cells = ['Acme', 'small '.repeat(70), 'other '.repeat(60), 'terms 🌻 '.repeat(1200), 'Active'];
  const repeatedTokens = [cells[0], cells[1], cells[4]].reduce(
    (sum, cell) => sum + encoding.encode(cell, [], []).length,
    0,
  );
  assert.ok(repeatedTokens <= 100);
  assert.ok(repeatedTokens + encoding.encode(cells[2], [], []).length > 100);
  const result = chunkMarkdown(`# Contracts\n\n${header}\n|${cells.join('|')}|\n`);
  const restored = ['', ''];
  assert.ok(result.chunks.length > 2);
  for (const chunk of result.chunks) {
    assert.ok(chunk.tokens <= 800);
    assert.equal(chunk.tokens, encoding.encode(chunk.text, [], []).length);
    const fragments = chunk.text.split(`${header}\n`)[1].split('|').slice(1, -1);
    assert.equal(fragments.length, cells.length);
    for (const index of [0, 1, 4]) assert.equal(fragments[index], cells[index]);
    assert.ok(fragments[2].length + fragments[3].length > 0);
    restored[0] += fragments[2];
    restored[1] += fragments[3];
  }
  assert.deepEqual(restored, [cells[2], cells[3]]);
});

test('table context leaves a minimum content margin under large section headings', () => {
  const title = '🌻'.repeat(230);
  const header = '| Customer | Terms |\n| --- | --- |';
  const cells = ['customer '.repeat(90), 'terms 🌻 '.repeat(80)];
  assert.ok(encoding.encode(cells[0], [], []).length <= 100);
  assert.ok(encoding.encode(`# ${title}\n\n${header}\n|${cells[0]}||`, [], []).length > 800 - 32);
  const result = chunkMarkdown(`# ${title}\n\n${header}\n|${cells.join('|')}|\n`);
  const restored = ['', ''];
  assert.ok(result.chunks.length > 2);
  for (const chunk of result.chunks) {
    assert.ok(chunk.tokens <= 800);
    const fragments = chunk.text.split(`${header}\n`)[1].split('|').slice(1, -1);
    assert.ok(fragments.some(fragment => fragment.length > 0));
    fragments.forEach((fragment, index) => {
      restored[index] += fragment;
    });
  }
  assert.deepEqual(restored, cells);
});

test('code fences do not create headings and special-token strings are literal text', async () => {
  const result = await parse('# Policy\n\n```md\n# Not a heading\n```\n\n<|endoftext|>');
  assert.equal(result.chunks[0].heading, 'Policy');
  assert.ok(result.chunks[0].text.includes('# Not a heading'));
  assert.ok(result.chunks[0].text.includes('<|endoftext|>'));
});

test('continuation overlap is at most 100 measured tokens and makes progress', async () => {
  const result = await parse('# Orchard\n\n' + Array.from({ length: 1800 }, (_, i) => `unique${i} apples`).join(' '));
  const prefix = '# Orchard\n\n';
  assert.ok(result.chunks.length > 3);
  for (let index = 1; index < result.chunks.length; index += 1) {
    const previous = result.chunks[index - 1].text.slice(prefix.length);
    const next = result.chunks[index].text.slice(prefix.length);
    let length = Math.min(previous.length, next.length);
    while (length && previous.slice(-length) !== next.slice(0, length)) length -= 1;
    assert.ok(length > 0, 'a prose continuation must carry overlap');
    assert.ok(encoding.encode(next.slice(0, length), [], []).length <= 100);
    assert.notEqual(next, previous);
  }
});

test('setext heading paths and Markdown hard breaks remain in the text', async () => {
  const result = await parse('Orchard\n=======\n\nHarvest\n-------\n\nFirst line  \nSecond line\n');
  assert.equal(result.chunks.at(-1).heading, 'Orchard > Harvest');
  assert.equal(result.chunks.at(-1).text, '# Orchard\n## Harvest\n\nFirst line  \nSecond line');
  const indented = await parse('    const apples = 12;\n');
  assert.equal(indented.markdown, '    const apples = 12;\n');
});

test('token quota applies to final chunks rather than estimates or truncated output', async () => {
  await assert.rejects(parse('apple '.repeat(250001)), failure('resource-limited'));
});

test('rejects empty, malformed UTF-8, binary text, unsupported and oversized inputs', async () => {
  await assert.rejects(parse(''), failure('malformed'));
  await assert.rejects(parse(Buffer.from([0xff])), failure('malformed'));
  await assert.rejects(parse('apple\0tree'), failure('malformed'));
  await assert.rejects(parse('arbitrary', 'file.bin', 'application/octet-stream'), failure('unsupported'));
  await assert.rejects(parse(Buffer.alloc(10 * 1024 * 1024 + 1)), failure('resource-limited'));
  await assert.rejects(parse('# ' + 'heading '.repeat(1000)), failure('resource-limited'));
});

test('rawTextFallback indexes unsupported or malformed text from its raw text', async () => {
  const parse = (bytes, filename, mediaType) =>
    parseKnowledgeDocument({ bytes: Buffer.from(bytes), filename, mediaType, rawTextFallback: true });
  const unsupported = await parse(
    'Harvest apples on Tuesday.\nStore pears in the cellar.',
    'notes.bin',
    'application/octet-stream',
  );
  assert.equal(unsupported.profile.fallback, 'unsupported');
  assert.match(unsupported.profile.id, /-fallback$/);
  assert.ok(unsupported.markdown.includes('Harvest apples on Tuesday.'));
  assert.ok(unsupported.chunks.length > 0);
  const mislabeled = await parse('Harvest apples on Tuesday.', 'notes.docx', 'application/octet-stream');
  assert.ok(['unsupported', 'malformed'].includes(mislabeled.profile.fallback), mislabeled.profile.fallback);
  assert.ok(mislabeled.markdown.includes('Harvest apples on Tuesday.'));
  await assert.rejects(parse('%PDF-1.7\nbroken', 'bad.pdf', 'application/pdf'), failure('malformed'));
  await assert.rejects(
    parse(
      Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('Harvest apples')]),
      'bad.docx',
      'application/octet-stream',
    ),
    error => error instanceof KnowledgeParseError,
  );
  await assert.rejects(
    parse(Buffer.from([0x00, 0x01, 0x02, 0x03]), 'file.bin', 'application/octet-stream'),
    failure('unsupported'),
  );
  await assert.rejects(parse('apple\0tree', 'notes.txt', 'text/plain'), failure('malformed'));
});

test('transient parser failures retry with exponential backoff and stop at the attempt limit', async () => {
  const input = { bytes: Buffer.from('Harvest apples.'), filename: 'policy.md', mediaType: 'text/markdown' };
  const delays = [];
  const sleep = async ms => void delays.push(ms);
  let calls = 0;
  const result = await retryTransientParse(
    async () => {
      calls++;
      if (calls < 3) throw new KnowledgeParseError('resource-limited', { reason: 'abnormal-exit' });
      return parseKnowledgeDocument(input);
    },
    { sleep },
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [500, 1000]);
  assert.ok(result.markdown.includes('Harvest apples.'));
  assert.equal(parserRetry.attempts, 3);

  calls = 0;
  delays.length = 0;
  await assert.rejects(
    retryTransientParse(
      async () => {
        calls++;
        throw new KnowledgeParseError('malformed', { reason: 'spawn' });
      },
      { sleep },
    ),
    error => error.reason === 'spawn',
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [500, 1000]);
  for (const error of [
    new KnowledgeParseError('resource-limited', { reason: 'timeout' }),
    new KnowledgeParseError('resource-limited', { reason: 'rss-limit' }),
    new KnowledgeParseError('unsupported'),
  ]) {
    calls = 0;
    await assert.rejects(
      retryTransientParse(
        async () => {
          calls++;
          throw error;
        },
        { sleep },
      ),
    );
    assert.equal(calls, 1, error.reason);
    assert.equal(transientParseFailure(error), false);
  }
  assert.equal(transientParseFailure(new KnowledgeParseError('malformed', { reason: 'invalid-output' })), true);
});

for (const [extension, create, expected] of [
  ['docx', docx, 'Harvest apples on Tuesday.'],
  ['xlsx', xlsx, 'Apple'],
  ['pptx', pptx, 'Orchard harvest briefing'],
  ['odt', odt, 'Harvest apples on Tuesday.'],
  ['rtf', () => Buffer.from('{\\rtf1\\ansi Orchard policy. Harvest apples on Tuesday.}'), 'Harvest apples on Tuesday.'],
  ['csv', () => Buffer.from('Fruit,Count\nApple,12\n'), 'Apple'],
]) {
  test(`genuine native ${extension} extraction`, async () => {
    const result = await parse(create(), `orchard.${extension}`, 'application/octet-stream');
    assert.ok(result.markdown.includes(expected), result.markdown);
    assert.equal(result.profile.engine, 'anydoc');
    assert.equal(result.profile.version, '0.2.4');
    assert.equal(result.pages, 0);
    const location = { xlsx: 'sheet', pptx: 'slide' }[extension] ?? 'passage';
    assert.ok(result.chunks.every(chunk => chunk.offset.kind === location));
    assert.deepEqual(result.gaps, []);
  });
}

test('native text PDF reports real page count and cites the page of each chunk', async () => {
  const result = await parse(await pdf(['text', 'text']), 'orchard.pdf', 'application/pdf');
  assert.equal(result.pages, 2);
  assert.ok(result.markdown.includes('Harvest apples on Tuesday.'));
  assert.deepEqual(
    result.chunks.map(chunk => chunk.offset),
    [
      { kind: 'page', page: 1 },
      { kind: 'page', page: 2 },
    ],
  );
  assert.deepEqual(result.gaps, []);
});

test('scanned PDFs need recognition while mixed PDFs keep native text and report image pages', async () => {
  await assert.rejects(parse(await pdf(['scan']), 'scan.pdf', 'application/pdf'), failure('ocr-required'));
  const mixed = await parse(await pdf(['text', 'scan']), 'mixed.pdf', 'application/pdf');
  assert.equal(mixed.pages, 2);
  assert.ok(mixed.markdown.includes('Harvest apples on Tuesday.'));
  assert.deepEqual(
    mixed.gaps.map(gap => [gap.kind, gap.reason, gap.location]),
    [['image', 'recognition-unavailable', { kind: 'page', page: 2 }]],
  );
  // A page that paints an image falls back to its native text when it can't be recognized.
  const page = await parse(await pdf(['mixed']), 'mixed-page.pdf', 'application/pdf');
  assert.ok(page.markdown.includes('Harvest apples on Tuesday.'));
  assert.deepEqual(
    page.gaps.map(gap => gap.location),
    [{ kind: 'page', page: 1 }],
  );
});

test('encrypted, malformed, and over-500-page PDFs are rejected', async () => {
  await assert.rejects(parse(encryptedPdf(), 'encrypted.pdf', 'application/pdf'), failure('encrypted'));
  await assert.rejects(parse('%PDF-1.7\nbroken', 'bad.pdf', 'application/pdf'), failure('malformed'));
  await assert.rejects(
    parse(await pdf(Array(501).fill('text')), 'long.pdf', 'application/pdf'),
    failure('resource-limited'),
  );
});

test('checks actual ZIP inflation, declared expansion, and malformed archives', async () => {
  await assert.rejects(
    parse(zip([['word/document.xml', 'x']], { declaredSize: 70 * 1024 * 1024 }), 'bomb.docx'),
    failure('resource-limited'),
  );
  await assert.rejects(
    parse(zip([['word/document.xml', 'x'.repeat(100000)]], { declaredSize: 1 }), 'lying.docx'),
    failure('resource-limited'),
  );
  await assert.rejects(parse(docx().subarray(0, 100), 'broken.docx'), failure('malformed'));
  const corrupt = docx();
  corrupt[14] ^= 1;
  await assert.rejects(parse(corrupt, 'corrupt.docx'), failure('malformed'));
});

for (const kind of ['pptx', 'xlsx']) {
  for (const defect of ['missing-part', 'missing-relationship', 'wrong-type', 'external', 'malformed-part']) {
    test(`${kind} ${defect} cannot publish a partial conversion`, async () => {
      await assert.rejects(parse(incompleteOffice(kind, defect), `budget.${kind}`), failure('malformed'));
    });
  }
}

for (const kind of ['header', 'footer', 'comments', 'footnotes', 'endnotes']) {
  for (const defect of ['missing-part', 'missing-relationship']) {
    test(`DOCX ${kind} ${defect} cannot publish body-only output`, async () => {
      await assert.rejects(parse(docxFeature(kind, defect), 'budget.docx'), failure('malformed'));
    });
  }
}

for (const [kind, expected] of [
  ['header', 'Harvest apples on Tuesday.\n\n## Header\n\nMaximum is 450\n'],
  ['footer', 'Harvest apples on Tuesday.\n\n## Footer\n\nMaximum is 450\n'],
  ['comments', 'Harvest apples on Tuesday.\n\nBudget reviewed\n\n> Comment (Reviewer): Maximum is 450\n'],
  ['checkbox', 'Harvest apples on Tuesday.\n\nApproved\n'],
  ['legacyCheckbox', 'Harvest apples on Tuesday.\n\n\u2612Approved\n'],
]) {
  test(`DOCX ${kind} is read rather than silently omitted`, async () => {
    assert.equal((await parse(docxFeature(kind), 'budget.docx')).markdown, expected);
  });
}

for (const kind of ['footnotes', 'endnotes']) {
  test(`DOCX ${kind} require the referenced note and retain complete notes`, async () => {
    await assert.rejects(parse(docxFeature(kind, 'missing-id'), 'budget.docx'), failure('malformed'));
    const result = await parse(docxFeature(kind), 'budget.docx');
    assert.equal(result.markdown, 'Harvest apples on Tuesday.\n\nBudget[^1]\n\n[^1]: Maximum is 450\n');
  });
}

test('prefixed PDF content wins over plaintext metadata with valid absolute offsets', async () => {
  for (const prefix of ['\n', '\n'.repeat(1019)]) {
    const scan = await prefixedPdf('scan', prefix);
    const source = new TextDecoder('utf-8', { fatal: true }).decode(scan);
    const offset = Number(/startxref\n(\d+)/.exec(source)[1]);
    assert.equal(scan.subarray(offset, offset + 4).toString(), 'xref');
    for (const match of source.matchAll(/^(\d{10}) 00000 n /gm))
      assert.match(scan.subarray(Number(match[1]), Number(match[1]) + 20).toString(), /^\d+ 0 obj\n/);
    await assert.rejects(parse(scan, 'scan.txt', 'text/plain'), failure('ocr-required'));
    const result = await parse(await prefixedPdf('text', prefix), 'policy.txt', 'text/plain');
    assert.equal(result.pages, 1);
    assert.equal(result.profile.engine, 'anydoc');
    assert.ok(result.markdown.includes('Harvest apples on Tuesday.'));
    assert.ok(!result.markdown.includes('startxref'));
  }
});

test('declared Office lists and structural slide or sheet bodies cannot disappear', async () => {
  for (const [create, main, part, list, empty] of [
    [
      xlsx,
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
      /<sheets>[^]*?<\/sheets>/,
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
    ],
    [
      pptx,
      'ppt/presentation.xml',
      'ppt/slides/slide1.xml',
      /<p:sldIdLst>[^]*?<\/p:sldIdLst>/,
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
    ],
  ]) {
    for (const missing of ['list', 'body']) {
      const entries = officeParts(create()).map(([path, text]) => [
        path,
        missing === 'list' && path === main
          ? text.replace(list, '')
          : missing === 'body' && path === part
            ? empty
            : text,
      ]);
      await assert.rejects(parse(zip(entries), 'document.txt', 'text/plain'), failure('malformed'));
    }
  }
});

test('native model drops DOCX header, footer, comment and checkbox facts that extraction restores', async () => {
  const { toDocument, toMarkdownBytes } = await import('@firecrawl/anydoc/index.js');
  for (const kind of ['header', 'footer', 'comments', 'legacyCheckbox']) {
    const bytes = docxFeature(kind);
    const native = JSON.stringify(await toDocument(bytes));
    assert.ok(native.includes('Harvest apples on Tuesday.'));
    assert.ok(!native.includes('Maximum is 450'));
    assert.ok(!native.includes('\u2612'));
    assert.ok((await toMarkdownBytes(bytes)).includes('Harvest apples on Tuesday.'));
    assert.match((await parse(bytes, 'facts.docx')).markdown, kind === 'legacyCheckbox' ? /\u2612/ : /Maximum is 450/);
  }
});

test('native successful conversions with missing declared parts never become parser results', async () => {
  const { toMarkdownBytes } = await import('@firecrawl/anydoc/index.js');
  for (const kind of ['pptx', 'xlsx']) {
    const bytes = incompleteOffice(kind);
    assert.ok((await toMarkdownBytes(bytes)).includes(kind === 'pptx' ? 'Orchard harvest briefing' : 'Apple'));
    await assert.rejects(parse(bytes, `budget.${kind}`), failure('malformed'));
  }
});

test('Office relationships resolve renamed main parts, namespace aliases and encoded targets', async () => {
  const entries = officeParts(xlsx()).map(([path, text]) => {
    const renamed = path
      .replace('xl/workbook.xml', 'custom/main.xml')
      .replace('xl/_rels/workbook.xml.rels', 'custom/_rels/main.xml.rels')
      .replace('xl/worksheets/sheet1.xml', 'data/budget.xml');
    return [
      renamed,
      text
        .replaceAll('xl/workbook.xml', 'custom/main.xml')
        .replaceAll('worksheets/sheet1.xml', '../data/budg%65t.xml')
        .replaceAll('xmlns:r=', 'xmlns:rel=')
        .replaceAll('r:id=', 'rel:id='),
    ];
  });
  const result = await parse(zip(entries), 'mislabelled.txt', 'text/plain');
  assert.equal(result.profile.engine, 'anydoc');
  assert.ok(result.markdown.includes('Apple'));
  const missing = entries.filter(([path]) => path !== 'data/budget.xml');
  await assert.rejects(parse(zip(missing), 'missing.xlsx'), failure('malformed'));
});

test('Office XML rejects duplicate IDs, spoofed relationship namespaces, entities and path escape', async () => {
  for (const mutate of [
    text => text.replace('Id="rId1"', 'Id="rId2"'),
    text => text.replace('http://schemas.openxmlformats.org/package/2006/relationships', 'urn:fake'),
    text =>
      text.replace(
        '</Relationships>',
        '<Relationship Id="rId1" Type="bad" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
    text => text.replace('worksheets/sheet1.xml', '../../outside.xml'),
    text => text.replace('worksheets/sheet1.xml', '&outside;'),
  ]) {
    const entries = officeParts(xlsx()).map(([path, text]) => [
      path,
      path === 'xl/_rels/workbook.xml.rels' ? mutate(text) : text,
    ]);
    await assert.rejects(parse(zip(entries), 'bad.xlsx'), failure('malformed'));
  }
});

test('plaintext labels cannot admit prefixed binary containers or out-of-window PDF headers', async () => {
  for (const bytes of [
    Buffer.concat([Buffer.from('\n'), docx()]),
    Buffer.from('\nPK\x03\x04spoof'),
    Buffer.concat([Buffer.from('\n'), Buffer.from('d0cf11e0a1b11ae1', 'hex')]),
    await prefixedPdf('scan', '\n'.repeat(1024)),
  ]) {
    await assert.rejects(parse(bytes, 'spoof.txt', 'text/plain'), failure('unsupported'));
  }
});
