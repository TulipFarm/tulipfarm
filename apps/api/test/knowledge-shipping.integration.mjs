import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  altChunkDocx,
  cellXlsx,
  mixedInlinePdf,
  symbolDocx,
} from '../../../packages/knowledge/test/fixtures/parser-completeness.mjs';
import { knowledgeFixture } from './knowledge-fixture.mjs';
import { semanticFidelityFixtures } from '../../../packages/knowledge/test/fixtures/semantic-fidelity.mjs';

test('HTTP search replenishes candidates past 100 higher-ranked revoked File documents', async () => {
  const f = await knowledgeFixture();
  try {
    const fileId = randomUUID(),
      fileDocuments = [];
    const reader = { cookie: f.signed.admin.cookie };
    assert.equal((await f.upload(fileId, Buffer.from('candidateboundprobe hidden file'))).status, 200);
    assert.equal((await f.share(fileId, 'viewer')).status, 200);
    for (let index = 0; index < 100; index++) {
      const documentId = randomUUID();
      const input = { ...f.command({ kind: 'file', fileId }), title: 'candidateboundprobe' };
      const saved = await f.save(documentId, input, reader);
      assert.equal(saved.status, 200, saved.bytes.toString());
      assert.equal(saved.json().parsing, 'queued');
      assert.deepEqual(await f.process(input.commandId), { disposition: 'ready' });
      fileDocuments.push(documentId);
    }
    const noteId = randomUUID();
    const note = {
      ...f.command({ kind: 'note', text: 'candidateboundprobe accessible note uniquereadableprobe' }),
      title: 'Readable note',
    };
    assert.equal((await f.save(noteId, note, reader)).status, 200);
    assert.deepEqual(await f.process(note.commandId), { disposition: 'ready' });

    const published = await f.db.platform.query(
      `SELECT count(*)::int AS count
      FROM ${f.table('tf_knowledge_publications')} WHERE document_id = ANY($1::uuid[])`,
      [fileDocuments],
    );
    assert.deepEqual(published.rows, [{ count: 100 }]);
    const before = await f.call('/search?query=candidateboundprobe', reader);
    assert.equal(before.status, 200);
    assert.equal(before.json().hits.length, 20);
    assert.equal(
      before.json().hits.every(hit => fileDocuments.includes(hit.citation.documentId)),
      true,
    );
    const fileCitation = before.json().hits[0].citation;

    assert.equal((await f.share(fileId, null)).status, 200);
    const concealed = await f.call(`/documents/${fileDocuments[0]}`, reader);
    assert.equal(concealed.status, 404);
    assert.deepEqual(concealed.json(), { error: 'knowledge-not-found' });
    assert.equal((await f.call('/evidence', { ...reader, method: 'POST', body: fileCitation })).status, 404);
    const control = await f.call('/search?query=uniquereadableprobe', reader);
    assert.equal(control.status, 200);
    assert.deepEqual(
      control.json().hits.map(hit => hit.citation.documentId),
      [noteId],
    );

    const result = await f.call('/search?query=candidateboundprobe', reader);
    assert.equal(result.status, 200);
    assert.deepEqual(
      result.json().hits.map(hit => hit.citation.documentId),
      [noteId],
    );
    assert.equal(result.json().hits[0].title, 'Readable note');
    const evidence = await f.call('/evidence', { ...reader, method: 'POST', body: result.json().hits[0].citation });
    assert.equal(evidence.status, 200);
    assert.equal(evidence.json().text, 'candidateboundprobe accessible note uniquereadableprobe');
    assert.deepEqual(evidence.json().original, { kind: 'note' });
  } finally {
    await f.close();
  }
});

