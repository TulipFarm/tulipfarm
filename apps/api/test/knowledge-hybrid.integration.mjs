import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createKnowledgeEmbeddings } from '@tulipfarm/knowledge';
import { knowledgeEmbeddingProfile, parseKnowledgeEmbeddingsConfig } from '@tulipfarm/config';
import { knowledgeFixture } from './knowledge-fixture.mjs';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';

// These tests exhaust workspace balances, so they fund work from the credit account as a billing extension would.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

export async function hybridFixture() {
  const env = {
    KNOWLEDGE_EMBEDDINGS_ENABLED: 'true',
    AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com/',
    AZURE_FOUNDRY_API_KEY: 'fixture-only',
  };
  let calls = 0;
  let failure = false;
  const provider = async () => {
    calls++;
    return {
      dispatch: 'dispatched',
      inputTokensUpperBound: 1,
      requestId: 'hybrid-http-fixture',
      usage: { kind: 'known', inputTokens: 1, totalTokens: 1, exceedsUpperBound: false },
      result: failure
        ? { kind: 'error', code: 'invalid_vectors' }
        : { kind: 'success', model: knowledgeEmbeddingProfile.model, vectors: [Array(1536).fill(0.25)] },
    };
  };
  const f = await knowledgeFixture({ embeddings: { env, provider } });
  await f.db.platform.query(
    `UPDATE ${f.table('tf_credit_account')} SET available=10000000000000,granted=10000000000000`,
  );
  const embeddings = createKnowledgeEmbeddings({
    runtime: f.runtime,
    config: parseKnowledgeEmbeddingsConfig(env),
    provider,
    capacity: async () => true,
  });
  async function note(text, title = 'Supplier agreement') {
    const id = randomUUID(),
      command = { ...f.command({ kind: 'note', text }), title };
    assert.equal((await f.save(id, command)).status, 200);
    await f.process(command.commandId);
    for (let step = 0; step < 10; step++) {
      for (const work of await embeddings.due(f.workspace.id)) await embeddings.process(work);
      if (
        (
          await f.db.platform.query(
            `SELECT vector_publication_id FROM ${f.table('tf_knowledge_documents')} WHERE id=$1`,
            [id],
          )
        ).rows[0].vector_publication_id
      )
        return id;
    }
    assert.fail('Vector publication missing');
  }
  return {
    ...f,
    note,
    embeddings,
    calls: () => calls,
    fail: () => {
      failure = true;
    },
  };
}

test(
  'authenticated hybrid HTTP submits once, preserves paid cache and falls back on failure or credits',
  { timeout: 60000 },
  async () => {
    const f = await hybridFixture();
    try {
      const id = await f.note('supplier payment terms precede shipment; provider failure or credits exhausted');
      const before = f.calls();
      const body = { kind: 'submitted', commandId: randomUUID(), query: 'supplier settlement policy' };
      assert.equal((await f.call('/search', { method: 'POST', body, cookie: '' })).status, 401);
      const stranger = await f.call('/search', { method: 'POST', body, cookie: f.signed.admin.cookie });
      assert.equal(stranger.status, 200, stranger.bytes.toString());
      assert.deepEqual(stranger.json().hits, []);
      assert.equal(f.calls(), before);
      const typing = await f.call('/search', { method: 'POST', body: { kind: 'typing', query: 'suppl' } });
      assert.equal(typing.status, 200, typing.bytes.toString());
      assert.equal(typing.json().reason, 'typing');
      assert.equal(f.calls(), before);
      const response = await f.call('/search', { method: 'POST', body });
      assert.equal(response.status, 200, response.bytes.toString());
      assert.equal(response.json().mode, 'hybrid');
      assert.equal(response.json().hits[0].citation.documentId, id);
      assert.equal(response.bytes.includes('vector'), false);
      assert.equal(f.calls(), before + 1);
      assert.deepEqual((await f.call('/search', { method: 'POST', body })).json(), response.json());
      const filtered = await f.call('/search', {
        method: 'POST',
        body: { ...body, commandId: randomUUID(), filters: { documentIds: [id] } },
      });
      assert.equal(filtered.json().mode, 'hybrid');
      assert.equal(f.calls(), before + 1);
      f.fail();
      const failed = await f.call('/search', {
        method: 'POST',
        body: { ...body, commandId: randomUUID(), query: 'supplier provider failure' },
      });
      assert.equal(failed.status, 200, failed.bytes.toString());
      assert.equal(failed.json().reason, 'provider-unavailable');
      assert.equal(failed.json().hits.length, 1);
      await f.db.platform.query(`UPDATE ${f.table('tf_credit_account')} SET available=0`);
      await f.db.platform.query(`UPDATE ${f.table('tf_knowledge_credit_group')} SET known=1000000000000`);
      const blocked = await f.call('/search', {
        method: 'POST',
        body: { ...body, commandId: randomUUID(), query: 'supplier credits exhausted' },
      });
      assert.equal(blocked.status, 200, blocked.bytes.toString());
      assert.equal(blocked.json().reason, 'credits-blocked');
      assert.equal(blocked.json().hits.length, 1);
      assert.equal(
        (
          await f.call('/search', {
            method: 'POST',
            body: {
              kind: 'submitted',
              commandId: randomUUID(),
              query: 'x',
              filters: { documentIds: Array(101).fill(id) },
            },
          })
        ).status,
        400,
      );
      await f.db.platform.query(`BEGIN; LOCK TABLE ${f.table('tf_authorization_lock')} IN ACCESS EXCLUSIVE MODE`);
      const started = performance.now();
      const release = new Promise((resolve, reject) =>
        setTimeout(() => {
          f.db.platform.query('ROLLBACK').then(resolve, reject);
        }, 2200),
      );
      try {
        const delayed = await f.call('/search', { method: 'POST', body: { kind: 'typing', query: 'supplier' } });
        assert.equal(delayed.status, 200, delayed.bytes.toString());
        assert.ok(performance.now() - started >= 2200);
      } finally {
        await release;
      }
      assert.equal(
        (await f.call('/search', { method: 'POST', body: { kind: 'typing', query: 'supplier' } })).status,
        200,
      );
    } finally {
      await f.close();
    }
  },
);
