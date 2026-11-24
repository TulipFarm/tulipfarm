import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserSessionId } from '@tulipfarm/browser';
import { saveBackBrowserLogins } from '../dist/browser-logins.js';

const workspaceId = '6f1e2d3c-4b5a-4968-8776-655443322110';
const conversationId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const actor = { kind: 'human', userId: 'user-1' };
const fresh = '9c8b7a6d-5e4f-4321-8fed-cba987654321';
const signedOut = '8b7a6d5e-4f3c-4210-9edc-ba9876543210';
const failing = '7a6d5e4f-3c2b-4109-8dcb-a98765432109';

function fakes({ logins = [], enabled = true, state } = {}) {
  const saves = [];
  const reads = [];
  const client = {
    state: async sessionId => {
      reads.push(['state', sessionId]);
      if (state instanceof Error) throw state;
      return state ?? { logins };
    },
    siteState: async (sessionId, site) => {
      reads.push(['site', sessionId, site]);
      return { cookies: [{ name: 'sid', domain: site }], origins: [] };
    },
  };
  const service = {
    capabilities: () => ({ enabled }),
    saveBack: async (workspace, who, input) => {
      saves.push({ workspace, who, input });
      if (input.id === failing) throw new Error('storage unavailable');
      return 'saved';
    },
  };
  return { client, service, saves, reads };
}

const run = ({ client, service }) =>
  saveBackBrowserLogins({
    client,
    logins: service,
    workspaceId,
    sessionId: browserSessionId(workspaceId, { conversationId }),
    actor,
  });

test('saves each loaded login back as the requester and marks signed-out ones', async () => {
  const f = fakes({
    logins: [
      { id: fresh, site: 'shop.example', signedOut: false },
      { id: failing, site: 'mail.example', signedOut: false },
      { id: signedOut, site: 'bank.example', signedOut: true },
    ],
  });
  await run(f);
  const sessionId = browserSessionId(workspaceId, { conversationId });
  assert.deepEqual(f.reads, [
    ['state', sessionId],
    ['site', sessionId, 'shop.example'],
    ['site', sessionId, 'mail.example'],
  ]);
  assert.deepEqual(
    f.saves.map(({ workspace, who, input }) => [workspace, who, input]),
    [
      [
        workspaceId,
        actor,
        { id: fresh, signedOut: false, state: { cookies: [{ name: 'sid', domain: 'shop.example' }], origins: [] } },
      ],
      [
        workspaceId,
        actor,
        { id: failing, signedOut: false, state: { cookies: [{ name: 'sid', domain: 'mail.example' }], origins: [] } },
      ],
      [workspaceId, actor, { id: signedOut, signedOut: true }],
    ],
    'one failing login does not stop the others',
  );
});

test('does nothing when logins are off, and never throws when the browser is unreachable', async () => {
  const off = fakes({ enabled: false, logins: [{ id: fresh, site: 'shop.example', signedOut: false }] });
  await run(off);
  assert.deepEqual(off.reads, []);
  const gone = fakes({ state: new Error('browser host unreachable') });
  await run(gone);
  assert.deepEqual(gone.saves, []);
});