const blockedFiles = [
  {
    name: 'mixed inline PDF',
    filename: 'mixed.pdf',
    mediaType: 'application/pdf',
    bytes: mixedInlinePdf(),
    parsing: 'ocr-unavailable',
    failure: 'ocr-required',
    query: 'explanatory',
  },
  {
    name: 'DOCX altChunk',
    filename: 'chunk.docx',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: altChunkDocx(),
    parsing: 'failed',
    failure: 'unsupported',
    query: 'orchard',
  },
  {
    name: 'DOCX Symbol-font minus',
    filename: 'symbol.docx',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: symbolDocx(),
    parsing: 'failed',
    failure: 'unsupported',
    query: 'balance',
  },
  {
    name: 'XLSX missing shared-string table',
    filename: 'missing.xlsx',
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: cellXlsx('<c r="B2" t="s"><v>0</v></c>'),
    parsing: 'failed',
    failure: 'malformed',
    query: 'apple',
  },
  {
    name: 'XLSX uncached formula',
    filename: 'formula.xlsx',
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: cellXlsx('<c r="B2"><f>450+50</f></c>'),
    parsing: 'failed',
    failure: 'unsupported',
    query: 'apple',
  },
  {
    name: 'RTF superscript',
    filename: 'area.rtf',
    mediaType: 'application/rtf',
    bytes: Buffer.from('{\\rtf1\\ansi Area 10{\\super 2} square metres}'),
    parsing: 'failed',
    failure: 'unsupported',
    query: 'area',
  },
];

for (const fixture of (await semanticFidelityFixtures()).filter(item =>
  [
    'pdf-annotation-Stamp',
    'docx-noBreakHyphen',
    'xlsx-strike-inline',
    'xlsx-strike-shared',
    'xlsx-escape-inline',
    'xlsx-escape-shared',
  ].includes(item.id),
)) {
  blockedFiles.push({
    name: fixture.id,
    filename: `${fixture.id}.${fixture.format}`,
    mediaType: 'application/octet-stream',
    bytes: Buffer.from(await fixture.build()),
    parsing: 'failed',
    failure: 'unsupported',
    query: '450',
  });
}

for (const file of blockedFiles) {
  test(`HTTP ${file.name} retains original bytes without publishing partial extraction`, async () => {
    const f = await knowledgeFixture();
    try {
      const fileId = randomUUID(),
        documentId = randomUUID();
      const input = { ...f.command({ kind: 'file', fileId }), title: 'Blocked shipping document' };
      const upload = await f.upload(fileId, file.bytes, file.filename, file.mediaType);
      assert.equal(upload.status, 200, upload.bytes.toString());
      const saved = await f.save(documentId, input);
      assert.equal(saved.status, 200, saved.bytes.toString());
      assert.equal(saved.json().parsing, 'queued');
      assert.equal(saved.json().publicationId, null);
      assert.deepEqual(await f.process(input.commandId), { disposition: 'failed' });

      const detail = await f.call(`/documents/${documentId}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.json().revisionId, input.commandId);
      assert.equal(detail.json().parsing, file.parsing);
      assert.equal(detail.json().failure, file.failure);
      assert.equal(detail.json().publicationId, null);
      assert.equal(detail.json().canRetry, false);
      const stored = await f.db.platform.query(
        `SELECT w.parsing, w.failure, w.attempts,
        d.lexical_publication_id, d.vector_publication_id,
        (SELECT count(*)::int FROM ${f.table('tf_knowledge_publications')} p WHERE p.revision_id = w.revision_id) AS publications,
        (SELECT count(*)::int FROM ${f.table('tf_knowledge_chunks')} c
          JOIN ${f.table('tf_knowledge_publications')} p ON p.id = c.publication_id WHERE p.revision_id = w.revision_id) AS chunks
        FROM ${f.table('tf_knowledge_work')} w
        JOIN ${f.table('tf_knowledge_documents')} d ON d.observed_revision_id = w.revision_id
        WHERE w.revision_id = $1 AND d.id = $2`,
        [input.commandId, documentId],
      );
      assert.deepEqual(stored.rows, [
        {
          parsing: file.parsing,
          failure: file.failure,
          attempts: 1,
          lexical_publication_id: null,
          vector_publication_id: null,
          publications: 0,
          chunks: 0,
        },
      ]);

      for (const query of [file.query, 'shipping']) {
        const search = await f.call(`/search?${new URLSearchParams({ query })}`);
        assert.equal(search.status, 200);
        assert.deepEqual(search.json().hits, []);
      }
      const original = await f.call(`/documents/${documentId}/original?revisionId=${input.commandId}`);
      assert.equal(original.status, 200);
      assert.deepEqual(original.bytes, file.bytes);
      const retainedFile = await f.call(`/v1/workspaces/${f.workspace.id}/files/${fileId}/content`);
      assert.equal(retainedFile.status, 200);
      assert.deepEqual(retainedFile.bytes, file.bytes);
    } finally {
      await f.close();
    }
  });
}
