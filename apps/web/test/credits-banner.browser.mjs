import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { builderBrowserOptions, captureBrowserFailure, startBuiltApp } from './built-app.fixture.mjs';
import { createWorkspaceFixture, serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';

const { workspace, session } = createWorkspaceFixture({ slug: 'acme', name: 'Acme' });
const membershipId = '22222222-2222-4222-8222-222222222222';
const report = balance => ({
  viewer: { membershipId: membershipId, admin: true },
  balance,
  rows: [],
  series: [],
  options: {},
  labels: { models: {}, agents: {}, connections: {} },
  detailSince: null,
  truncated: false,
});

async function open(browser, origin, { role, balance }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  const reads = new Map(workspaceShellReads(workspace.id));
  const summary = { ...balance, used: 0, held: 0, days: [], breakdown: [], series: [] };
  await page.route('**/v1/**', async route => {
    if (await serveWorkspaceShellEvent(route, workspace)) return;
    const path = new URL(route.request().url()).pathname;
    let json = reads.get(path);
    if (path === '/v1/auth/get-session') json = session;
    else if (path === '/v1/user/visit') json = { firstSession: false };
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
    else if (path.endsWith('/governance/me'))
      json = {
        membershipId: membershipId,
        role,
        teams: [],
        capabilities: { manageGovernance: role === 'admin', canLeave: true },
      };
    else if (path.endsWith('/credits')) json = summary;
    else if (path.endsWith('/usage')) json = report(balance);
    if (json === undefined) await route.fulfill({ status: 404, json: { error: 'not-found' } });
    else await route.fulfill({ json });
  });
  await page.goto(`${origin}/${workspace.slug}/settings/usage`);
  return page;
}

test(
  'the credits banner tells every member when credits run low, run on grace or run out',
  { timeout: 120000 },
  async () => {
    const app = await startBuiltApp();
    const browser = await chromium.launch(builderBrowserOptions());
    let page;
    try {
      const banner = () => page.getByRole('region', { name: 'Workspace credits' });
      const addCredits = () => banner().getByRole('link', { name: 'Add credits' });

      page = await open(browser, app.origin, {
        role: 'admin',
        balance: { available: 420, granted: 5000, grace: 1000 },
      });
      await banner().getByText('420 credits left. Add credits to keep work running.').waitFor();
      assert.equal(await addCredits().getAttribute('href'), `/${workspace.slug}/settings/usage`);
      await page.close();

      page = await open(browser, app.origin, {
        role: 'member',
        balance: { available: -180, granted: 5000, grace: 1000 },
      });
      await banner()
        .getByText('Out of credits. Work continues on grace credits, 820 left. Ask a workspace admin to add credits.')
        .waitFor();
      assert.equal(await addCredits().count(), 0, 'only admins get the link');
      await page.close();

      page = await open(browser, app.origin, {
        role: 'admin',
        balance: { available: -180, granted: 5000, grace: 1000 },
      });
      await page.getByText(/Grace · 820 of 1,000 grace credits left/).waitFor();
      await page.close();

      page = await open(browser, app.origin, {
        role: 'admin',
        balance: { available: -1000, granted: 5000, grace: 1000 },
      });
      await banner()
        .getByText(
          'Work is paused: out of credits. Model calls, agent runs and sandboxes are paused until credits are added.',
        )
        .waitFor();
      await page.getByText(/Paused: out of credits/).waitFor();
      await page.close();

      page = await open(browser, app.origin, {
        role: 'admin',
        balance: { available: null, granted: null, grace: null },
      });
      await page.getByRole('heading', { name: 'Usage' }).first().waitFor();
      assert.equal(await banner().count(), 0, 'unlimited credits show no banner');
    } catch (error) {
      await captureBrowserFailure(page, 'credits-banner');
      throw error;
    } finally {
      await browser.close();
      await app.close();
    }
  },
);
