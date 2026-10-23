import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractKnowledgeDocument } from '../dist/parser/process.js';
import {
  commentsDocx,
  fieldsDocx,
  formattingDocx,
  headerFooterDocx,
  headerImageDocx,
  hiddenXlsx,
  revisionsDocx,
} from './fixtures/parser-office-revisions.mjs';

const extract = (bytes, extension) =>
  extractKnowledgeDocument({ bytes, filename: `facts.${extension}`, mediaType: 'application/octet-stream' });
const markdown = async (bytes, extension = 'docx') => {
  const { segments } = await extract(bytes, extension);
  assert.equal(segments.length, 1);
  return segments[0].markdown;
};

test('Word headers and footers are read once, after the body, without page numbers', async () => {
  assert.equal(
    await markdown(headerFooterDocx()),
    'Chapter one\n\nChapter two\n\n## Header\n\nOrchard Co confidential\n\n## Footer\n\nApproved by finance\n',
  );
});

test('a picture in a Word header becomes a media item in the header section', async () => {
  const extraction = await extract(headerImageDocx(), 'docx');
  const [item] = extraction.media;
  assert.deepEqual(item.ref, { kind: 'part', path: 'word/media/logo.png' });
  assert.equal(item.alt, 'Company logo');
  const text = extraction.segments[0].markdown;
  assert.ok(text.indexOf('## Header') < text.indexOf('\uE000'), text);
});

test('Word comments are quoted after the paragraph they annotate', async () => {
  assert.equal(
    await markdown(commentsDocx()),
    'Budget 450\n\n> Comment (Ana \\*Ruiz\\*): Check the total\n\nNext steps\n\n|  |\n| --- |\n| Apples |\n\n' +
      '> Comment: Count again\n\n> Comment (Bo): Unanchored note\n',
  );
});

test('Word tracked changes read as the current text', async () => {
  const text = await markdown(revisionsDocx());
  assert.equal(text, 'Limit 450\n\nStays moved here\n\n|  |\n| --- |\n| Kept row |\n');
  assert.ok(!text.includes('300') && !text.includes('Moved away') && !text.includes('Removed row'));
});

test('Word fields read as their cached results, never their instructions', async () => {
  const text = await markdown(fieldsDocx());
  assert.equal(text, 'Intro 3\n\nRevised 2024\n\nTotal 450\n\nOuter result\n\n\u2610 Not approved\n');
  for (const instruction of ['TOC', 'SAVEDATE', 'SUM', 'SECRETINSTR', 'FORMCHECKBOX'])
    assert.ok(!text.includes(instruction));
});

test('Word underline and merged cells read as plain text, raised text keeps a mark; hidden text is skipped with one gap', async () => {
  const expected =
    'Area 10^2 of H_2O\n\nVisible end\n\n|  |  |\n| --- | --- |\n| Wide |  |\n| Tall | One |\n|  | Two |\n';
  const hidden = await extract(formattingDocx(), 'docx');
  assert.equal(hidden.segments[0].markdown, expected);
  assert.deepEqual(hidden.gaps, [
    { kind: 'other', reason: 'unsupported-media', location: { kind: 'passage' }, label: 'Hidden text' },
  ]);
  const visible = await extract(formattingDocx(false), 'docx');
  assert.equal(visible.segments[0].markdown, expected);
  assert.deepEqual(visible.gaps, []);
});

test('Excel hidden rows, columns and sheets are skipped and recorded as gaps', async () => {
  const extraction = await extract(hiddenXlsx(), 'xlsx');
  assert.deepEqual(
    extraction.segments.map(segment => segment.location),
    [{ kind: 'sheet', sheet: 1, name: 'Inventory' }],
  );
  const text = extraction.segments[0].markdown;
  for (const secret of ['Side', 'Pear secret', 'Archived secret']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(extraction.gaps, [
    {
      kind: 'other',
      reason: 'unsupported-media',
      location: { kind: 'sheet', sheet: 1, name: 'Inventory' },
      label: 'Hidden rows or columns',
    },
    {
      kind: 'other',
      reason: 'unsupported-media',
      location: { kind: 'sheet', sheet: 2, name: 'Archive' },
      label: 'Hidden sheet',
    },
  ]);
});

test('Excel very hidden sheets gap like hidden ones and the 1904 date system is accepted', async () => {
  const extraction = await extract(hiddenXlsx({ sheet: 'veryHidden', rows: false, date1904: true }), 'xlsx');
  assert.match(extraction.segments[0].markdown, /\| Apple \| 450 \| Side \|/);
  assert.deepEqual(
    extraction.gaps.map(gap => [gap.location, gap.label]),
    [[{ kind: 'sheet', sheet: 2, name: 'Archive' }, 'Hidden sheet']],
  );
  const plain = await extract(hiddenXlsx({ sheet: '', rows: false }), 'xlsx');
  assert.deepEqual(plain.gaps, []);
});
