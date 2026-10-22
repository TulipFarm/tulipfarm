import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

test('personal agent creation and manager sharing retain inputs across failures', { timeout: 90000 }, async () => {
  const port = 5299,
    origin = `http://127.0.0.1:${port}`;
  const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
  });
  let browser;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        if ((await fetch(origin)).ok) break;
      } catch {}
      assert.ok(attempt < 100 && server.exitCode === null);
      await setTimeout(100);
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    const { workspace, session } = createWorkspaceFixture({ slug: 'agent-boundaries', name: 'Agent boundaries' });
    const membershipId = randomUUID(),
      peer = randomUUID();
    let agentId,
      definition,
      receipt,
      failCandidates = true;
    const writes = [],
      shares = [];
    const policy = {
      version: 0,
      owningTeamId: null,
      grants: [],
      personGrants: [{ membershipId, permissions: ['manage'] }],
      enrollment: [],
      enabled: false,
      limits: [],
    };
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/v1/**', async route => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      let json;
      if (path === '/v1/auth/get-session') json = session;
      else if (path === '/v1/workspaces') json = [workspace];
      else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
      else if (path.endsWith('/governance/me'))
        json = { membershipId, role: 'member', teams: [], capabilities: { manageGovernance: false, canLeave: true } };
      else if (path.endsWith('/agents/authoring-context')) {
        await setTimeout(150);
        json = { currentSoulRevision: 'a'.repeat(40), teams: [], admin: false };
      } else if (path.endsWith('/agents/sharing-candidates')) {
        await setTimeout(150);
        if (failCandidates) {
          await route.fulfill({ status: 503, json: { error: 'unavailable' } });
          return;
        }
        json = {
          membershipId,
          people: [
            { membershipId, userId: 'ada', name: 'Ada', email: 'ada@example.test' },
            { membershipId: peer, userId: 'peer', name: 'Robin', email: 'robin@example.test' },
          ],
          teams: [],
        };
      } else if (path.includes('/agents/setup-commands/')) json = receipt;
      // New agents are created through the setup builder: stage a draft, then publish it (cloud 3e124b0f #1004, features/agents/builder.tsx:69-73, api.ts:59-62).
      else if (path.endsWith('/setup-draft') && request.method() === 'GET') {
        await route.fulfill({ status: 404, json: { error: 'setup-draft-not-found' } });
        return;
      } else if (path.endsWith('/setup-draft') && request.method() === 'PUT') {
        const body = request.postDataJSON();
        writes.push(body.setup);
        agentId = path.split('/').at(-2);
        definition = body.setup.definition;
        const { requestId: _request, expectedVersion: _version, ...expected } = body;
        json = { agentId, version: 1, digest: 'b'.repeat(64), commandId: null, ...expected };
      } else if (path.endsWith('/setup') && request.method() === 'POST') {
        assert.equal(request.postDataJSON().decision, 'save');
        receipt = {
          commandId: randomUUID(),
          agentId,
          version: 1,
          digest: 'b'.repeat(64),
          status: 'saved',
          savedRevision: 'c'.repeat(40),
          activationId: null,
          error: null,
        };
        json = receipt;
      } else if (path.endsWith('/policy') && request.method() === 'PUT') {
        shares.push(request.postDataJSON());
        Object.assign(policy, shares.at(-1), { version: policy.version + 1 });
        json = { saved: true };
      } else if (path.endsWith('/policy')) json = policy;
      else if (agentId && path.endsWith(`/agents/${agentId}`))
        json = {
          id: agentId,
          name: definition.name,
          owningTeamId: null,
          savedRevision: 'c'.repeat(40),
          definitionRevision: 'b'.repeat(64),
          definition,
          capabilities: ['edit', 'delete', 'invoke', 'manage'],
          admin: true,
          activations: [],
        };
      else if (path.endsWith('/skills')) json = { workspace: [], nextCursor: null };
      else {
        await route.fulfill({ status: 404, json: { error: 'unavailable' } });
        return;
      }
      await route.fulfill({ json });
    });
    await page.goto(`${origin}/${workspace.slug}/agents/new`);
    await page.getByLabel('Agent name', { exact: true }).fill('Personal helper');
    await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Use only my permitted data.');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    // A saved draft offers Continue editing rather than a link to the agent (cloud builder.tsx:37,179,184).
    await page.getByText('Draft saved. Slack channels and schedules are not started.', { exact: true }).waitFor();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].owningTeamId, null);
    await page.goto(`${origin}/${workspace.slug}/agents/${agentId}`);
    await page.getByRole('tab', { name: 'Access', exact: true }).click();
    const sharing = page.getByRole('region', { name: 'Definition sharing', exact: true });
    await sharing.getByRole('button', { name: 'Check access again', exact: true }).waitFor();
    failCandidates = false;
    await sharing.getByRole('button', { name: 'Check access again', exact: true }).click();
    await sharing.getByText('robin@example.test', { exact: true }).waitFor();
    const robin = sharing
      .locator('div')
      .filter({ has: page.getByText('robin@example.test', { exact: true }) })
      .filter({ has: page.getByRole('checkbox', { name: 'invoke', exact: true }) })
      .last();
    assert.equal(await robin.count(), 1, await sharing.ariaSnapshot());
    await robin.getByRole('checkbox', { name: 'invoke', exact: true }).check();
    await page.getByRole('button', { name: 'Save sharing', exact: true }).click();
    await page.getByText('Administration saved.', { exact: true }).waitFor();
    assert.equal(shares.length, 1);
    assert.deepEqual(shares[0].personGrants.find(grant => grant.membershipId === peer).permissions.sort(), [
      'invoke',
      'read',
    ]);
    assert.ok(shares[0].personGrants.find(grant => grant.membershipId === membershipId).permissions.includes('manage'));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
});
