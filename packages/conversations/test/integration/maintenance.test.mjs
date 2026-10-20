import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied, SourceAuthorizationUnavailable } from '@tulipfarm/access';
import { knowledgeEmbeddingProfile } from '@tulipfarm/config';
import { createConversationKnowledge } from '@tulipfarm/knowledge';
import { createConversationMaintenance } from '../../src/maintenance.ts';
import { createConversationExecutor } from '../../src/runtime.ts';
import { conversationFixture } from '../fixture.mjs';
import { requestFixture } from '../request-fixture.mjs';
import { createPersonalMemoryService } from '../../src/personal-memory.ts';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';

// These tests exhaust workspace balances, so they fund work from the credit account as a billing extension would.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

function compactor(onCall = async () => {}) {
  const calls = [];
  return {
    calls,
    policy: async () => ({
      automatic: false,
      triggerPercent: 70,
      targetPercent: 30,
      outputPrompt: null,
      revision: 0,
      families: ['claude-haiku'],
    }),
    measure: async () => ({ tokens: 100, window: 100000 }),
    window: async () => 100000,
    summarize: async input => {
      calls.push(input);
      await onCall(input);
      if (input.purpose === 'memory')
        return {
          text: JSON.stringify({ content: JSON.parse(input.messages[0].text).currentMemory, evidence: [] }),
          familyId: 'claude-haiku',
          fallbackFrom: null,
        };
      return {
        text:
          input.purpose === 'summary'
            ? JSON.stringify({ goal: 'Plan launch', decisions: ['Launch Tuesday'], openWork: ['Send invitations'] })
            : '## Key decisions\nLaunch Tuesday\n## Open work\nSend invitations',
        familyId: 'claude-haiku',
        fallbackFrom: null,
      };
    },
  };
}
const published = () => ({ documentId: randomUUID(), revisionId: randomUUID(), embeddingStatus: 'disabled' });

test(
  'maintenance learns owner preferences once, backfills saved compactions, and preserves manual edits',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const id = await chat(f),
        w = f.workspace,
        maintenance = createConversationMaintenance(f.runtime);
      const memory = createPersonalMemoryService(f.runtime);
      const knowledge = createConversationKnowledge({ runtime: f.runtime });
      await exchange(f, id, 'Please use emojis in your replies.');
      await due(f, id);
      await maintenance.sweep(w.id);
      const [job] = await work(f, maintenance);
      assert.equal(await maintenance.process(job, compactor(), knowledge.publish), 'ready');
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_maintenance')}
      SET memory_complete=false,memory_chunk=0,dispatched_at=NULL WHERE id=$1`,
        [job.jobId],
      );
      assert.equal(
        (await work(f, maintenance)).length,
        1,
        'completed historical jobs are discovered without re-compaction',
      );
      const calls = [];
      const model = {
        ...compactor(),
        summarize: async input => {
          calls.push(input);
          assert.equal(input.purpose, 'memory');
          const { requesterTranscript } = JSON.parse(input.messages[0].text);
          assert.doesNotMatch(requesterTranscript, /Invitations remain open/);
          const messageId = requesterTranscript.match(/id="([^"]+)"/)[1];
          return {
            text: JSON.stringify({ content: 'Use emojis in replies.', evidence: [{ messageId, quote: 'use emojis' }] }),
            familyId: 'claude-haiku',
            fallbackFrom: null,
          };
        },
      };
      assert.equal(await maintenance.process(job, model, knowledge.publish), 'ready');
      assert.equal(calls.length, 1);
      assert.deepEqual(await memory.read(w.id, w.userId), { content: 'Use emojis in replies.', revision: 1 });
      assert.equal((await work(f, maintenance)).length, 0);
      assert.equal(await maintenance.process(job, model, async () => published()), 'idle');
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT count(*)::int AS n FROM ${f.table('tf_conversation_compactions')} WHERE conversation_id=$1`,
            [id],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_knowledge_documents')}`)).rows[0].n,
        1,
        'backfill reuses the published recap',
      );
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT count(*)::int AS n FROM ${f.table('tf_conversation_maintenance_steps')} WHERE purpose='memory'`,
          )
        ).rows[0].n,
        0,
        'applied memory has no retained content history',
      );

      await memory.delete(w.id, w.userId, { expectedRevision: 1 });
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_maintenance')} SET memory_complete=false,memory_chunk=0,dispatched_at=NULL WHERE id=$1`,
        [job.jobId],
      );
      assert.equal(await maintenance.process(job, model, async () => published()), 'ready');
      assert.equal(calls.length, 1, 'cleared memory is not resurrected from older chat text');
      assert.deepEqual(await memory.read(w.id, w.userId), { content: '', revision: 2 });

      await exchange(f, id, 'Please use emojis again.');
      await due(f, id);
      await maintenance.sweep(w.id);
      const [next] = await work(f, maintenance);
      const base = compactor();
      const reopened = {
        ...base,
        summarize: input => (input.purpose === 'memory' ? model.summarize(input) : base.summarize(input)),
      };
      assert.equal(await maintenance.process(next, reopened, knowledge.publish), 'ready');
      assert.equal(calls.length, 2, 'new chats can learn after a manual clear');
      assert.doesNotMatch(JSON.parse(calls[1].messages[0].text).requesterTranscript, /use emojis in your replies/);
      assert.deepEqual(await memory.read(w.id, w.userId), { content: 'Use emojis in replies.', revision: 3 });
    } finally {
      await f.close();
    }
  },
);

