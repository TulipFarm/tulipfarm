import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerKnowledgeComposition } from '../dist/knowledge-composition.js';
import { docx, pdf } from '../../../packages/knowledge/test/fixtures/parser-documents.mjs';
import { knowledgeFixture } from './knowledge-fixture.mjs';

test('file Knowledge stays listed in Trash, restores its index, and retires before a failed permanent deletion', async () => {
  const f = await knowledgeFixture();
  try {
    const fileId = randomUUID(),
      documentId = randomUUID(),
      noteId = randomUUID();
    const base = `/v1/workspaces/${f.workspace.id}/files/${fileId}`;
    assert.equal((await f.upload(fileId, 'Orchard harvest starts Tuesday.')).status, 200);
    const input = f.command({ kind: 'file', fileId });
    assert.equal((await f.save(documentId, input)).status, 200);
    await f.process(input.commandId);
    const note = f.command({ kind: 'note', text: 'Unrelated note.' });
    assert.equal((await f.save(noteId, note)).status, 200);
    const search = async () => (await f.call('/search?query=orchard')).json().hits;
    const hit = (await search())[0];
    const citation = `/citations/${hit.citation.publicationId}:0`;
    assert.equal((await f.call(citation)).status, 200);
    const listIds = async () =>
      (await f.call('/documents'))
        .json()
        .items.map(item => item.documentId)
        .sort();

    assert.equal((await f.call(`${base}/trash`, { method: 'PUT', body: { trashed: true } })).status, 200);
    assert.deepEqual(await listIds(), [documentId, noteId].sort(), 'Trash keeps the entry visible');
    assert.equal((await f.call(`/documents/${documentId}`)).status, 200, 'polling keeps the entry visible');
    assert.equal((await f.call(`/documents/${documentId}/original?revisionId=${input.commandId}`)).status, 404);
    assert.deepEqual(await search(), [], 'Trash content is not searched or cited');
    assert.equal((await f.call(citation)).status, 404);
    assert.equal((await f.call(`${base}/content`)).status, 404);
    assert.equal((await f.call(`${base}/trash`, { method: 'PUT', body: { trashed: false } })).status, 200);
    assert.equal((await search())[0].citation.publicationId, hit.citation.publicationId);
    assert.equal((await f.call(citation)).status, 200, 'restore reuses the publication without parsing');

    assert.equal((await f.call(`${base}/trash`, { method: 'PUT', body: { trashed: true } })).status, 200);
    const preview = await f.call(`${base}/deletion`);
    assert.equal(preview.status, 200, preview.bytes.toString());
    assert.equal(preview.json().knowledgeEntries, 1);
    let beforeRemove;
    f.object.faults.beforeRemove = async () => {
      beforeRemove = (
        await f.db.platform.query(
          `SELECT d.tombstoned_at,d.lexical_publication_id,d.vector_publication_id,f.deleting_at
        FROM ${f.table('tf_knowledge_documents')} d CROSS JOIN ${f.table('tf_files')} f
        WHERE d.id=$1 AND f.id=$2`,
          [documentId, fileId],
        )
      ).rows[0];
    };
    f.object.faults.remove = true;
    assert.equal((await f.call(`${base}/delete-forever`, { method: 'POST' })).json().state, 'failed');
    assert.ok(beforeRemove.deleting_at && beforeRemove.tombstoned_at, 'both lifecycles commit before byte removal');
    assert.equal(beforeRemove.lexical_publication_id, null);
    assert.equal(beforeRemove.vector_publication_id, null);
    const retired = (
      await f.db.platform.query(
        `SELECT tombstoned_at,lexical_publication_id,vector_publication_id FROM ${f.table('tf_knowledge_documents')} WHERE id=$1`,
        [documentId],
      )
    ).rows[0];
    assert.ok(retired.tombstoned_at, 'the entry is retired even when byte deletion fails');
    assert.equal(retired.lexical_publication_id, null);
    assert.equal(retired.vector_publication_id, null);
    assert.deepEqual(await listIds(), [noteId]);
    assert.deepEqual(await search(), []);
    assert.equal((await f.call(citation)).status, 404, 'old citations return removed, not a server error');
    assert.equal((await f.call(`${base}/trash`, { method: 'PUT', body: { trashed: false } })).status, 404);
    assert.deepEqual(
      await f.service.process({
        workspaceId: f.workspace.id,
        revisionId: input.commandId,
        generation: 1,
      }),
      { disposition: 'stale' },
    );
    f.object.faults.remove = false;
    assert.equal((await f.call(`${base}/delete-forever`, { method: 'POST' })).json().state, 'deleted');
    assert.deepEqual(await listIds(), [noteId], 'retry cannot revive the entry');
    assert.equal((await f.call(citation)).status, 404);
  } finally {
    await f.close();
  }
});

