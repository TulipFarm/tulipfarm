import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { governanceSnapshot } from './governance-snapshot.mjs';

const port = Number(process.env.VISUAL_PORT ?? 5337);
const origin = `http://127.0.0.1:${port}`;
const before = process.env.VISUAL_BEFORE === '1';
const capture = process.env.VISUAL_SCREENSHOTS;
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'inherit',
});
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  name: 'Acme',
  status: 'ready',
  createdAt: '2026-09-30T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
const teamId = '33333333-3333-4333-8333-333333333333';
const memberId = '22222222-2222-4222-8222-222222222222';
const teams = [{ id: teamId, name: 'Operations', description: 'Customer operations', membershipIds: [memberId] }];
const modes = [
  { name: 'desktop-light', width: 1440, height: 1000, theme: 'light' },
  { name: 'desktop-dark', width: 1440, height: 1000, theme: 'dark' },
  { name: 'mobile-light', width: 390, height: 844, theme: 'light', mobile: true },
  { name: 'mobile-dark', width: 390, height: 844, theme: 'dark', mobile: true },
  { name: 'zoom-light', width: 720, height: 500, theme: 'light' },
];
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    if (
      await fetch(origin).then(
        response => response.ok,
        () => false,
      )
    )
      break;
    assert.ok(attempt < 100, 'Vite starts');
    await delay(100);
  }
  browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port + 4000}`] });
  for (const mode of modes) {
    const context = await browser.newContext({
      viewport: { width: mode.width, height: mode.height },
      isMobile: !!mode.mobile,
      hasTouch: !!mode.mobile,
      reducedMotion: 'reduce',
      colorScheme: mode.theme,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    let workflowsState = 'ready';
    let releaseRead;
    let failedWorkflowReads = 0;
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let json;
      if (path === '/v1/auth/get-session')
        json = {
          session: { id: 'session-ada', userId: 'ada' },
          user: { id: 'ada', name: 'Ada', email: 'ada@example.com' },
        };
      else if (path === '/v1/workspaces') json = [workspace];
      else if (path === '/v1/workspaces/acme') json = workspace;
      else if (path.endsWith('/credits'))
        json = { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] };
      else if (path.endsWith('/settings'))
        json = { workspaceId: workspace.id, name: workspace.name, slug: workspace.slug, revision: 1, canManage: true };
      else if (path.endsWith('/personal-memory'))
        json = { content: 'Use concise answers and include next steps.', revision: 1 };
      else if (path.endsWith('/governance/me'))
        json = {
          membershipId: memberId,
          role: 'admin',
          teams,
          capabilities: { manageGovernance: true, canLeave: true },
        };
      else if (path.endsWith('/governance'))
        json = governanceSnapshot({
          actorMembershipId: memberId,
          members: [{ id: memberId, userId: 'ada', name: 'Ada', email: 'ada@example.com', role: 'admin' }],
          teams,
          resources: [],
          grants: [],
        });
      else if (path.endsWith('/invitations')) json = [];
      else if (path.endsWith('/workflows')) {
        if (workflowsState === 'loading')
          await new Promise(resolve => {
            releaseRead = resolve;
          });
        if (workflowsState === 'error') {
          failedWorkflowReads += 1;
          return route.fulfill({ status: 503, json: { error: 'unavailable' } });
        }
        json = [];
      } else if (path.endsWith('/agents/authoring-context'))
        json = { currentSoulRevision: 'a'.repeat(40), teams: teams.map(({ id, name }) => ({ id, name })), admin: true };
      else if (path.endsWith('/agents')) json = { agents: [], count: 0, nextCursor: null };
      else if (path.endsWith('/tables/authoring-context'))
        json = {
          currentSoulRevision: 'a'.repeat(40),
          savedDefinition: null,
          appliedDefinition: null,
          teams: teams.map(({ id, name }) => ({ id, name })),
          capabilities: {
            manageSchema: true,
            createRecord: true,
            readRecords: true,
            updateRecord: true,
            deleteRecord: true,
            confirmMigration: true,
          },
        };
      else if (path.endsWith('/tables')) json = { tables: [], total: 0, nextCursor: null };
      else if (path.endsWith('/conversations'))
        json = {
          chats: [
            {
              id: teamId,
              title: 'Plan customer follow-ups',
              titleRevision: 0,
              archived: false,
              activityAt: workspace.createdAt,
              createdAt: workspace.createdAt,
            },
          ],
          nextCursor: null,
        };
      else if (path.endsWith('/skills')) json = { workspace: [], nextCursor: null };
      else if (path.endsWith('/agent-tasks')) json = { tasks: [], nextCursor: null };
      else return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      await route.fulfill({ json });
    });
    async function screenshot(name) {
      if (!capture || mode.name === 'zoom-light') return;
      await page.evaluate(() => document.fonts.ready);
      execFileSync(
        'agent-browser',
        [
          '--session',
          `visual-${port}`,
          '--cdp',
          String(port + 4000),
          'screenshot',
          `${capture}/${before ? 'before' : 'after'}-${mode.name}-${name}.png`,
        ],
        { stdio: 'inherit' },
      );
    }
    async function noOverflow() {
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `${mode.name} has no document overflow`,
      );
      if (!before) {
        for (const container of await page.locator('[data-slot="page-content"]').all()) {
          assert.equal(
            await container.evaluate(node => node.scrollWidth <= node.clientWidth),
            true,
            `${mode.name} has no page-content overflow`,
          );
        }
      }
    }
    const layout = [];
    for (const [path, heading, ready, shot] of [
      ['settings', 'General', 'Workspace identity', 'settings'],
      ['workflows', 'Workflows', 'New workflow', 'workflows'],
      ['agents', 'Agents', 'No agents yet'],
      ['agents/new', 'New agent', 'Instructions'],
      // Cloud 900060fb #681 (features/tables/tables.tsx:52) rewrote the tables description; 5e9daa6e #880 (pages/tables.tsx:34)
      // made tables/new a chat handoff; 9bb986c8 #808 redirects skills/new to chat, so it has no page of its own.
      ['tables', 'Tables', 'Read active fields and edit business rows. Schema changes are reviewed in chat.'],
      ['tables/new', 'Create a table', 'Build tables in chat'],
      ['skills', 'Skills', 'Workspace skills'],
      ['agent-tasks', 'My agent tasks', 'No agent tasks yet'],
      ['teams', 'Teams', 'New team'],
      ['chat', 'Chats', 'Plan customer follow-ups', 'chats'],
    ]) {
      await page.goto(`${origin}/acme/${path}`);
      await page.getByRole('heading', { level: 1, name: heading, exact: true }).waitFor();
      await page.getByText(ready, { exact: true }).first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      const box = await page.getByRole('heading', { level: 1 }).evaluate(node => {
        const rect = node.getBoundingClientRect();
        const css = getComputedStyle(node);
        // The top bar title starts with the page's back link when it has one.
        const lead = node.closest('[aria-label="Workspace header"] > div')?.firstElementChild ?? node;
        return {
          left: lead.getBoundingClientRect().left,
          top: rect.top,
          fontSize: css.fontSize,
          fontWeight: css.fontWeight,
        };
      });
      layout.push({ path, ...box });
      if (!before) {
        // DESIGN.md: inside the shell, PageHeader puts a 13px title in the 44px top bar.
        assert.equal(box.fontSize, '13px', `${path} page title`);
        assert.equal(box.fontWeight, '500', `${path} title weight`);
        assert.equal(box.left, layout[0].left, `${path} shares the standard column`);
      }
      await noOverflow();
      if (shot) await screenshot(shot);
    }
    console.log(`${mode.name} page geometry ${JSON.stringify(layout)}`);
    if (!before) {
      workflowsState = 'loading';
      await page.goto(`${origin}/acme/workflows`);
      await page.getByRole('heading', { name: 'Loading workflows' }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).count(), 0);
      workflowsState = 'error';
      releaseRead();
      await page.getByRole('heading', { name: 'Workflows could not load' }).waitFor();
      const failedBeforeRetry = failedWorkflowReads;
      await page.getByRole('button', { name: 'Retry loading', exact: true }).click();
      // A retried read makes three attempts (lib/query/policy.ts:16); the next answer must not reach this retry.
      for (const deadline = Date.now() + 10_000; failedWorkflowReads < failedBeforeRetry + 3;) {
        assert.ok(Date.now() < deadline, `Retry made ${failedWorkflowReads - failedBeforeRetry} of 3 workflow reads`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await page.getByRole('heading', { name: 'Workflows could not load' }).waitFor();
      workflowsState = 'ready';
      await page.getByRole('button', { name: 'Retry loading', exact: true }).click();
      // Cloud 4a3eb8e3 #1021 moved workflow drafts to chat; a failed refresh keeps the last checked list (pages/workflows.tsx:142-143).
      // Reads no longer refetch on window focus (lib/query/client.ts:40).
      await page.getByRole('heading', { name: 'No workflows yet' }).waitFor();
      workflowsState = 'error';
      await page.getByRole('button', { name: 'Refresh workflows', exact: true }).click();
      await page.getByText('Refresh failed. These are your last checked workflows.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'No workflows yet' }).count(), 1);
      workflowsState = 'ready';
      await page.getByRole('button', { name: 'Refresh workflows', exact: true }).click();
      await page
        .getByText('Refresh failed. These are your last checked workflows.', { exact: true })
        .waitFor({ state: 'detached' });
      await noOverflow();
    }
    assert.deepEqual(errors, [], `${mode.name} has no JavaScript errors`);
    console.log(`PASS ${mode.name} navigation${before ? ' baseline' : ', layout, and workflow recovery'}`);
    await context.close();
  }
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
