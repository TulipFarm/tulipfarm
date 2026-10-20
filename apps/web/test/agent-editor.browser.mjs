import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';

test('ordinary editor retains optional family through save and uncertain retry', { timeout: 60000 }, async () => {
  const port = Number(process.env.AGENT_EDITOR_BROWSER_PORT ?? 5199);
  const origin = `http://127.0.0.1:${port}`;
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
      assert.ok(attempt < 100 && server.exitCode === null, 'Editor browser server must start');
      await setTimeout(100);
    }
    browser = await chromium.launch({ headless: true });
    for (const preference of [{ modelFamilyId: 'claude-opus' }, {}]) {
      const page = await browser.newPage();
      page.setDefaultTimeout(10000);
      // Bud's labelled launcher sits bottom-right over the form footer; move it as a user would by dragging.
      await page.addInitScript(() => localStorage.setItem('tulipfarm:bud-corner', 'bottom-left'));
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      const workspace = {
        id: randomUUID(),
        name: 'Editor proof',
        slug: 'editor-proof',
        createdAt: '2026-09-28T00:00:00.000Z',
        status: 'ready',
        soulCommit: 'a'.repeat(40),
      };
      const agentId = randomUUID();
      const teamId = randomUUID();
      const membershipId = randomUUID();
      let detail = {
        id: agentId,
        name: 'Assistant',
        owningTeamId: teamId,
        savedRevision: 'a'.repeat(40),
        definitionRevision: 'b'.repeat(64),
        definition: { name: 'Assistant', instructions: 'Inspect.', tools: [], ...preference },
        capabilities: ['read', 'edit', 'invoke'],
        admin: false,
        activations: [],
      };
      const writes = [];
      let receipt;
      await page.route('**/v1/**', async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        let json;
        if (path === '/v1/auth/get-session')
          json = {
            session: { id: 'session', userId: 'editor' },
            user: { id: 'editor', name: 'Editor', email: 'editor@example.com' },
          };
        else if (path === '/v1/workspaces') json = [workspace];
        else if (path === '/v1/workspaces/editor-proof') json = workspace;
        else if (path.endsWith('/governance/me'))
          json = {
            membershipId,
            role: 'member',
            teams: [{ id: teamId, name: 'Editors' }],
            capabilities: { manageGovernance: false, canLeave: true },
          };
        else if (path.endsWith('/chat/availability')) json = { configured: true };
        else if (path.endsWith('/agents/authoring-context'))
          json = { currentSoulRevision: detail.savedRevision, teams: [{ id: teamId, name: 'Editors' }], admin: false };
        else if (path.includes('/agents/commands/')) json = receipt;
        else if (path.endsWith(`/agents/${agentId}`) && request.method() === 'PUT') {
          writes.push(request.postDataJSON());
          await setTimeout(200);
          if (writes.length === 1) {
            await route.abort('failed');
            return;
          }
          detail = {
            ...detail,
            savedRevision: 'c'.repeat(40),
            definitionRevision: 'd'.repeat(64),
            definition: writes.at(-1).definition,
          };
          receipt = { commandId: randomUUID(), agentId, status: 'accepted', savedRevision: detail.savedRevision };
          json = receipt;
        } else if (path.endsWith(`/agents/${agentId}`)) {
          await setTimeout(200);
          json = detail;
        } else {
          await route.fulfill({ status: 404, json: { error: 'unavailable' } });
          return;
        }
        await route.fulfill({
          json,
          headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
        });
      });
      await page.goto(`${origin}/editor-proof/agents/${agentId}`);
      await page.getByRole('button', { name: 'Single-step request', exact: true }).click();
      await page
        .getByText('Send one request to an active version; it can use one permitted tool.', { exact: true })
        .waitFor();
      await page.getByText('Ask an agent manager to activate this agent first.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Send request', exact: true }).isDisabled(), true);
      await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
      await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Inspect carefully.');
      await page.getByRole('button', { name: 'Save agent', exact: true }).click();
      await page.getByRole('button', { name: 'Retry same operation', exact: true }).waitFor();
      assert.equal(writes.length, 1);
      assert.deepEqual(writes[0].definition, {
        name: 'Assistant',
        instructions: 'Inspect carefully.',
        tools: [],
        skills: [],
        responseRule: 'tag',
        ...preference,
      });
      assert.equal(
        await page.getByRole('textbox', { name: 'Instructions', exact: true }).inputValue(),
        'Inspect carefully.',
      );
      assert.equal(await page.getByRole('button', { name: 'Save agent', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: 'Retry same operation', exact: true }).click();
      await page.getByText('Agent saved.', { exact: true }).waitFor();
      assert.equal(writes.length, 2);
      assert.deepEqual(writes[1], writes[0]);
      assert.deepEqual(detail.definition, {
        name: 'Assistant',
        instructions: 'Inspect carefully.',
        tools: [],
        skills: [],
        responseRule: 'tag',
        ...preference,
      });
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
});