test('newer no-change evidence protects memory from an older backfill', { timeout: 60000 }, async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace,
      maintenance = createConversationMaintenance(f.runtime),
      memory = createPersonalMemoryService(f.runtime);
    const seed = await chat(f),
      old = await chat(f),
      latest = await chat(f);
    for (const [id, text, at] of [
      [seed, 'No emojis.', '2026-01-01'],
      [old, 'Use emojis.', '2026-01-02'],
      [latest, 'Still no emojis.', '2026-01-03'],
    ]) {
      await exchange(f, id, text);
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_messages')} SET created_at=$2 WHERE conversation_id=$1`,
        [id, at],
      );
      await due(f, id);
    }
    await maintenance.sweep(w.id);
    const jobs = await work(f, maintenance),
      base = compactor();
    const model = (content, quote) => ({
      ...base,
      summarize: async input => {
        if (input.purpose !== 'memory') return base.summarize(input);
        const messageId = JSON.parse(input.messages[0].text).requesterTranscript.match(/id="([^"]+)"/)[1];
        return {
          text: JSON.stringify({ content, evidence: quote ? [{ messageId, quote }] : [] }),
          familyId: 'claude-haiku',
          fallbackFrom: null,
        };
      },
    });
    const process = (id, selected) =>
      maintenance.process(
        jobs.find(job => job.conversationId === id),
        selected,
        async () => published(),
      );
    assert.equal(await process(seed, model('Do not use emojis.', 'No emojis.')), 'ready');
    assert.equal(await process(latest, model(null)), 'ready');
    assert.equal(await process(old, model('Use emojis.', 'Use emojis.')), 'blocked');
    assert.equal((await f.store.maintenance(w.id, w.userId, old)).maintenance.errorCode, 'memory-invalid-preferences');
    assert.deepEqual(await memory.read(w.id, w.userId), { content: 'Do not use emojis.', revision: 1 });
  } finally {
    await f.close();
  }
});

test('reopening a chat during preference inference fences the memory write', { timeout: 60000 }, async () => {
  const f = await conversationFixture();
  try {
    const id = await chat(f),
      w = f.workspace,
      maintenance = createConversationMaintenance(f.runtime),
      base = compactor();
    await exchange(f, id, 'Use emojis.');
    await due(f, id);
    await maintenance.sweep(w.id);
    const [job] = await work(f, maintenance);
    const model = {
      ...base,
      summarize: async input => {
        if (input.purpose !== 'memory') return base.summarize(input);
        await f.store.send(w.id, w.userId, id, {
          commandId: randomUUID(),
          messageId: randomUUID(),
          parts: [{ kind: 'text', text: 'Continue.' }],
        });
        const messageId = JSON.parse(input.messages[0].text).requesterTranscript.match(/id="([^"]+)"/)[1];
        return {
          text: JSON.stringify({ content: 'Use emojis.', evidence: [{ messageId, quote: 'Use emojis.' }] }),
          familyId: 'claude-haiku',
          fallbackFrom: null,
        };
      },
    };
    assert.equal(
      await maintenance.process(job, model, async () => {
        throw new Error('must not publish');
      }),
      'stale',
    );
    assert.deepEqual(await createPersonalMemoryService(f.runtime).read(w.id, w.userId), { content: '', revision: 0 });
  } finally {
    await f.close();
  }
});