test('folder permanent deletion removes every person’s file Knowledge but not independent entries', async () => {
  const f = await knowledgeFixture();
  try {
    const folderId = randomUUID(),
      fileId = randomUUID(),
      nestedId = randomUUID(),
      pendingId = randomUUID(),
      otherId = randomUUID();
    const base = `/v1/workspaces/${f.workspace.id}/files`;
    assert.equal(
      (
        await f.call(`${base}/${folderId}/folder`, {
          method: 'PUT',
          body: { name: 'Harvest', parentId: null },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.call(
          `${base}/${fileId}/content?${new URLSearchParams({
            name: 'Orchard.txt',
            mediaType: 'text/plain',
            parentId: folderId,
          })}`,
          { method: 'PUT', body: Buffer.from('Orchard harvest starts Tuesday.') },
        )
      ).status,
      200,
    );
    assert.equal((await f.upload(otherId, 'Other orchard information.')).status, 200);
    assert.equal(
      (
        await f.call(`${base}/${nestedId}/folder`, {
          method: 'PUT',
          body: { name: 'Pending', parentId: folderId },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.call(
          `${base}/${pendingId}/content?${new URLSearchParams({
            name: 'Pending.txt',
            mediaType: 'text/plain',
            parentId: nestedId,
          })}`,
          { method: 'PUT', body: Buffer.from('Pending orchard instructions.') },
        )
      ).status,
      200,
    );
    assert.equal((await f.share(fileId, 'viewer')).status, 200);
    const added = [];
    for (const [sourceId, cookie] of [
      [fileId, f.signed.owner.cookie],
      [fileId, f.signed.admin.cookie],
      [pendingId, f.signed.owner.cookie],
      [otherId, f.signed.owner.cookie],
    ]) {
      const id = randomUUID(),
        input = f.command({ kind: 'file', fileId: sourceId });
      assert.equal((await f.save(id, input, { cookie })).status, 200);
      if (sourceId !== pendingId) await f.process(input.commandId);
      added.push(id);
    }
    assert.equal(
      (
        await f.call(`${base}/${folderId}/trash`, {
          method: 'PUT',
          body: { trashed: true },
        })
      ).status,
      200,
    );
    for (const cookie of [f.signed.owner.cookie, f.signed.admin.cookie])
      assert.ok(
        (await f.call('/documents', { cookie })).json().items.some(item => added.includes(item.documentId)),
        'entries under a trashed folder remain listed',
      );
    assert.equal((await f.call(`${base}/${folderId}/deletion`)).json().knowledgeEntries, 3);
    assert.equal((await f.call(`${base}/${folderId}/delete-forever`, { method: 'POST' })).json().state, 'deleted');
    assert.deepEqual(
      (await f.call('/documents')).json().items.map(item => item.documentId),
      [added[3]],
    );
    assert.deepEqual((await f.call('/documents', { cookie: f.signed.admin.cookie })).json().items, []);
    assert.deepEqual(
      (await f.call('/search?query=orchard')).json().hits.map(hit => hit.citation.documentId),
      [added[3]],
    );
    const retired = (
      await f.db.platform.query(
        `SELECT id FROM ${f.table('tf_knowledge_documents')} WHERE tombstoned_at IS NOT NULL ORDER BY id`,
      )
    ).rows.map(row => row.id);
    assert.deepEqual(retired, added.slice(0, 3).sort());
  } finally {
    await f.close();
  }
});

test('authenticated HTTP notes save, parse, search, cite, edit and remove without an object store', async () => {
  const f = await knowledgeFixture({ filesEnabled: false });
  try {
    const id = randomUUID(),
      input = f.command();
    const first = await f.save(id, input);
    assert.equal(first.status, 200, first.bytes.toString());
    assert.deepEqual(first.json(), {
      documentId: id,
      revisionId: input.commandId,
      title: 'Returns handbook',
      kind: 'note',
      parsing: 'queued',
      failure: null,
      publicationId: null,
      canRetry: false,
      noteText: input.input.text,
    });
    assert.deepEqual((await f.save(id, input)).json(), first.json());
    assert.equal((await f.save(id, { ...input, title: 'Different' })).status, 409);
    assert.deepEqual((await f.call('/search?query=returns')).json().hits, []);
    assert.deepEqual(await f.process(input.commandId), { disposition: 'ready' });
    const read = await f.call(`/documents/${id}`);
    assert.equal(read.json().parsing, 'ready');
    assert.equal((await f.call()).json().items[0].documentId, id);
    const search = (await f.call('/search?query=OPS-123')).json();
    assert.equal(search.mode, 'keyword-only');
    assert.equal(search.reason, 'semantic-not-enabled');
    assert.equal(search.hits[0].title, 'Returns handbook');
    assert.match(search.hits[0].text, /thirty days/);
    assert.ok(Date.parse(search.validUntil) > Date.now());
    const citation = search.hits[0].citation;
    const evidence = await f.call('/evidence', { method: 'POST', body: citation });
    assert.equal(evidence.status, 200);
    assert.deepEqual(evidence.json().original, { kind: 'note' });
    assert.equal(evidence.json().text, search.hits[0].text);
    const original = await f.call(`/documents/${id}/original?revisionId=${citation.revisionId}`);
    assert.deepEqual(original.bytes, Buffer.from(input.input.text));
    assert.equal(original.headers.get('content-type'), 'application/octet-stream');
    assert.equal(original.headers.get('x-content-type-options'), 'nosniff');
    assert.match(original.headers.get('content-disposition'), /filename\*=UTF-8''note.md/);
    const updated = {
      ...f.command({ kind: 'note', text: '# Exchanges\nExchange orders within seven days.' }),
      expectedRevisionId: input.commandId,
      title: 'Exchange handbook',
    };
    assert.equal((await f.save(id, updated)).status, 200);
    const staleOriginal = await f.call(`/documents/${id}/original?revisionId=${citation.revisionId}`);
    assert.equal(staleOriginal.status, 409);
    assert.deepEqual(staleOriginal.json(), { error: 'knowledge-superseded' });
    const currentOriginal = await f.call(`/documents/${id}/original?revisionId=${updated.commandId}`);
    assert.equal(currentOriginal.status, 200);
    assert.deepEqual(currentOriginal.bytes, Buffer.from('# Exchanges\nExchange orders within seven days.'));
    const concealedOriginal = await f.call(`/documents/${id}/original?revisionId=${citation.revisionId}`, {
      cookie: f.signed.admin.cookie,
    });
    assert.equal(concealedOriginal.status, 404);
    assert.deepEqual(concealedOriginal.json(), { error: 'knowledge-not-found' });
    const superseded = await f.call('/evidence', { method: 'POST', body: citation });
    assert.equal(superseded.status, 409);
    assert.deepEqual(superseded.json(), { error: 'knowledge-superseded' });
    const concealed = await f.call('/evidence', { method: 'POST', body: citation, cookie: f.signed.admin.cookie });
    assert.equal(concealed.status, 404);
    assert.deepEqual(concealed.json(), { error: 'knowledge-not-found' });
    assert.deepEqual((await f.call('/search?query=returns')).json().hits, []);
    assert.equal((await f.save(id, { ...f.command(), expectedRevisionId: input.commandId })).status, 409);
    assert.deepEqual(await f.process(updated.commandId), { disposition: 'ready' });
    assert.equal((await f.call('/search?query=exchanges')).json().hits[0].title, 'Exchange handbook');
    const remove = { commandId: randomUUID(), expectedRevisionId: updated.commandId };
    const removed = await f.call(`/documents/${id}/remove`, { method: 'POST', body: remove });
    assert.deepEqual(removed.json(), { documentId: id, revisionId: updated.commandId, removed: true });
    assert.deepEqual(
      (await f.call(`/documents/${id}/remove`, { method: 'POST', body: remove })).json(),
      removed.json(),
    );
    assert.equal((await f.call(`/documents/${id}`)).status, 404);
    assert.deepEqual((await f.call('/search?query=exchanges')).json().hits, []);
    assert.equal(f.object.requests.length, 0);
  } finally {
    await f.close();
  }
});

test('Files upload and promotion use native document parsing and preserve original bytes after knowledge removal', async () => {
  const f = await knowledgeFixture();
  try {
    const id = randomUUID(),
      fileId = randomUUID(),
      bytes = docx();
    const input = f.command({ kind: 'file', fileId });
    const upload = await f.upload(
      fileId,
      bytes,
      "Orchard 'é.docx",
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    assert.equal(upload.status, 200, upload.bytes.toString());
    const saved = await f.save(id, input);
    assert.equal(saved.status, 200, saved.bytes.toString());
    assert.equal(saved.json().fileId, fileId);
    assert.deepEqual(await f.process(input.commandId), { disposition: 'ready' });
    const search = (await f.call('/search?query=orchard')).json();
    assert.match(search.hits[0].text, /Harvest apples on Tuesday/);
    const evidence = await f.call('/evidence', { method: 'POST', body: search.hits[0].citation });
    assert.deepEqual(evidence.json().original, { kind: 'file', fileId });
    const original = await f.call(`/documents/${id}/original?revisionId=${input.commandId}`);
    assert.deepEqual(original.bytes, bytes);
    assert.match(original.headers.get('content-disposition'), /Orchard%20%27%C3%A9.docx/);
    assert.equal(
      (
        await f.call(`/documents/${id}/remove`, {
          method: 'POST',
          body: { commandId: randomUUID(), expectedRevisionId: input.commandId },
        })
      ).status,
      200,
    );
    assert.equal((await f.call(`/documents/${id}/original?revisionId=${input.commandId}`)).status, 404);
    assert.deepEqual((await f.call(`/v1/workspaces/${f.workspace.id}/files/${fileId}/content`)).bytes, bytes);
    assert.equal(f.object.objects.size, 1);
  } finally {
    await f.close();
  }
});

test('personal knowledge conceals content from admins, foreign workspaces, and revoked File readers', async () => {
  const f = await knowledgeFixture();
  try {
    const id = randomUUID(),
      input = f.command();
    assert.equal((await f.save(id, input)).status, 200);
    assert.deepEqual(await f.process(input.commandId), { disposition: 'ready' });
    const citation = (await f.call('/search?query=returns')).json().hits[0].citation;
    for (const suffix of ['', `/original?revisionId=${input.commandId}`]) {
      assert.equal((await f.call(`/documents/${id}${suffix}`, { cookie: '' })).status, 401);
      const denied = await f.call(`/documents/${id}${suffix}`, { cookie: f.signed.admin.cookie });
      assert.equal(denied.status, 404);
      assert.deepEqual(denied.json(), { error: 'knowledge-not-found' });
      assert.deepEqual(
        (await f.call(`/documents/${randomUUID()}${suffix}`, { cookie: f.signed.admin.cookie })).json(),
        denied.json(),
      );
      assert.equal(
        (
          await f.call(`/v1/workspaces/${f.other.id}/knowledge/documents/${id}${suffix}`, {
            cookie: f.signed.admin.cookie,
          })
        ).status,
        404,
      );
    }
    assert.deepEqual((await f.call('/search?query=returns', { cookie: f.signed.admin.cookie })).json().hits, []);
    assert.equal(
      (await f.call('/evidence', { method: 'POST', body: citation, cookie: f.signed.admin.cookie })).status,
      404,
    );
    assert.equal(
      (
        await f.call(`/v1/workspaces/${f.other.id}/knowledge/evidence`, {
          method: 'POST',
          body: citation,
          cookie: f.signed.admin.cookie,
        })
      ).status,
      404,
    );
    for (const expectedRevisionId of [input.commandId, randomUUID(), null]) {
      const denied = await f.save(id, { ...f.command(), expectedRevisionId }, { cookie: f.signed.admin.cookie });
      assert.equal(denied.status, 404);
      assert.deepEqual(denied.json(), { error: 'knowledge-not-found' });
      if (expectedRevisionId !== null) {
        const missing = await f.save(
          randomUUID(),
          { ...f.command(), expectedRevisionId },
          { cookie: f.signed.admin.cookie },
        );
        assert.equal(missing.status, 404);
        assert.deepEqual(missing.json(), { error: 'knowledge-not-found' });
      }
    }
    const adminNote = await f.save(randomUUID(), f.command(), { cookie: f.signed.admin.cookie });
    assert.equal(adminNote.status, 200);
    assert.equal((await f.call(`/documents/${id}`)).json().noteText, input.input.text);
    const fileId = randomUUID(),
      promoted = randomUUID();
    assert.equal((await f.upload(fileId, Buffer.from('Revocable orchard instructions'))).status, 200);
    assert.equal((await f.share(fileId, 'viewer')).status, 200);
    const promotion = f.command({ kind: 'file', fileId });
    assert.equal((await f.save(promoted, promotion, { cookie: f.signed.admin.cookie })).status, 200);
    assert.deepEqual(await f.process(promotion.commandId), { disposition: 'ready' });
    const adminSearch = (await f.call('/search?query=revocable', { cookie: f.signed.admin.cookie })).json();
    assert.match(adminSearch.hits[0].text, /orchard/);
    f.object.faults.afterRead = async () => {
      assert.equal((await f.share(fileId, null)).status, 200);
    };
    const revokedOriginal = await f.call(`/documents/${promoted}/original?revisionId=${promotion.commandId}`, {
      cookie: f.signed.admin.cookie,
    });
    assert.equal(revokedOriginal.status, 404);
    assert.deepEqual(revokedOriginal.json(), { error: 'knowledge-not-found' });
    assert.equal(f.object.faults.afterRead, null);
    assert.deepEqual((await f.call('/search?query=revocable', { cookie: f.signed.admin.cookie })).json().hits, []);
    assert.equal(
      (await f.call('/evidence', { method: 'POST', body: adminSearch.hits[0].citation, cookie: f.signed.admin.cookie }))
        .status,
      404,
    );
    for (const expectedRevisionId of [promotion.commandId, randomUUID(), null]) {
      const denied = await f.save(promoted, { ...f.command(), expectedRevisionId }, { cookie: f.signed.admin.cookie });
      assert.equal(denied.status, 404);
      assert.deepEqual(denied.json(), { error: 'knowledge-not-found' });
    }
    assert.deepEqual(
      (await f.call(`/v1/workspaces/${f.workspace.id}/files/${fileId}/content`)).bytes,
      Buffer.from('Revocable orchard instructions'),
    );
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
      f.workspace.membershipId,
    ]);
    assert.equal((await f.call(`/documents/${id}`)).status, 404);
    assert.equal((await f.call('/evidence', { method: 'POST', body: citation })).status, 404);
  } finally {
    await f.close();
  }
});

test('search groups matching chunks before the candidate limit and returns usable document citations', async () => {
  const f = await knowledgeFixture({ filesEnabled: false });
  try {
    const largeId = randomUUID(),
      smallId = randomUUID();
    const large = {
      ...f.command({
        kind: 'note',
        text: Array.from(
          { length: 125 },
          (_, index) => `# Orchard section ${index}\nOrchard harvest instructions for this section.`,
        ).join('\n\n'),
      }),
      title: 'Orchard handbook',
    };
    const small = { ...f.command({ kind: 'note', text: 'The orchard opens on Tuesday.' }), title: 'Opening hours' };
    for (const [id, input] of [
      [largeId, large],
      [smallId, small],
    ]) {
      assert.equal((await f.save(id, input)).status, 200);
      assert.deepEqual(await f.process(input.commandId), { disposition: 'ready' });
    }
    const result = await f.call('/search?query=orchard');
    assert.equal(result.status, 200);
    assert.deepEqual(
      result.json().hits.map(hit => hit.citation.documentId),
      [largeId, smallId],
    );
    assert.equal(result.json().hits[0].citation.ordinal, 0);
    for (const hit of result.json().hits) {
      const evidence = await f.call('/evidence', { method: 'POST', body: hit.citation });
      assert.equal(evidence.status, 200);
      assert.equal(evidence.json().text, hit.text);
    }
  } finally {
    await f.close();
  }
});

test('HTTP validates authority fields, origins, note size and parser failure states without leaking errors', async () => {
  const f = await knowledgeFixture();
  try {
    const id = randomUUID(),
      input = f.command();
    assert.equal((await f.save(id, input, { cookie: '' })).status, 401);
    assert.equal((await f.save(id, input, { headers: { origin: 'https://evil.example' } })).status, 403);
    for (const body of [
      { ...input, documentId: id },
      { ...input, userId: f.signed.admin.id },
      { ...input, input: { kind: 'note', text: '\0' } },
      { ...input, commandId: 'bad' },
    ]) {
      const invalid = await f.save(id, body);
      assert.equal(invalid.status, 400);
      assert.deepEqual(invalid.json(), { error: 'invalid-request' });
    }
    assert.equal((await f.call('/documents?unknown=x')).status, 400);
    assert.equal((await f.call('/search?query=')).status, 400);
    assert.equal((await f.save(id, input)).status, 200);
    for (const query of ['', '?revisionId=bad', '?revisionId=', `?revisionId=${input.commandId}&unknown=x`]) {
      const invalid = await f.call(`/documents/${id}/original${query}`);
      assert.equal(invalid.status, 400);
      assert.deepEqual(invalid.json(), { error: 'invalid-request' });
      assert.equal((await f.call(`/documents/${id}/original${query}`, { cookie: '' })).status, 401);
    }
    assert.equal(
      (await f.save(randomUUID(), f.command({ kind: 'note', text: 'a'.repeat(10 * 1024 * 1024) }))).status,
      200,
    );
    assert.equal(
      (await f.save(randomUUID(), f.command({ kind: 'note', text: 'a'.repeat(10 * 1024 * 1024 + 65536) }))).status,
      413,
    );
    const fileId = randomUUID(),
      malformed = randomUUID(),
      bad = f.command({ kind: 'file', fileId });
    assert.equal((await f.upload(fileId, Buffer.from('%PDF-corrupt'), 'broken.pdf', 'application/pdf')).status, 200);
    assert.equal((await f.save(malformed, bad)).status, 200);
    assert.deepEqual(await f.process(bad.commandId), { disposition: 'failed' });
    const failed = (await f.call(`/documents/${malformed}`)).json();
    assert.equal(failed.parsing, 'failed');
    assert.equal(failed.canRetry, false);
    assert.equal(
      (
        await f.call(`/documents/${malformed}/retry`, {
          method: 'POST',
          body: { commandId: randomUUID(), expectedRevisionId: bad.commandId },
        })
      ).status,
      409,
    );
    const scanFile = randomUUID(),
      scanId = randomUUID(),
      scan = f.command({ kind: 'file', fileId: scanFile });
    assert.equal((await f.upload(scanFile, await pdf(['scan']), 'scan.pdf', 'application/pdf')).status, 200);
    assert.equal((await f.save(scanId, scan)).status, 200);
    assert.deepEqual(await f.process(scan.commandId), { disposition: 'failed' });
    assert.equal((await f.call(`/documents/${scanId}`)).json().parsing, 'ocr-unavailable');
    f.object.faults.corrupt = true;
    const corrupt = await f.call(`/documents/${scanId}/original?revisionId=${scan.commandId}`);
    assert.equal(corrupt.status, 502);
    assert.deepEqual(corrupt.json(), { error: 'file-integrity' });
    f.object.faults.corrupt = false;
    const originalRead = f.service.get;
    f.service.get = async () => {
      throw new Error('private-document-and-database-password');
    };
    try {
      assert.deepEqual((await f.call(`/documents/${scanId}`)).json(), { error: 'knowledge-operation-failed' });
    } finally {
      f.service.get = originalRead;
    }
  } finally {
    await f.close();
  }
});

test('missing byte storage remains explicit for a readable File while notes remain available', async () => {
  const f = await knowledgeFixture();
  const app = Fastify();
  try {
    const fileId = randomUUID();
    assert.equal((await f.upload(fileId, Buffer.from('preserved original'))).status, 200);
    registerKnowledgeComposition(app, { runtime: f.runtime, auth: f.signed.auth });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    async function save(input) {
      const response = await fetch(`${origin}/workspaces/${f.workspace.id}/knowledge/documents/${randomUUID()}`, {
        method: 'PUT',
        headers: { cookie: f.signed.owner.cookie, origin: 'http://localhost:5173', 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return { status: response.status, body: await response.json() };
    }
    assert.deepEqual(await save(f.command({ kind: 'file', fileId })), {
      status: 503,
      body: { error: 'knowledge-adapter-required' },
    });
    const note = await save(f.command());
    assert.equal(note.status, 200);
    assert.equal(note.body.parsing, 'queued');
  } finally {
    await app.close();
    await f.close();
  }
});

test('retry commands requeue eligible provider failures once and preserve conflict detection', async () => {
  const f = await knowledgeFixture({ filesEnabled: false });
  try {
    const id = randomUUID(),
      input = f.command();
    assert.equal((await f.save(id, input)).status, 200);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_knowledge_work')} SET parsing='failed',failure='provider',attempts=1 WHERE revision_id=$1`,
      [input.commandId],
    );
    assert.equal((await f.call(`/documents/${id}`)).json().canRetry, true);
    const retry = { commandId: randomUUID(), expectedRevisionId: input.commandId };
    const queued = await f.call(`/documents/${id}/retry`, { method: 'POST', body: retry });
    assert.equal(queued.status, 200);
    assert.equal(queued.json().parsing, 'queued');
    assert.deepEqual((await f.call(`/documents/${id}/retry`, { method: 'POST', body: retry })).json(), queued.json());
    assert.deepEqual(await f.service.due(f.workspace.id), [
      { workspaceId: f.workspace.id, revisionId: input.commandId, generation: 2 },
    ]);
    assert.deepEqual(await f.process(input.commandId), { disposition: 'ready' });
    assert.equal(
      (await f.call(`/documents/${id}/retry`, { method: 'POST', body: { ...retry, commandId: randomUUID() } })).status,
      409,
    );
    assert.equal((await f.call('/search?query=returns')).json().hits[0].title, 'Returns handbook');
  } finally {
    await f.close();
  }
});

test('workspace admins read and change whether Knowledge reads images in documents', async () => {
  const f = await knowledgeFixture({ filesEnabled: false });
  try {
    const admin = { cookie: f.signed.admin.cookie };
    assert.deepEqual((await f.call('/settings', admin)).json(), { mediaRecognition: true, canManage: true });
    const off = await f.call('/settings', { ...admin, method: 'PUT', body: { mediaRecognition: false } });
    assert.equal(off.status, 200, off.bytes.toString());
    assert.deepEqual(off.json(), { mediaRecognition: false, canManage: true });
    assert.equal(
      (await f.call('/settings', { ...admin, method: 'PUT', body: { mediaRecognition: 'no' } })).status,
      400,
    );
    const owner = await f.db.platform.query(`SELECT role FROM ${f.table('tf_memberships')} WHERE user_id=$1`, [
      f.signed.owner.id,
    ]);
    const ownerIsAdmin = owner.rows[0]?.role === 'admin';
    assert.deepEqual((await f.call('/settings')).json(), { mediaRecognition: false, canManage: ownerIsAdmin });
    const change = await f.call('/settings', { method: 'PUT', body: { mediaRecognition: true } });
    if (ownerIsAdmin) assert.equal(change.status, 200);
    else assert.deepEqual([change.status, change.json()], [403, { error: 'knowledge-admin-required' }]);
  } finally {
    await f.close();
  }
});
