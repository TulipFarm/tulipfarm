import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as source from '../src/knowledge-extraction.ts';
import * as compiled from '../dist/knowledge-extraction.js';
import { docx, paragraph } from './knowledge-extraction-fixtures.mjs';
import {
  drawingTextBox,
  formPdf,
  numberedList,
  rewriteDocx,
  strictAdmissionFixtures,
} from './knowledge-extraction-admission-fixtures.mjs';
import {
  altChunkDocx,
  mixedInlinePdf,
  paintedPdf,
  pdfLexicalControl,
  symbolDocx,
} from '../../knowledge/test/fixtures/parser-completeness.mjs';

for (const [mode, api] of [
  ['source', source],
  ['compiled', compiled],
]) {
  /** Text of a file that was read completely. */
  const extract = async (filename, bytes) => {
    const result = await api.extractKnowledge(filename, bytes);
    assert.equal(result.gaps, null, filename);
    return result.content;
  };
  const unreadable = error => error instanceof api.KnowledgeExtractionError && error.code === 'unreadable-file';

  test(`${mode}: mixed inline raster PDF keeps its native text and records the unread page image`, async () => {
    const pageImage = {
      content: 'Native heading and explanatory budget policy text\n',
      gaps: {
        count: 1,
        items: [
          {
            kind: 'image',
            reason: 'recognition-unavailable',
            label: 'Page image',
            location: { kind: 'page', page: 1 },
          },
        ],
      },
    };
    assert.deepEqual(await api.extractKnowledge('mixed.pdf', mixedInlinePdf()), pageImage);
    for (const kind of ['inline', 'xobject', 'mask']) {
      assert.deepEqual(await api.extractKnowledge('mixed.pdf', await paintedPdf(kind, 'form')), pageImage, kind);
    }
    assert.equal(await extract('text.pdf', pdfLexicalControl()), 'Budget BI ID EI Do 450 450\n');
  });

  test(`${mode}: embedded HTML is recorded as unread DOCX content while Symbol-font minus reads as minus`, async () => {
    assert.deepEqual(await api.extractKnowledge('chunk.docx', altChunkDocx()), {
      content: 'Orchard policy\n\nHarvest apples on Tuesday.\n\n| Fruit | Count |\n| --- | --- |\n| Apple | 12 |\n',
      gaps: { count: 1, items: [{ kind: 'object', reason: 'unsupported-media', label: 'Embedded document' }] },
    });
    assert.equal(
      await extract('symbol.docx', symbolDocx()),
      'Orchard policy\n\nBalance −450\n\n| Fruit | Count |\n| --- | --- |\n| Apple | 12 |\n',
    );
    assert.equal(
      await extract('minus.docx', symbolDocx(false)),
      'Orchard policy\n\nBalance -450\n\n| Fruit | Count |\n| --- | --- |\n| Apple | 12 |\n',
    );
  });

  test(`${mode}: DOCX rejects semantic loss and preserves struck out amounts`, async () => {
    const fixtures = new Map(strictAdmissionFixtures());
    for (const name of [
      'unknown WordML element with a fact',
      'text in paragraph properties',
      'text in section properties',
      'text in run properties',
      'spoofed WordML text namespace',
      'unqualified lookalike text element',
      'unknown WordML attribute',
      'unknown unqualified attribute',
      'unknown attribute in known namespace',
      'unreferenced unknown package part',
      'unknown package content type',
      'unknown document relationship type',
      'unknown root package relationship type',
      'orphan footnote body',
      'orphan endnote body',
    ]) {
      await assert.rejects(extract('facts.docx', await fixtures.get(name)), unreadable, name);
    }
    for (const [alignment, text] of [
      ['superscript', 'Area 10^2 square metres\n'],
      ['subscript', 'Area 10_2 square metres\n'],
      ['baseline', 'Area 102 square metres\n'],
    ]) {
      const bytes = await rewriteDocx(await fixtures.get('superscript exponent'), [
        ['word/document.xml', xml => xml.replace('superscript', alignment)],
      ]);
      assert.equal(await extract('facts.docx', bytes), text, alignment);
    }
    assert.equal(await extract('facts.docx', await fixtures.get('struck out amount')), 'Limit ~~450~~ 500\n');
  });

  test(`${mode}: special Word hyphens read while hidden text rejects and tracked changes read as current text`, async () => {
    const run = construct =>
      docx(`<w:p><w:r><w:t xml:space="preserve">Balance </w:t>${construct}<w:t>450</w:t></w:r></w:p>`);
    assert.equal(await extract('facts.docx', run('<w:noBreakHyphen/>')), 'Balance -450\n');
    assert.equal(await extract('facts.docx', run('<w:softHyphen/>')), 'Balance 450\n');
    await assert.rejects(
      extract('facts.docx', docx('<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>Balance 450</w:t></w:r></w:p>')),
      unreadable,
    );
    const revised = revision =>
      docx(
        `<w:p><w:r><w:t xml:space="preserve">Balance </w:t></w:r><w:${revision} w:id="1" w:author="Reviewer"><w:r><w:t>450</w:t></w:r></w:${revision}></w:p>`,
      );
    for (const [revision, text] of [
      ['ins', 'Balance 450\n'],
      ['moveTo', 'Balance 450\n'],
      ['del', 'Balance\n'],
      ['moveFrom', 'Balance\n'],
    ]) {
      assert.equal(await extract('facts.docx', revised(revision)), text, revision);
    }
    assert.equal(await extract('facts.docx', docx(paragraph('Balance -450'))), 'Balance -450\n');
  });

  for (const compression of ['STORE', 'DEFLATE']) {
    test(`${mode}: ${compression} DOCX preserves paragraphs, Unicode and Markdown emphasis`, async () => {
      const bytes = await rewriteDocx(
        docx(paragraph('Café 中文 Budget 450') + paragraph('Due Friday')),
        [],
        compression,
      );
      assert.equal((await extract('admission.docx', bytes)).trim(), 'Café 中文 Budget 450\n\nDue Friday');
      const bold = await rewriteDocx(
        docx('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Budget 450</w:t></w:r></w:p>'),
        [],
        compression,
      );
      assert.equal((await extract('admission.docx', bold)).trim(), '**Budget 450**');
    });

    test(`${mode}: ${compression} truncated DOCX cannot produce partial success`, async () => {
      const bytes = await rewriteDocx(docx(paragraph('Budget 450')), [], compression);
      await assert.rejects(extract('admission.docx', bytes.subarray(0, bytes.length - 30)), unreadable);
      assert.equal((await extract('admission.docx', bytes)).trim(), 'Budget 450');
    });

    test(`${mode}: ${compression} DOCX retains original list numbering and textbox facts`, async () => {
      assert.equal(
        await extract('admission.docx', await rewriteDocx(numberedList(), [], compression)),
        '450. Pay supplier\n451. Send receipt\n',
      );
      assert.equal(
        await extract('admission.docx', await rewriteDocx(drawingTextBox(), [], compression)),
        'Budget\n\nMaximum is 450\n',
      );
    });
  }

  test(`${mode}: PDF rejects unqualified form fields instead of claiming complete extraction`, async () => {
    await assert.rejects(extract('admission.pdf', formPdf()), unreadable);
  });

  test(`${mode}: DOCX rejects corrupted ZIP payload with unchanged CRC`, async () => {
    const bytes = docx(paragraph('Budget 450'));
    bytes[bytes.indexOf('Budget 450') + 7] = '5'.charCodeAt(0);
    await assert.rejects(extract('admission.docx', bytes), unreadable);
    assert.equal((await extract('admission.docx', docx(paragraph('Budget 450')))).trim(), 'Budget 450');
  });
}