test('manual changes during inference win and leave a resumable memory checkpoint', { timeout: 60000 }, async () => {
  const f = await conversationFixture();
  try {
    const id = await chat(f),
      w = f.workspace,
      maintenance = createConversationMaintenance(f.runtime);
    const memory = createPersonalMemoryService(f.runtime);
    await exchange(f, id, 'Use emojis.');
    await due(f, id);
    await maintenance.sweep(w.id);
    const [job] = await work(f, maintenance);
    const base = compactor();
    let memoryCalls = 0;
    const model = {
      ...base,
      summarize: async input => {
        if (input.purpose !== 'memory') return base.summarize(input);
        memoryCalls++;
        await memory.save(w.id, w.userId, { content: 'No emojis.', expectedRevision: 0 });
        const messageId = JSON.parse(input.messages[0].text).requesterTranscript.match(/id="([^"]+)"/)[1];
        return {
          text: JSON.stringify({ content: 'Use emojis.', evidence: [{ messageId, quote: 'Use emojis.' }] }),
          familyId: 'claude-haiku',
          fallbackFrom: null,
        };
      },
    };
    assert.equal(await maintenance.process(job, model, async () => published()), 'queued');
    assert.deepEqual(await memory.read(w.id, w.userId), { content: 'No emojis.', revision: 1 });
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_maintenance')} SET next_attempt_at=clock_timestamp() WHERE id=$1`,
      [job.jobId],
    );
    assert.equal(await maintenance.process(job, model, async () => published()), 'ready');
    assert.equal(memoryCalls, 1);
  } finally {
    await f.close();
  }
});

