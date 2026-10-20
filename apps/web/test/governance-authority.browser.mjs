import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { ownMembership } from './workspace-query.fixture.mjs';
import { shellRead } from './shell-reads.mjs';

const { workspace, session } = createWorkspaceFixture({
  slug: 'acme',
  name: 'Acme',
  userId: 'ada',
  sessionId: 'session',
});
const governance = `/v1/workspaces/${workspace.id}/governance`;
const snapshot = {
  actorMembershipId: ownMembership.membershipId,
  members: [{ id: ownMembership.membershipId, userId: 'ada', name: 'Ada', email: 'ada@example.test', role: 'admin' }],
  directory: [{ id: ownMembership.membershipId, name: 'Ada', email: 'ada@example.test', image: null }],
  tableTeamIds: [],
  teams: [],
  tables: [],
  grants: [],
};
const membership = {
  admin: { ...ownMembership, capabilities: { manageGovernance: true, canLeave: false } },
  member: { ...ownMembership, role: 'member', capabilities: { manageGovernance: false, canLeave: true } },
};

test('focus applies same-membership authority changes to loaded administration', { timeout: 120_000 }, async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    envDir: false,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  const browser = await chromium.launch();

  async function fixture(run) {
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    await page.clock.install();
    const state = { role: 'admin', held: null, inflight: 0, adminReads: [], errors: [], unexpected: [] };
    page.on('pageerror', error => state.errors.push(error.message));
    await page.route('**/v1/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      let status = 200,
        json;
      state.inflight++;
      if (path === '/v1/auth/get-session') json = session;
      else if (path === '/v1/user/visit') json = { firstSession: false };
      else if (path === '/v1/workspaces') json = [workspace];
      else if (path === '/v1/workspaces/acme') json = workspace;
      else if (path === `${governance}/me`) json = membership[state.role];
      else if (path === governance || path === `${governance}/invitations`) {
        if (path === `${governance}/invitations` && state.role !== 'admin') {
          status = 404;
          json = { error: 'governance-not-found' };
        } else json = path === governance ? snapshot : { items: [], nextCursor: null };
        state.adminReads.push({ path: path.slice(governance.length) || '/', role: state.role, status });
        if (state.held && path === governance) {
          state.held.started.resolve();
          await state.held.release.promise;
        }
      } else if (path === `/v1/workspaces/${workspace.id}/credits`)
        json = { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] };
      else if (path === `/v1/workspaces/${workspace.id}/model-catalog`) json = { families: [] };
      else if (path === `/v1/workspaces/${workspace.id}/model-policy/availability`) json = { items: [] };
      else if (path === `/v1/workspaces/${workspace.id}/compaction-policy`)
        json = {
          automatic: true,
          triggerPercent: 70,
          targetPercent: 30,
          modelFamilyId: 'primary',
          fallbackFamilyId: null,
          outputPrompt: null,
          revision: 0,
          editorMembershipId: null,
          updatedAt: null,
          budgetFamilies: [],
        };
      else if (shellRead(request.method(), path, workspace))
        ({ status = 200, json } = shellRead(request.method(), path, workspace));
      else {
        state.unexpected.push(`${request.method()} ${path}`);
        status = 503;
        json = { error: 'unavailable' };
      }
      await route.fulfill({
        status,
        json,
        headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
      });
      state.inflight--;
    });
    const focusCheck = async () => {
      const read = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/governance/me'));
      await page.clock.setSystemTime((await page.evaluate(() => Date.now())) + 61_000);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      return (await read).json();
    };
    const settled = async () => {
      for (let quiet = 0, attempt = 0; quiet < 3; attempt++) {
        assert.ok(attempt < 100, 'requests settle');
        quiet = state.inflight === 0 ? quiet + 1 : 0;
        await delay(100);
      }
    };
    try {
      await run({ page, state, focusCheck, settled });
      assert.deepEqual(state.errors, []);
      assert.deepEqual(state.unexpected, []);
    } finally {
      await page.close();
    }
  }

  try {
    await t.test('Members conceals administration on demotion and keeps it when authority is unchanged', () =>
      fixture(async ({ page, state, focusCheck, settled }) => {
        const search = page.getByLabel('Search members');
        const invitations = page.getByRole('tab', { name: 'Invitations', exact: true });
        await page.goto(`${origin}/acme/members`);
        await search.fill('Ada');
        await invitations.click();
        await page.getByRole('heading', { name: 'No invitations yet' }).waitFor();
        const readsBeforeUnchanged = state.adminReads.length;
        assert.deepEqual(await focusCheck(), membership.admin);
        await settled();
        assert.equal(
          state.adminReads.length,
          readsBeforeUnchanged,
          'an unchanged authority keeps loaded administration',
        );
        assert.equal(await search.inputValue(), 'Ada', 'an unchanged authority keeps editor state');

        state.role = 'member';
        const demoted = (state.held = { started: Promise.withResolvers(), release: Promise.withResolvers() });
        assert.deepEqual(await focusCheck(), membership.member);
        await search.waitFor({ state: 'detached' });
        await Promise.race([
          demoted.started.promise,
          delay(5000).then(() => {
            throw new Error('the demotion re-reads the governance snapshot');
          }),
        ]);
        await page.getByText('Loading workspace access…', { exact: true }).waitFor();
        assert.equal(await invitations.count(), 0, 'the demotion conceals administration before its re-read returns');
        assert.equal(await page.getByRole('button', { name: 'Invite members', exact: true }).count(), 0);
        state.held = null;
        demoted.release.resolve();
        await page.getByText('Your role is member.', { exact: true }).waitFor();
        await settled();
        assert.equal(await invitations.count(), 0);
        assert.equal(await search.count(), 0);
        const demotedReads = state.adminReads.slice(readsBeforeUnchanged);
        assert.ok(
          demotedReads.some(read => read.path === '/' && read.status === 200),
          JSON.stringify(demotedReads),
        );
        assert.deepEqual(
          demotedReads.filter(read => read.path === '/invitations' && read.status !== 404),
          [],
          'the backend refuses administration reads after demotion',
        );

        state.role = 'admin';
        assert.deepEqual(await focusCheck(), membership.admin);
        await invitations.waitFor();
        assert.equal(await page.getByText('Your role is member.', { exact: true }).count(), 0);
      }),
    );

    await t.test('Models revalidates admin controls without a loaded governance view', () =>
      fixture(async ({ page, state, focusCheck, settled }) => {
        const readOnly = page.getByText('You have read-only access. Only workspace admins can change these settings.', {
          exact: true,
        });
        await page.goto(`${origin}/acme/settings/models`);
        await page.getByText('No models configured yet', { exact: false }).first().waitFor();
        await settled();
        assert.equal(await readOnly.count(), 0);
        state.role = 'member';
        assert.deepEqual(await focusCheck(), membership.member);
        await readOnly.waitFor();
        assert.deepEqual(state.adminReads, [], 'Models never loads governance administration');
      }),
    );
  } finally {
    await browser.close();
    await server.close();
  }
});
