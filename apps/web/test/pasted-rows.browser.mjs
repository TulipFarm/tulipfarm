import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createWorkspaceFixture, workspaceShellReads, serveWorkspaceShellEvent } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';

test(
  'one batch review names every pasted row and orders its fields by the table schema',
  { timeout: 180000 },
  async () => {
    const port = Number(process.env.PASTED_ROWS_BROWSER_PORT ?? 5789);
    const origin = `http://127.0.0.1:${port}`;
    const { workspace, session } = createWorkspaceFixture({ slug: 'pasted-rows', name: 'Pasted rows' });
    const shellReads = new Map(workspaceShellReads(workspace.id));
    const chatId = randomUUID(),
      turnId = randomUUID(),
      proposalId = randomUUID(),
      membershipId = randomUUID(),
      tableId = randomUUID();
    const name = { id: randomUUID(), label: 'Name', kind: 'text', required: true, maxLength: 200 };
    const status = {
      id: randomUUID(),
      label: 'Status',
      kind: 'single-select',
      required: false,
      options: [{ id: randomUUID(), label: 'Done', retired: false }],
    };
    const due = { id: randomUUID(), label: 'Due', kind: 'date', required: false };
    const definition = {
      formatVersion: 2,
      id: tableId,
      owningTeamId: randomUUID(),
      label: 'Tasks',
      fields: [name, status, due],
      uniqueKeys: [],
    };
    const revision = 'a'.repeat(40),
      digest = 'b'.repeat(64);
    const effects = ['sample-golf', 'sample-hotel'].map(value => ({
      recordId: randomUUID(),
      kind: 'create',
      before: null,
      after: {
        [due.id]: null,
        [status.id]: { kind: 'single-select', optionId: status.options[0].id },
        [name.id]: { kind: 'text', value },
      },
    }));
    const plan = {
      input: {
        kind: 'records',
        tableId,
        dependsOn: [],
        expectedRevision: revision,
        changes: effects.map(effect => ({ kind: 'create', recordId: effect.recordId, values: effect.after })),
      },
      before: definition,
      after: definition,
      effectCount: 2,
      effectsDigest: digest,
      freshnessDigest: digest,
      audience: null,
      importSources: [],
    };
    const view = {
      id: proposalId,
      digest,
      status: 'pending',
      decision: null,
      cancelled: false,
      expired: false,
      plans: [{ tableId, receipt: null, importProgress: null }],
      content: 'available',
      freshness: 'current',
      manifest: {
        version: 1,
        id: proposalId,
        workspaceId: workspace.id,
        requester: { kind: 'human', userId: session.user.id, membershipId },
        conversationId: chatId,
        turnId,
        sources: [],
        expiresAt: '2099-11-11T00:00:00Z',
        plans: [plan],
      },
    };
    const server = spawn(
      process.execPath,
      ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      { cwd: new URL('..', import.meta.url), stdio: 'ignore' },
    );
    let browser, page;
    try {
      for (
        let attempt = 0;
        !(await fetch(origin).then(
          response => response.ok,
          () => false,
        ));
        attempt++
      ) {
        assert.ok(attempt < 150 && server.exitCode === null, 'Vite starts');
        await delay(100);
      }
      browser = await chromium.launch({
        args: process.env.PASTED_ROWS_SCREENSHOT ? ['--remote-debugging-port=9569'] : [],
      });
      page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(45000);
      page.setDefaultNavigationTimeout(90000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/v1/**', async route => {
        if (await serveWorkspaceShellEvent(route, workspace)) return;
        const path = new URL(route.request().url()).pathname;
        let json;
        if (shellReads.has(path)) json = shellReads.get(path);
        else if (path === '/v1/auth/get-session') json = session;
        else if (path === '/v1/user/visit') json = { firstSession: false };
        else if (path === '/v1/workspaces') json = [workspace];
        else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
        else if (path.endsWith('/governance/me'))
          json = { membershipId, role: 'member', teams: [], capabilities: { manageGovernance: false, canLeave: true } };
        else if (path.endsWith('/model-catalog')) json = chatCatalog;
        else if (path.endsWith('/system-package-installations')) json = { installations: [], nextCursor: null };
        else if (path.includes('/table-changes/')) {
          if (path.endsWith('/outcome')) json = { kind: 'proposal' };
          else if (path.endsWith('/effects'))
            json = {
              digest,
              items: effects.map((effect, ordinal) => ({ ordinal, effect })),
              total: 2,
              nextCursor: null,
            };
          else json = view;
        } else if (path.endsWith('/messages'))
          json = {
            messages: [
              {
                id: turnId,
                sequence: 1,
                author: 'human',
                createdAt: workspace.createdAt,
                parts: [
                  {
                    kind: 'text',
                    text: 'Import these rows into Tasks:\nName,Status,Due\nsample-golf,done,\nsample-hotel,done,',
                  },
                ],
                turn: { id: turnId, status: 'completed', generation: 0 },
                tools: [
                  {
                    id: proposalId,
                    tool: 'tables.propose',
                    status: 'completed',
                    activityStatus: 'waiting',
                    tableProposal: true,
                  },
                ],
              },
            ],
            nextBefore: null,
            hasGitHubProposals: false,
          };
        else if (path.endsWith(`/conversations/${chatId}`))
          json = {
            id: chatId,
            title: 'Pasted task rows',
            titleRevision: 1,
            archived: false,
            activityAt: workspace.createdAt,
            createdAt: workspace.createdAt,
          };
        else return route.fulfill({ status: 404, json: { error: 'not-found' } });
        return route.fulfill({ json });
      });
      await page.goto(`${origin}/${workspace.slug}/chat/${chatId}`);
      await page.getByRole('button', { name: 'Review changes', exact: true }).click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          button => button.textContent === 'Approve exact changes' && !button.disabled,
        ),
      );
      await page.getByRole('button', { name: 'Row effects · Tasks (2)', exact: true }).click();
      await page.getByRole('heading', { name: /^Create sample-golf(?: ·|$)/ }).waitFor();
      await page.getByRole('heading', { name: /^Create sample-hotel(?: ·|$)/ }).waitFor();
      assert.equal(await page.getByRole('heading', { name: /^Create sample-/ }).count(), 2);
      for (const ordinal of [0, 1]) {
        const grid = page.getByRole('table', { name: `Field changes for row ${ordinal}`, exact: true });
        const labels = await grid
          .getByRole('row')
          .evaluateAll(rows => rows.slice(1).map(row => row.querySelector('td')?.textContent));
        assert.deepEqual(labels, ['Name', 'Status', 'Due']);
        assert.ok((await grid.textContent()).includes('Done'));
      }
      if (process.env.PASTED_ROWS_SCREENSHOT) {
        await page
          .getByRole('heading', { name: /^Create sample-golf(?: ·|$)/ })
          .evaluate(heading => heading.scrollIntoView({ block: 'start' }));
        await page
          .getByRole('region', { name: 'Table change proposal', exact: true })
          .screenshot({ path: process.env.PASTED_ROWS_SCREENSHOT });
        await delay(20000);
      }
      assert.deepEqual(errors, []);
    } catch (error) {
      if (page) {
        console.error(await page.locator('body').innerText());
        await page.screenshot({ path: '/tmp/pasted-rows-browser-failure.png', fullPage: true });
      }
      throw error;
    } finally {
      await browser?.close();
      if (server.exitCode === null && server.signalCode === null) {
        server.kill('SIGTERM');
        await new Promise(resolve => server.once('exit', resolve));
      }
    }
  },
);