test('recap embedding status and resume select the current profile and publication', { timeout: 60000 }, async () => {
  const f = await conversationFixture();
  try {
    const id = await chat(f),
      w = f.workspace,
      maintenance = createConversationMaintenance(f.runtime);
    await exchange(f, id);
    await due(f, id);
    await maintenance.sweep(w.id);
    const [job] = await work(f, maintenance);
    const knowledge = createConversationKnowledge({ runtime: f.runtime });
    assert.equal(await maintenance.process(job, compactor(), knowledge.publish), 'ready');
    const saved = (
      await f.db.platform.query(
        `SELECT j.document_id,j.revision_id,d.lexical_publication_id AS publication_id
      FROM ${f.table('tf_conversation_maintenance')} j JOIN ${f.table('tf_knowledge_documents')} d ON d.id=j.document_id
      WHERE j.id=$1`,
        [job.jobId],
      )
    ).rows[0];
    const oldProfile = `${knowledgeEmbeddingProfile.id}-old`;
    for (const profileId of [oldProfile, knowledgeEmbeddingProfile.id]) {
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_knowledge_embedding_profiles')} (id,profile) VALUES ($1,$2)`,
        [profileId, { ...knowledgeEmbeddingProfile, id: profileId }],
      );
    }
    async function embedding(profileId, publicationId, state) {
      const embeddingId = randomUUID();
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_knowledge_embedding_jobs')}
        (id,purpose,owner_membership_id,owner_user_id,profile_id,document_id,revision_id,publication_id,access_epoch,total_chunks,state)
        VALUES ($1,'ingestion',$2,$3,$4,$5,$6,$7,1,1,$8)`,
        [embeddingId, w.membershipId, w.userId, profileId, saved.document_id, saved.revision_id, publicationId, state],
      );
      return embeddingId;
    }
    const status = async () => (await f.store.maintenance(w.id, w.userId, id)).maintenance.embeddingStatus;
    const resume = () => f.store.resumeMaintenance(w.id, w.userId, id, { commandId: randomUUID() });
    const reset = () =>
      f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_maintenance')}
      SET state='ready',embedding_status='pending' WHERE id=$1`,
        [job.jobId],
      );
    const oldJob = await embedding(oldProfile, saved.publication_id, 'ready');
    assert.equal(await status(), 'pending', 'without a current-profile job, retain pending publication status');
    const currentJob = await embedding(knowledgeEmbeddingProfile.id, saved.publication_id, 'credits-blocked');
    assert.equal(await status(), 'credits-blocked');
    await resume();
    await reset();
    await f.db.platform.query(
      `UPDATE ${f.table('tf_knowledge_embedding_jobs')} SET state=CASE WHEN id=$1 THEN 'ready' ELSE 'failed' END
      WHERE id=ANY($2::uuid[])`,
      [currentJob, [currentJob, oldJob]],
    );
    assert.equal(await status(), 'ready');
    await assert.rejects(resume(), { message: 'maintenance-not-resumable' });
    const nextPublication = randomUUID();
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_knowledge_publications')}
      (id,document_id,revision_id,markdown,pages,tokens,chunk_count,fingerprint)
      SELECT $1,document_id,revision_id,markdown,pages,tokens,chunk_count,fingerprint
      FROM ${f.table('tf_knowledge_publications')} WHERE id=$2`,
      [nextPublication, saved.publication_id],
    );
    await f.db.platform.query(`UPDATE ${f.table('tf_knowledge_documents')} SET lexical_publication_id=$2 WHERE id=$1`, [
      saved.document_id,
      nextPublication,
    ]);
    await f.db.platform.query(`UPDATE ${f.table('tf_knowledge_embedding_jobs')} SET state='failed' WHERE id=$1`, [
      currentJob,
    ]);
    assert.equal(await status(), 'pending', 'jobs for the prior publication do not replace pending status');
    await assert.rejects(resume(), { message: 'maintenance-not-resumable' });
    await embedding(knowledgeEmbeddingProfile.id, nextPublication, 'failed');
    assert.equal(await status(), 'failed');
    await resume();
  } finally {
    await f.close();
  }
});

async function chat(f) {
  const id = randomUUID(),
    w = f.workspace;
  await f.store.create(w.id, w.userId, { chatId: id, commandId: randomUUID() });
  return id;
}
async function exchange(f, id, text = 'Launch Tuesday') {
  const w = f.workspace;
  const sent = await f.store.send(w.id, w.userId, id, {
    commandId: randomUUID(),
    messageId: randomUUID(),
    parts: [{ kind: 'text', text }],
  });
  const executor = createConversationExecutor(f.runtime, async () => ({
    text: 'Invitations remain open',
    sources: [{ kind: 'private-conversation', conversationId: id }],
  }));
  assert.equal(
    await executor.process({ workspaceId: w.id, conversationId: id, turnId: sent.turnId, generation: 0 }),
    'completed',
  );
  return sent;
}
async function due(f, id) {
  await f.db.platform.query(
    `UPDATE ${f.table('tf_conversations')} SET activity_at=clock_timestamp()-interval '1 hour' WHERE id=$1`,
    [id],
  );
  await f.db.platform.query(
    `UPDATE ${f.table('tf_conversation_maintenance_sweep')} SET close_due_at=clock_timestamp(),scan_due_at=clock_timestamp(),close_after=NULL,scan_after=NULL`,
  );
}
async function work(f, maintenance) {
  const jobs = [];
  await maintenance.dispatch(f.workspace.id, async value => jobs.push(value));
  return jobs;
}

test(
  'closure uses real inactivity, excludes waiting work, persists cadence, and reopening atomically invalidates maintenance',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const id = await chat(f),
        w = f.workspace,
        maintenance = createConversationMaintenance(f.runtime);
      const sent = await f.store.send(w.id, w.userId, id, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Pending request' }],
      });
      await due(f, id);
      await f.db.platform.query(`UPDATE ${f.table('tf_conversation_turns')} SET status='waiting' WHERE id=$1`, [
        sent.turnId,
      ]);
      assert.deepEqual(await maintenance.sweep(w.id), { closed: 0, queued: 0 });
      assert.equal((await f.store.read(w.id, w.userId, id)).isClosed, false);
      await f.db.platform.query(`UPDATE ${f.table('tf_conversation_turns')} SET status='cancelled' WHERE id=$1`, [
        sent.turnId,
      ]);
      await due(f, id);
      assert.deepEqual(await maintenance.sweep(w.id), { closed: 1, queued: 1 });
      assert.deepEqual(await maintenance.sweep(w.id), { closed: 0, queued: 0 });
      const jobs = await work(f, maintenance);
      assert.equal(jobs.length, 1);
      assert.equal((await work(f, maintenance)).length, 0);
      await f.store.send(w.id, w.userId, id, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Resume' }],
      });
      assert.equal((await f.store.read(w.id, w.userId, id)).isClosed, false);
      assert.equal((await f.store.maintenance(w.id, w.userId, id)).maintenance.state, 'stale');
      assert.equal(
        await maintenance.process(jobs[0], compactor(), async () => {
          throw new Error('must not publish');
        }),
        'idle',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'saved recap preserves transcript/activity, reuses publication after failure, and next reply sees working summary',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const id = await chat(f),
        w = f.workspace,
        maintenance = createConversationMaintenance(f.runtime),
        model = compactor();
      await exchange(f, id);
      await due(f, id);
      await maintenance.sweep(w.id);
      const before = await f.store.read(w.id, w.userId, id);
      const [job] = await work(f, maintenance);
      assert.equal(
        await maintenance.process(job, model, async () => {
          throw new Error('provider unavailable');
        }),
        'failed',
      );
      assert.deepEqual(
        model.calls.map(call => call.purpose),
        ['summary', 'handoff', 'memory'],
      );
      const first = await f.store.maintenance(w.id, w.userId, id);
      assert.ok(first.maintenance.compactionId);
      await f.store.resumeMaintenance(w.id, w.userId, id, { commandId: randomUUID() });
      let publication;
      assert.equal(
        await maintenance.process(job, model, async input => {
          publication = input;
          return published();
        }),
        'ready',
      );
      assert.equal(model.calls.length, 3, 'saved recap and reconciled memory retry without model generation');
      assert.equal(publication.requester.userId, w.userId);
      assert.equal(publication.coveredThrough, 1);
      const after = await f.store.read(w.id, w.userId, id);
      assert.equal(after.activityAt, before.activityAt);
      assert.equal(after.isClosed, true);
      const history = await f.store.history(w.id, w.userId, id);
      assert.equal(history.messages.length, 3);
      assert.equal(history.messages[2].parts[0].trigger, 'inactivity');
      const detail = await f.store.compaction(w.id, w.userId, id, first.maintenance.compactionId);
      assert.match(detail.handoff.text, /Launch Tuesday/);
      assert.equal(detail.coveredThrough, 1);
      const seen = [];
      const executor = createConversationExecutor(
        f.runtime,
        async ({ messages }) => {
          seen.push(messages);
          return { text: 'Resumed', sources: [{ kind: 'private-conversation', conversationId: id }] };
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        model,
      );
      const sent = await f.store.send(w.id, w.userId, id, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Continue' }],
      });
      assert.equal(
        await executor.process({ workspaceId: w.id, conversationId: id, turnId: sent.turnId, generation: 0 }),
        'completed',
      );
      assert.match(seen[0][0].text, /Working summary/);
      assert.ok(
        seen[0].some(item => item.text === 'Continue'),
        'the first message after reopening remains verbatim',
      );
      assert.doesNotMatch(seen[0].map(item => item.text).join('\n'), /## Key decisions/);
    } finally {
      await f.close();
    }
  },
);

test('reopening during generation rejects stale recap and source publication', { timeout: 60000 }, async () => {
  const f = await conversationFixture();
  try {
    const id = await chat(f),
      w = f.workspace,
      maintenance = createConversationMaintenance(f.runtime);
    await exchange(f, id);
    await due(f, id);
    await maintenance.sweep(w.id);
    const [job] = await work(f, maintenance);
    let sent = false;
    const model = compactor(async () => {
      if (sent) return;
      sent = true;
      await f.store.send(w.id, w.userId, id, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'New facts' }],
      });
    });
    assert.equal(
      await maintenance.process(job, model, async () => {
        throw new Error('stale publication');
      }),
      'stale',
    );
    assert.equal(
      (await f.store.history(w.id, w.userId, id)).messages.some(message =>
        message.parts.some(part => part.kind === 'compaction'),
      ),
      false,
    );
  } finally {
    await f.close();
  }
});

test('removed authority pauses and does not silently use workspace owner', { timeout: 60000 }, async () => {
  const f = await conversationFixture();
  try {
    const id = await chat(f),
      w = f.workspace,
      maintenance = createConversationMaintenance(f.runtime),
      model = compactor();
    await exchange(f, id);
    await due(f, id);
    await maintenance.sweep(w.id);
    const [job] = await work(f, maintenance);
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE user_id=$1`, [
      w.userId,
    ]);
    assert.equal(await maintenance.process(job, model, async () => published()), 'blocked');
    assert.equal(model.calls.length, 0);
    assert.equal((await work(f, maintenance)).length, 0);
  } finally {
    await f.close();
  }
});

