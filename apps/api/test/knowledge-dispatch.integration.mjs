import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createLocalKnowledge } from '@tulipfarm/knowledge';
import { dispatchKnowledge, registerKnowledgeDispatch } from '../dist/knowledge-dispatch.js';
import { createKnowledgeActivities } from '../../worker/dist/knowledge-activities.js';
import { knowledgeFixture } from './knowledge-fixture.mjs';

test('SQL discovery recovers missing starts, lost acknowledgements, and expired leases without browser reads', async () => {
  const f = await knowledgeFixture();
  try {
    const input = f.command(),
      id = randomUUID();
    assert.equal((await f.save(id, input)).status, 200);
    const work = { workspaceId: f.workspace.id, revisionId: input.commandId, generation: 1 };
    await assert.rejects(
      dispatchKnowledge(f.service, f.workspace.id, async () => {
        throw new Error('Temporal offline');
      }),
      /offline/,
    );
    assert.deepEqual(await f.service.due(f.workspace.id), [work]);
    const started = [];
    const start = async value => {
      started.push(value);
    };
    await assert.rejects(
      dispatchKnowledge(
        {
          due: f.service.due,
          acknowledge: async () => {
            throw new Error('API stopped after start');
          },
        },
        f.workspace.id,
        start,
      ),
      /API stopped/,
    );
    const restarted = createLocalKnowledge({ runtime: f.runtime, files: f.files });
    await dispatchKnowledge(restarted, f.workspace.id, start);
    assert.deepEqual(started, [work, work]);
    assert.deepEqual(await restarted.due(f.workspace.id), []);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_knowledge_jobs')} SET dispatch_after=clock_timestamp()-interval '1 second' WHERE revision_id=$1`,
      [input.commandId],
    );
    const generationTwo = { ...work, generation: 2 };
    assert.deepEqual(await restarted.due(f.workspace.id), [generationTwo]);
    assert.deepEqual(await restarted.process(work), { disposition: 'stale' });
    await f.db.platform.query(
      `UPDATE ${f.table('tf_knowledge_jobs')} SET lease_token=$2,lease_until=clock_timestamp()-interval '1 second' WHERE revision_id=$1`,
      [input.commandId, randomUUID()],
    );
    await f.db.platform.query(
      `UPDATE ${f.table('tf_knowledge_work')} SET parsing='parsing',attempts=1 WHERE revision_id=$1`,
      [input.commandId],
    );
    const generationThree = { ...work, generation: 3 };
    assert.deepEqual(await restarted.due(f.workspace.id), [generationThree]);
    const activities = createKnowledgeActivities(f.runtime, f.object.adapter);
    await dispatchKnowledge(restarted, f.workspace.id, activities.processKnowledge);
    assert.equal((await restarted.get(f.workspace.id, f.signed.owner.id, id)).parsing, 'ready');
    assert.match(
      (await restarted.search(f.workspace.id, f.signed.owner.id, { query: 'returns' })).hits[0].text,
      /thirty days/,
    );
    assert.deepEqual(await restarted.due(f.workspace.id), []);
  } finally {
    await f.close();
  }
});

test('background sweep starts durable saved work on API restart without an HTTP read', async () => {
  const f = await knowledgeFixture();
  let dispatcher;
  try {
    const input = f.command(),
      id = randomUUID();
    assert.equal((await f.save(id, input)).status, 200);
    await f.db.platform.query(
      "UPDATE app.workspace_storage SET stage='ready', runtime_credential='{}', migration_credential='{}', confirmation_credential='{}' WHERE workspace_id=$1",
      [f.workspace.id],
    );
    await f.app.close();
    dispatcher = Fastify();
    const started = [];
    const activities = createKnowledgeActivities(f.runtime, f.object.adapter);
    let finish;
    const done = new Promise(resolve => {
      finish = resolve;
    });
    registerKnowledgeDispatch(dispatcher, {
      pool: f.db.platform,
      service: f.service,
      temporal: {
        connection: { withDeadline: async (_deadline, operation) => operation() },
        client: {
          workflow: {
            start: async (name, options) => {
              started.push({ name, ...options });
              await activities.processKnowledge(options.args[0]);
              finish();
            },
          },
        },
      },
    });
    await dispatcher.ready();
    await Promise.race([
      done,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Background dispatch did not process saved work')), 30000);
        timer.unref();
      }),
    ]);
    await dispatcher.close();
    dispatcher = undefined;
    assert.equal(started.length, 1);
    assert.equal(started[0].name, 'knowledgeIngest');
    assert.equal(started[0].workflowId, `knowledge-${f.workspace.id}-${input.commandId}-1`);
    assert.equal(started[0].workflowIdConflictPolicy, 'USE_EXISTING');
    assert.equal(started[0].workflowIdReusePolicy, 'REJECT_DUPLICATE');
    assert.deepEqual(started[0].args, [{ workspaceId: f.workspace.id, revisionId: input.commandId, generation: 1 }]);
    assert.equal((await f.service.get(f.workspace.id, f.signed.owner.id, id)).parsing, 'ready');
  } finally {
    await dispatcher?.close();
    await f.close();
  }
});
