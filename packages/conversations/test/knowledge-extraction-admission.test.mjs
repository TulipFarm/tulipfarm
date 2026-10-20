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
  const unreadable = error => error instanceof api.KnowledgeExtractionError && error.code === 'unreadable-file';

  test(`${mode}: mixed inline raster PDF cannot publish its native heading alone`, async () => {
    await assert.rejects(api.extractKnowledge('mixed.pdf', mixedInlinePdf()), unreadable);
    for (const kind of ['inline', 'xobject', 'mask']) {
      await assert.rejects(api.extractKnowledge('mixed.pdf', await paintedPdf(kind, 'form')), unreadable);
    }
    assert.equal(await api.extractKnowledge('text.pdf', pdfLexicalControl()), 'Budget BI ID EI Do 450 450\n');
  });

  test(`${mode}: embedded HTML and Symbol-font minus cannot become partial DOCX knowledge`, async () => {
    await assert.rejects(api.extractKnowledge('chunk.docx', altChunkDocx()), unreadable);
    await assert.rejects(api.extractKnowledge('symbol.docx', symbolDocx()), unreadable);
    assert.equal(
      await api.extractKnowledge('minus.docx', symbolDocx(false)),
      'Orchard policy\n\nBalance -450\n\n| Fruit | Count |\n| --- | --- |\n| Apple | 12 |\n',
    );
  });

  test(`${mode}: DOCX rejects semantic loss and preserves struck out amounts`, async () => {
    const fixtures = new Map(strictAdmissionFixtures());
    for (const name of [
      'superscript exponent',
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
      await assert.rejects(api.extractKnowledge('facts.docx', await fixtures.get(name)), unreadable, name);
    }
    for (const alignment of ['subscript', 'baseline']) {
      const bytes = await rewriteDocx(await fixtures.get('superscript exponent'), [
        ['word/document.xml', xml => xml.replace('superscript', alignment)],
      ]);
      await assert.rejects(api.extractKnowledge('facts.docx', bytes), unreadable, alignment);
    }
    assert.equal(
      await api.extractKnowledge('facts.docx', await fixtures.get('struck out amount')),
      'Limit ~~450~~ 500\n',
    );
  });

  test(`${mode}: special Word hyphens and revision wrappers cannot publish flattened facts`, async () => {
    for (const construct of ['<w:noBreakHyphen/>', '<w:softHyphen/>', '<w:rPr><w:vanish/></w:rPr>']) {
      await assert.rejects(
        api.extractKnowledge('facts.docx', docx(`<w:p><w:r>${construct}<w:t>Balance 450</w:t></w:r></w:p>`)),
        unreadable,
      );
    }
    for (const revision of ['ins', 'del', 'moveFrom', 'moveTo']) {
      await assert.rejects(
        api.extractKnowledge(
          'facts.docx',
          docx(`<w:p><w:${revision} w:id="1" w:author="Reviewer"><w:r><w:t>450</w:t></w:r></w:${revision}></w:p>`),
        ),
        unreadable,
      );
    }
    assert.equal(await api.extractKnowledge('facts.docx', docx(paragraph('Balance -450'))), 'Balance -450\n');
  });

  for (const compression of ['STORE', 'DEFLATE']) {
    test(`${mode}: ${compression} DOCX preserves paragraphs, Unicode and Markdown emphasis`, async () => {
      const bytes = await rewriteDocx(
        docx(paragraph('Café 中文 Budget 450') + paragraph('Due Friday')),
        [],
        compression,
      );
      assert.equal((await api.extractKnowledge('admission.docx', bytes)).trim(), 'Café 中文 Budget 450\n\nDue Friday');
      const bold = await rewriteDocx(
        docx('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Budget 450</w:t></w:r></w:p>'),
        [],
        compression,
      );
      assert.equal((await api.extractKnowledge('admission.docx', bold)).trim(), '**Budget 450**');
    });

    test(`${mode}: ${compression} truncated DOCX cannot produce partial success`, async () => {
      const bytes = await rewriteDocx(docx(paragraph('Budget 450')), [], compression);
      await assert.rejects(api.extractKnowledge('admission.docx', bytes.subarray(0, bytes.length - 30)), unreadable);
      assert.equal((await api.extractKnowledge('admission.docx', bytes)).trim(), 'Budget 450');
    });

    test(`${mode}: ${compression} DOCX retains original list numbering and textbox facts`, async () => {
      assert.equal(
        await api.extractKnowledge('admission.docx', await rewriteDocx(numberedList(), [], compression)),
        '450. Pay supplier\n451. Send receipt\n',
      );
      assert.equal(
        await api.extractKnowledge('admission.docx', await rewriteDocx(drawingTextBox(), [], compression)),
        'Budget\n\nMaximum is 450\n',
      );
    });
  }

  test(`${mode}: PDF rejects unqualified form fields instead of claiming complete extraction`, async () => {
    await assert.rejects(api.extractKnowledge('admission.pdf', formPdf()), unreadable);
  });

  test(`${mode}: DOCX rejects corrupted ZIP payload with unchanged CRC`, async () => {
    const bytes = docx(paragraph('Budget 450'));
    bytes[bytes.indexOf('Budget 450') + 7] = '5'.charCodeAt(0);
    await assert.rejects(api.extractKnowledge('admission.docx', bytes), unreadable);
    assert.equal((await api.extractKnowledge('admission.docx', docx(paragraph('Budget 450')))).trim(), 'Budget 450');
  });
}