test(
  'an unavailable source retries with backoff but a source denial waits for explicit resume',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const id = await chat(f),
        w = f.workspace,
        model = compactor();
      let verdict = 'allow';
      const runtime = {
        ...f.runtime,
        transaction: (workspaceId, range, operation) =>
          f.runtime.transaction(workspaceId, range, tx =>
            operation({
              ...tx,
              knowledgeSourceDependencies: async () => [],
              requireKnowledgeSource: async () => {
                if (verdict === 'deny') throw new AccessDenied();
                if (verdict === 'unavailable') throw new SourceAuthorizationUnavailable();
              },
            }),
          ),
      };
      const maintenance = createConversationMaintenance(runtime);
      const document = {
        kind: 'knowledge-document',
        workspaceId: w.id,
        sourceId: randomUUID(),
        documentId: randomUUID(),
        revisionId: randomUUID(),
        publicationId: randomUUID(),
        accessEpoch: 1,
      };
      const sent = await f.store.send(w.id, w.userId, id, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Launch Tuesday' }],
      });
      const executor = createConversationExecutor(runtime, async () => ({
        text: 'Invitations remain open',
        sources: [{ kind: 'private-conversation', conversationId: id }, document],
      }));
      assert.equal(
        await executor.process({ workspaceId: w.id, conversationId: id, turnId: sent.turnId, generation: 0 }),
        'completed',
      );
      await due(f, id);
      await maintenance.sweep(w.id);
      const [job] = await work(f, maintenance);
      const status = async () => (await f.store.maintenance(w.id, w.userId, id)).maintenance;
      const expire = () =>
        f.db.platform.query(
          `UPDATE ${f.table('tf_conversation_maintenance')} SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
          [job.jobId],
        );

      verdict = 'unavailable';
      assert.equal(await maintenance.process(job, model, async () => published()), 'failed');
      const retrying = await status();
      assert.deepEqual([retrying.state, retrying.errorCode], ['failed', 'source-unavailable']);
      assert.ok(Date.parse(retrying.retryAt) > Date.now(), 'an unavailable source schedules a background retry');
      await expire();
      const [retry] = await work(f, maintenance);
      assert.equal(retry?.jobId, job.jobId, 'the retry is dispatched once its backoff expires');

      verdict = 'deny';
      assert.equal(await maintenance.process(retry, model, async () => published()), 'blocked');
      const denied = await status();
      assert.deepEqual([denied.state, denied.errorCode, denied.retryAt], ['blocked', 'access-denied', null]);

      verdict = 'allow';
      await expire();
      assert.equal((await work(f, maintenance)).length, 0, 'a denial is not dispatched after its backoff expires');
      assert.equal(
        await maintenance.process(retry, model, async () => published()),
        'idle',
        'a stale dispatch cannot claim denied work',
      );
      assert.equal((await status()).state, 'blocked');
      assert.equal(model.calls.length, 0);

      await f.store.resumeMaintenance(w.id, w.userId, id, { commandId: randomUUID() });
      const [resumed] = await work(f, maintenance);
      assert.equal(await maintenance.process(resumed, model, async () => published()), 'ready');
    } finally {
      await f.close();
    }
  },
);

test(
  'archived chats remain eligible, credit blocks back off, and duplicate claims do not duplicate recaps',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const id = await chat(f),
        w = f.workspace,
        maintenance = createConversationMaintenance(f.runtime),
        model = compactor();
      await exchange(f, id);
      await f.db.platform.query(`UPDATE ${f.table('tf_conversations')} SET archived_at=clock_timestamp() WHERE id=$1`, [
        id,
      ]);
      await due(f, id);
      assert.deepEqual(await maintenance.sweep(w.id), { closed: 1, queued: 1 });
      const [job] = await work(f, maintenance);
      await f.db.platform.query(`UPDATE ${f.table('tf_credit_account')} SET available=0 WHERE id=1`);
      assert.equal(await maintenance.process(job, model, async () => published()), 'failed');
      assert.equal(model.calls.length, 0);
      assert.equal((await f.store.maintenance(w.id, w.userId, id)).maintenance.errorCode, 'credits-exhausted');
      await f.db.platform.query(`UPDATE ${f.table('tf_credit_account')} SET available=100000000000000000 WHERE id=1`);
      await f.store.resumeMaintenance(w.id, w.userId, id, { commandId: randomUUID() });
      const results = await Promise.all([
        maintenance.process(job, model, async () => published()),
        maintenance.process(job, model, async () => published()),
      ]);
      assert.deepEqual(results.sort(), ['idle', 'ready']);
      assert.equal(
        (await f.store.history(w.id, w.userId, id)).messages.filter(message =>
          message.parts.some(part => part.kind === 'compaction'),
        ).length,
        1,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'bounded historical closure resumes across service instances and excludes archived projects',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const w = f.workspace,
        first = createConversationMaintenance(f.runtime),
        second = createConversationMaintenance(f.runtime);
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_conversations')} (id,owner_user_id,owner_membership_id,activity_at)
      SELECT gen_random_uuid(),$1,$2,clock_timestamp()-interval '2 hours' FROM generate_series(1,55)`,
        [w.userId, w.membershipId],
      );
      const projectId = randomUUID();
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_projects')} (id,name,creator_membership_id,archived_at) VALUES ($1,'Archived',$2,clock_timestamp())`,
        [projectId, w.membershipId],
      );
      const excluded = randomUUID();
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_conversations')} (id,owner_user_id,owner_membership_id,activity_at,project_id)
      VALUES ($1,$2,$3,clock_timestamp()-interval '2 hours',$4)`,
        [excluded, w.userId, w.membershipId, projectId],
      );
      assert.deepEqual(await first.sweep(w.id), { closed: 50, queued: 0 });
      assert.deepEqual(await second.sweep(w.id), { closed: 5, queued: 0 });
      assert.deepEqual(await first.sweep(w.id), { closed: 0, queued: 0 });
      assert.equal(
        (await f.db.platform.query(`SELECT is_closed FROM ${f.table('tf_conversations')} WHERE id=$1`, [excluded]))
          .rows[0].is_closed,
        false,
      );
      const cadence = (
        await f.db.platform.query(`SELECT close_due_at>clock_timestamp()+interval '50 seconds' AS minute,
      scan_due_at>clock_timestamp()+interval '29 minutes' AS half_hour FROM ${f.table('tf_conversation_maintenance_sweep')}`)
      ).rows[0];
      assert.deepEqual(cadence, { minute: true, half_hour: true });
    } finally {
      await f.close();
    }
  },
);

test(
  'reopening during publication preserves a historical recap but rejects ready state',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const id = await chat(f),
        w = f.workspace,
        maintenance = createConversationMaintenance(f.runtime);
      await exchange(f, id);
      await due(f, id);
      await maintenance.sweep(w.id);
      const [job] = await work(f, maintenance);
      assert.equal(
        await maintenance.process(job, compactor(), async () => {
          await f.store.send(w.id, w.userId, id, {
            commandId: randomUUID(),
            messageId: randomUUID(),
            parts: [{ kind: 'text', text: 'Changed plans' }],
          });
          return published();
        }),
        'stale',
      );
      assert.equal((await f.store.maintenance(w.id, w.userId, id)).maintenance.state, 'stale');
      assert.equal(
        (await f.store.history(w.id, w.userId, id)).messages.filter(message =>
          message.parts.some(part => part.kind === 'compaction'),
        ).length,
        1,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'retrying closed failed work reopens before a reply and invalidates its covered working summary',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const id = await chat(f),
        w = f.workspace,
        maintenance = createConversationMaintenance(f.runtime);
      const sent = await f.store.send(w.id, w.userId, id, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Unfinished request' }],
      });
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_turns')} SET status='failed',error_code='model-unavailable' WHERE id=$1`,
        [sent.turnId],
      );
      await due(f, id);
      await maintenance.sweep(w.id);
      const [job] = await work(f, maintenance);
      assert.equal(await maintenance.process(job, compactor(), async () => published()), 'ready');
      const before = await f.store.read(w.id, w.userId, id);
      await f.store.retry(w.id, w.userId, id, sent.turnId, { commandId: randomUUID(), expectedGeneration: 0 });
      const after = await f.store.read(w.id, w.userId, id);
      assert.equal(after.isClosed, false);
      assert.equal(after.activityAt, before.activityAt, 'a queued retry is not a synthetic message');
      assert.equal((await f.store.maintenance(w.id, w.userId, id)).maintenance.state, 'stale');
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT count(*)::int AS count FROM ${f.table('tf_conversation_working_summaries')} WHERE conversation_id=$1 AND active`,
            [id],
          )
        ).rows[0].count,
        0,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'large summaries persist bounded chunk progress and resume under the pinned policy',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const id = await chat(f),
        w = f.workspace,
        maintenance = createConversationMaintenance(f.runtime),
        model = compactor();
      model.window = async () => 10000;
      let policyReads = 0;
      const policy = model.policy;
      model.policy = async () => {
        policyReads++;
        return policy();
      };
      await exchange(f, id, `First ${'a'.repeat(60000)}`);
      await exchange(f, id, `Second ${'b'.repeat(60000)}`);
      await due(f, id);
      await maintenance.sweep(w.id);
      const [job] = await work(f, maintenance);
      let publications = 0;
      const publish = async () => {
        publications++;
        return published();
      };
      assert.equal(await maintenance.process(job, model, publish), 'queued');
      assert.equal(model.calls.length, 4);
      assert.equal(publications, 0, 'partial summary never becomes Knowledge');
      assert.equal(
        (await f.store.history(w.id, w.userId, id)).messages.some(message =>
          message.parts.some(part => part.kind === 'compaction'),
        ),
        false,
      );
      for (let attempt = 0; ; attempt++) {
        await f.db.platform.query(
          `UPDATE ${f.table('tf_conversation_maintenance')} SET next_attempt_at=clock_timestamp() WHERE id=$1`,
          [job.jobId],
        );
        const result = await createConversationMaintenance(f.runtime).process(job, model, publish);
        if (result === 'ready') break;
        assert.equal(result, 'queued');
        assert.ok(attempt < 30, 'summary and preference chunks have bounded durable progress');
      }
      const steps = model.calls.filter(call => call.purpose === 'summary').map(call => call.step);
      assert.ok(steps.length > 24, 'historical backlog exceeds the normal one-turn safety limit');
      assert.deepEqual(
        steps,
        steps.map((_, index) => index),
      );
      assert.equal(policyReads, 1);
      assert.equal(publications, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'unconfirmed generation is not automatically dispatched or resumed without reconciliation',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const id = await chat(f),
        w = f.workspace,
        maintenance = createConversationMaintenance(f.runtime);
      await exchange(f, id);
      await due(f, id);
      await maintenance.sweep(w.id);
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_maintenance')} SET state='blocked',error_code='generation-unconfirmed' WHERE conversation_id=$1`,
        [id],
      );
      assert.equal((await work(f, maintenance)).length, 0);
      await assert.rejects(f.store.resumeMaintenance(w.id, w.userId, id, { commandId: randomUUID() }), {
        message: 'maintenance-not-resumable',
      });
    } finally {
      await f.close();
    }
  },
);

