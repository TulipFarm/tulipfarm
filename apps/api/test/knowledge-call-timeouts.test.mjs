import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { defaultCallTimeoutMs } from '@tulipfarm/config/timeouts';
import { registerKnowledge } from '../dist/knowledge.js';

for (const kind of ['search', 'citation'])
  for (const expires of [false, true]) {
    test(`${kind} HTTP ${expires ? 'expires and cancels at' : 'can complete beyond the old cutoff within'} the shared minute`, async t => {
      const app = Fastify();
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      let timing;
      const run = async (deadlineAt, signal, result) => {
        timing = { deadlineAt, signal };
        entered.resolve();
        await release.promise;
        return result;
      };
      registerKnowledge(app, {
        auth: { api: { getSession: async () => ({ user: { id: 'owner' } }) } },
        service: {},
        embeddings: {},
        search: {
          search: (_workspace, _user, _input, deadlineAt, signal) =>
            run(deadlineAt, signal, {
              hits: [],
              continuation: null,
              mode: 'keyword-only',
              reason: 'no-semantic-content',
              coverage: 'keyword-only',
              bounded: true,
              validUntil: '2027-01-15T08:05:00.000Z',
            }),
          close: async () => {},
        },
        citations: {
          read: (_workspace, _user, citationId, context) =>
            run(context.deadlineAt, context.signal, {
              result: {
                citationId,
                title: 'Supplier policy',
                heading: '',
                text: 'Evidence',
                truncated: false,
                source: 'note',
              },
              sources: [],
            }),
        },
      });
      await app.ready();
      const now = 1_800_000_000_000;
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
      const base = `/workspaces/${randomUUID()}/knowledge`;
      let settled = false;
      const response = app
        .inject(
          kind === 'search'
            ? {
                method: 'POST',
                url: `${base}/search`,
                headers: { origin: 'http://localhost:5173' },
                payload: { kind: 'submitted', commandId: randomUUID(), query: 'supplier' },
              }
            : { url: `${base}/citations/${randomUUID()}:0` },
        )
        .then(value => {
          settled = true;
          return value;
        });
      try {
        await entered.promise;
        assert.equal(timing.deadlineAt, now + defaultCallTimeoutMs);
        t.mock.timers.tick(expires ? defaultCallTimeoutMs - 1 : 20_000);
        await setImmediate();
        assert.equal(settled, false);
        assert.equal(timing.signal.aborted, false);
        if (expires) {
          t.mock.timers.tick(1);
          const result = await response;
          assert.equal(result.statusCode, 503, result.body);
          assert.equal(result.json().error, 'knowledge-unavailable');
          assert.equal(timing.signal.aborted, true);
          assert.equal(timing.signal.reason.code, 'wait_timeout');
        } else {
          release.resolve();
          const result = await response;
          assert.equal(result.statusCode, 200, result.body);
          await setImmediate();
          t.mock.timers.tick(defaultCallTimeoutMs);
          assert.equal(timing.signal.aborted, false, 'completion clears the timeout');
        }
      } finally {
        release.resolve();
        await setImmediate();
        t.mock.timers.reset();
        await app.close();
      }
    });
  }
