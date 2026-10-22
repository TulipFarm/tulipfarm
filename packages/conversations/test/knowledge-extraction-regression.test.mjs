import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as source from '../src/knowledge-extraction.ts';
import * as compiled from '../dist/knowledge-extraction.js';
import {
  docx,
  note,
  paragraph,
  pdf,
  relationship,
  relationships,
  textStream,
} from './knowledge-extraction-fixtures.mjs';

for (const [name, api] of [
  ['source', source],
  ['compiled', compiled],
]) {
  const unreadable = error =>
    error instanceof api.KnowledgeExtractionError &&
    error.code === 'unreadable-file' &&
    error.message === 'unreadable-file';

  test(`${name}: Projects retain exact UTF-8 source text and the one MiB byte limit`, async () => {
    const text = '\uFEFFCafé e\u0301 中文 العربية 🌿\r\n  A\tB <450> & done\r\n';
    assert.equal(await api.extractKnowledge('source.ts', Buffer.from(text)), text.slice(1));
    const limit = 'é'.repeat(524288);
    assert.equal(await api.extractKnowledge('limit.txt', Buffer.from(limit)), limit);
    await assert.rejects(api.extractKnowledge('large.txt', Buffer.from(`${limit}a`)), unreadable);
    assert.equal(api.readableKnowledgeText(limit), limit);
    assert.throws(() => api.readableKnowledgeText(`${limit}a`), unreadable);
  });

  test(`${name}: Projects keep their narrower extension allowlist`, async () => {
    for (const filename of ['sheet.xlsx', 'slides.pptx', 'data.csv', 'legacy.doc', 'letter.rtf']) {
      await assert.rejects(
        api.extractKnowledge(filename, Buffer.from('Budget 450')),
        error => error instanceof api.KnowledgeExtractionError && error.code === 'unsupported-file',
      );
    }
    assert.equal(await api.extractKnowledge('notes.MARKDOWN', Buffer.from('Budget 450')), 'Budget 450');
  });

  test(`${name}: DOCX keeps table cells and hyperlink destinations in Markdown`, async () => {
    const bytes = docx(
      `<w:tbl><w:tr><w:tc>${paragraph('Account')}</w:tc><w:tc>${paragraph('450')}</w:tc></w:tr></w:tbl><w:p><w:hyperlink r:id="hyperlink"><w:r><w:t>Policy</w:t></w:r></w:hyperlink></w:p>`,
      [relationships([relationship('hyperlink', 'https://example.com/policy', 'TargetMode="External"')])],
    );
    const text = await api.extractKnowledge('a.docx', bytes);
    assert.match(text, /\| Account\s*\| 450\s*\|/);
    assert.ok(text.includes('[Policy](https://example.com/policy)'));
  });

  test(`${name}: DOCX preserves manual break boundaries and Unicode facts`, async () => {
    const bytes = docx(
      '<w:p><w:r><w:t>Account</w:t><w:br/><w:t>450</w:t><w:br w:type="page"/><w:t>Friday</w:t><w:br w:type="column"/><w:t>Done</w:t></w:r></w:p>',
    );
    assert.equal(await api.extractKnowledge('a.docx', bytes), 'Account\\\n450\\\nFriday\\\nDone\n');
    assert.equal(
      await api.extractKnowledge('a.docx', docx(paragraph('Café e\u0301 中文 العربية 🌿 &lt;450&gt; &amp; done'))),
      'Café é 中文 العربية 🌿 <450> & done\n',
    );
  });

  test(`${name}: DOCX preserves referenced footnote and endnote facts`, async () => {
    const bytes = docx(
      '<w:p><w:r><w:t>Budget</w:t><w:footnoteReference w:id="1"/><w:endnoteReference w:id="1"/></w:r></w:p>',
      [
        relationships([relationship('footnotes', 'footnotes.xml'), relationship('endnotes', 'endnotes.xml')]),
        note('footnote'),
        note('endnote'),
      ],
    );
    assert.equal(
      await api.extractKnowledge('a.docx', bytes),
      'Budget[^1][^2]\n\n[^1]: Maximum is 450\n\n[^2]: Due Friday\n',
    );
  });

  test(`${name}: native PDF text stays in page order without synthetic citations`, async () => {
    const text = await api.extractKnowledge(
      'a.pdf',
      pdf([textStream('First budget 450'), textStream('Second due Friday')]),
    );
    assert.equal(text, '## First budget 450\n\n## Second due Friday\n');
    const pages = Array.from({ length: 200 }, (_, index) => `Budget ${450 + index} due Friday`);
    const complete = await api.extractKnowledge('a.pdf', pdf(pages.map(textStream)));
    assert.deepEqual(
      complete.trim().split('\n\n'),
      pages.map(text => `## ${text}`),
    );
    await assert.rejects(api.extractKnowledge('a.pdf', pdf(Array(201).fill(textStream('Budget 450')))), unreadable);
    await assert.rejects(api.extractKnowledge('a.pdf', Buffer.alloc(10 * 1024 * 1024 + 1)), unreadable);
  });

  test(`${name}: image-only PDFs fail rather than saving an empty revision`, async () => {
    for (const image of ['inline', 'xobject', 'mask']) {
      await assert.rejects(api.extractKnowledge('scan.pdf', pdf([''], image)), unreadable);
    }
    assert.equal(
      await api.extractKnowledge('a.pdf', pdf([textStream('Recovered budget 450')])),
      '## Recovered budget 450\n',
    );
  });

  test(`${name}: invalid native documents and detached bytes use the Projects error and recover`, async () => {
    const detached = new Uint8Array(1);
    structuredClone(detached, { transfer: [detached.buffer] });
    for (const bytes of [detached, Buffer.from('%PDF-invalid'), Buffer.alloc(0)]) {
      await assert.rejects(api.extractKnowledge('a.pdf', bytes), unreadable);
    }
    await assert.rejects(api.extractKnowledge('a.docx', Buffer.from('invalid zip')), unreadable);
    assert.equal(
      (await api.extractKnowledge('a.docx', docx(paragraph('Recovered budget 450')))).trim(),
      'Recovered budget 450',
    );
  });
}