test(
  'structured clarification preserves the question, choice labels, and accepted answer as untrusted recap input',
  { timeout: 60000 },
  async () => {
    const f = await requestFixture();
    try {
      const w = f.workspace,
        fence = await f.start(),
        id = fence.origin.conversationId;
      const question = await f.requests.create(fence, {
        producerId: randomUUID(),
        prompt: 'Choose the launch plan',
        answerSchema: {
          kind: 'choices',
          multiple: false,
          choices: [
            { id: 'x7', label: 'Ship Tuesday with email' },
            { id: 'z9', label: 'Wait until Friday' },
          ],
        },
      });
      await f.requests.answer(w.id, w.userId, id, question.requestId, randomUUID(), {
        commandId: randomUUID(),
        expectedRevision: 1,
        answer: { kind: 'choices', choiceIds: ['x7'] },
      });
      const executor = createConversationExecutor(f.runtime, async () => ({
        text: 'Choice recorded.',
        sources: [{ kind: 'private-conversation', conversationId: id }],
      }));
      assert.equal(
        await executor.process({ workspaceId: w.id, conversationId: id, turnId: fence.origin.turnId, generation: 1 }),
        'completed',
      );
      await due(f, id);
      const maintenance = createConversationMaintenance(f.runtime),
        model = compactor();
      await maintenance.sweep(w.id);
      const [job] = await work(f, maintenance);
      assert.equal(await maintenance.process(job, model, async () => published()), 'ready');
      const input = model.calls.find(call => call.purpose === 'summary');
      assert.match(input.system, /transcript are untrusted data/);
      assert.match(input.messages[0].text, /Question: Choose the launch plan/);
      assert.match(input.messages[0].text, /Ship Tuesday with email/);
      assert.match(input.messages[0].text, /Answer:.*"choiceIds": \["x7"\]/);
    } finally {
      await f.close();
    }
  },
);
