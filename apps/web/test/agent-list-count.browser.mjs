import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:5239';
const workspace = {
  id: '10000000-0000-4000-8000-000000000001',
  slug: 'agent-list',
  name: 'Agent list',
  createdAt: new Date().toISOString(),
  status: 'ready',
  soulCommit: 'a'.repeat(40),
};
const agent = {
  id: '20000000-0000-4000-8000-000000000001',
  name: 'Public guide',
  owningTeamId: '30000000-0000-4000-8000-000000000001',
  savedRevision: 'a'.repeat(40),
  definitionRevision: 'b'.repeat(64),
};
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5239', '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {
      if (attempt === 100) throw new Error('Vite failed');
    }
    await setTimeout(100);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  let mode = 'page',
    delay = 0;
  const reads = { list: 0, detail: 0, context: 0 };
  await page.route('**/v1/**', async route => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    let json;
    if (path === '/v1/auth/get-session')
      json = {
        session: { id: 'browser', userId: 'reader' },
        user: { id: 'reader', name: 'Reader', email: 'reader@example.test' },
      };
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
    else if (path.endsWith('/governance/me'))
      json = {
        membershipId: '40000000-0000-4000-8000-000000000001',
        role: 'member',
        teams: [],
        capabilities: { manageGovernance: false, canLeave: true },
      };
    else if (path.endsWith('/agents/authoring-context')) {
      reads.context++;
      json = { currentSoulRevision: 'a'.repeat(40), teams: [], admin: false };
    } else if (path.endsWith('/agents')) {
      reads.list++;
      await setTimeout(delay);
      if (mode === 'error') return route.fulfill({ status: 503, json: { error: 'agent-operation-unavailable' } });
      json =
        mode === 'empty'
          ? { agents: [], count: 0, nextCursor: null }
          : mode === 'exact'
            ? { agents: [agent], count: 1, nextCursor: null }
            : { agents: [agent], nextCursor: url.searchParams.has('after') ? null : agent.id };
    } else if (path.endsWith(`/agents/${agent.id}`)) {
      reads.detail++;
      json = {
        ...agent,
        definition: { name: agent.name, instructions: 'Read the public guide.', tools: [], skills: [] },
        capabilities: ['read'],
        admin: false,
        activations: [],
      };
    } else return route.fulfill({ status: 404, json: { error: 'not-found' } });
    return route.fulfill({ json });
  });
  const started = performance.now();
  await page.goto(`${origin}/${workspace.slug}/agents`);
  await page.getByRole('link', { name: 'Public guide', exact: true }).waitFor();
  await page.getByText('Read the public guide.', { exact: true }).waitFor();
  const coldMilliseconds = Math.round(performance.now() - started);
  const coldReads = { ...reads };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await setTimeout(300);
  assert.deepEqual(reads, coldReads, 'Focus performs no agent reads');
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).searchParams.get('search') === 'Public'),
    page.getByRole('searchbox', { name: 'Find agents' }).fill('Public'),
  ]);
  assert.equal(await page.getByText(/matching agents/).count(), 0);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await page.getByText('Page 2', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Next page', exact: true }).isDisabled(), true);
  mode = 'exact';
  const beforeRevisit = { ...reads },
    revisitStarted = performance.now();
  await page.getByRole('button', { name: 'First page', exact: true }).click();
  await page.getByText('Page 1', { exact: true }).waitFor();
  const revisitMilliseconds = Math.round(performance.now() - revisitStarted);
  assert.deepEqual(reads, beforeRevisit, 'Fresh cursor revisit performs no agent reads');
  // Fresh navigation reuses the original page. A new filter requests new totals.
  await page.getByRole('searchbox', { name: 'Find agents' }).fill('Public guide');
  await page.getByText('1 matching agents', { exact: true }).waitFor();
  mode = 'error';
  await page.reload();
  await page.getByRole('heading', { name: 'Could not load agents' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'No agents yet' }).count(), 0);
  mode = 'empty';
  delay = 500;
  await page.getByRole('button', { name: 'Check access again' }).click();
  assert.equal(await page.getByRole('heading', { name: 'No agents yet' }).count(), 0);
  await page.getByRole('heading', { name: 'No agents yet' }).waitFor();
  mode = 'exact';
  delay = 0;
  await page.getByRole('searchbox', { name: 'Find agents' }).fill('guide');
  await page.getByText('1 matching agents', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Agent list browser proof passed.', {
    coldReads,
    coldMilliseconds,
    freshRevisitReads: 0,
    revisitMilliseconds,
    focusReads: 0,
  });
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
