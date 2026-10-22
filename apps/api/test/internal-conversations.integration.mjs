import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { authenticatedFixture } from './auth-fixture.mjs';
import { registerConversations } from '../src/conversations.ts';
import { registerAgents } from '../src/agents.ts';
import { createInternalConversations } from '../../../packages/conversations/src/internal.ts';
import { internalFixture } from '../../../packages/conversations/test/internal-fixture.mjs';

test(
  'real human sessions cannot reach internal history or linked legacy chat results',
  { timeout: 60000 },
  async () => {
    let authenticated;
    const f = await internalFixture(undefined, async db => {
      authenticated = await authenticatedFixture(db);
      return { userId: authenticated.owner.id, close: () => authenticated.identity.end() };
    });
    const app = Fastify();
    try {
      const { db, table, workspace: w } = f;
      await authenticated.addAdmin(w);
      const identity = authenticated.identity;
      const { auth, owner, admin } = authenticated;
      const run = await f.run();
      const { callId: _callId, ...input } = run;
      const internal = createInternalConversations(f.runtime);
      const fence = await internal.claim(input);
      await internal.append(fence, {
        producerId: randomUUID(),
        parts: [{ kind: 'text', text: 'never-human-visible' }],
      });
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_chat_turns')} (id,prompt,status,decision) VALUES ($1,'hidden','answered',$2)`,
        [run.runId, { kind: 'answer', text: 'never-human-visible' }],
      );
      const legacy = await f.run();
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_chat_turns')} (id,prompt,status,decision) VALUES ($1,'legacy','answered',$2)`,
        [legacy.runId, { kind: 'answer', text: 'Still readable.' }],
      );
      await app.register(
        async routes => {
          registerConversations(routes, { auth, service: f.store });
          registerAgents(routes, { auth, runtime: f.runtime, pool: identity, agentModel: null });
        },
        { prefix: '/v1' },
      );
      const base = `/v1/workspaces/${w.id}`;
      for (const human of [owner, admin]) {
        for (const path of [
          `/conversations/${run.runId}`,
          `/conversations/${run.runId}/messages`,
          `/conversations/${run.runId}/changes`,
          `/internal-conversations/${run.runId}`,
          `/agents/${f.agentId}/chat/${run.runId}`,
        ]) {
          const response = await app.inject({
            method: 'GET',
            url: `${base}${path}`,
            headers: { cookie: human.cookie },
          });
          assert.equal(response.statusCode, 404, response.body);
          assert.equal(response.body.includes('never-human-visible'), false);
        }
        const response = await app.inject({
          method: 'GET',
          url: `${base}/conversations`,
          headers: { cookie: human.cookie },
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.includes(run.runId), false);
      }
      const response = await app.inject({
        method: 'GET',
        url: `${base}/agents/${f.agentId}/chat/${legacy.runId}`,
        headers: { cookie: owner.cookie },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().text, 'Still readable.');
    } finally {
      await app.close();
      await f.close();
    }
  },
);
