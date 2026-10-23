import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import Fastify from '../../api/node_modules/fastify/fastify.js';
import cors from '../../api/node_modules/@fastify/cors/index.js';
import { githubDownloadFixture, downloadAnswer, archive } from '../../worker/test/github-download-fixture.mjs';
import { registerGitHubAccounts } from '../../api/src/github-accounts.ts';
import { registerConversations } from '../../api/src/conversations.ts';
import { chatCatalog } from './chat-catalog.fixture.mjs';

const port = 5231,
  origin = `http://127.0.0.1:${port}`;
process.env.WEB_ORIGIN = origin;
const f = await githubDownloadFixture(),
  app = Fastify();
const auth = {
  api: {
    getSession: async request =>
      request.headers.get('cookie')?.includes('fixture-session=owner')
        ? { user: { id: f.member.userId }, session: { id: 'browser' } }
        : null,
  },
};
await app.register(cors, { origin, credentials: true });
let chatId;
await app.register(
  async routes => {
    registerGitHubAccounts(routes, auth, f.service, f.reads);
    registerConversations(routes, { auth, service: f.store });
    routes.addHook('onSend', async (request, reply, payload) => {
      if (request.method === 'PUT' && request.url.includes('/messages/') && reply.statusCode === 200) {
        const sent = JSON.parse(payload);
        if (sent.turnId) assert.equal(await f.process(chatId, sent.turnId), 'completed');
      }
      return payload;
    });
  },
  { prefix: '/v1' },
);
await app.listen({ host: '127.0.0.1', port: 0 });
const apiOrigin = `http://127.0.0.1:${app.server.address().port}`;
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, VITE_API_URL: apiOrigin },
  stdio: 'ignore',
});
let browser;
const workspace = {
  id: f.one.id,
  slug: 'github-downloads',
  name: 'GitHub downloads',
  createdAt: new Date().toISOString(),
  status: 'ready',
  soulCommit: 'a'.repeat(40),
};
try {
  const accountId = await f.connect();
  chatId = await f.chat();
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {
      if (attempt === 100) throw new Error('Vite failed');
    }
    await setTimeout(100);
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'fixture-session', value: 'owner', url: apiOrigin }]);
  const page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/github/') || path.includes('/conversations')) return route.continue();
    let json;
    if (path === '/v1/auth/get-session')
      json = {
        session: { id: 'browser', userId: f.member.userId },
        user: { id: f.member.userId, name: 'Ada', email: 'ada@example.test' },
      };
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
    else if (path.endsWith('/governance/me'))
      json = {
        membershipId: '22222222-2222-4222-8222-222222222222',
        role: 'member',
        teams: [],
        capabilities: { manageGovernance: false, canLeave: true },
      };
    else if (path.endsWith('/model-catalog')) json = chatCatalog;
    else if (path.includes('/google/')) json = { proposals: [] };
    else return route.fulfill({ status: 404, json: { error: 'not-found' } });
    return route.fulfill({ json });
  });
  await page.goto(`${origin}/${workspace.slug}/chat/${chatId}`);
  f.decide([{ tool: 'github.personal.account' }], 'Choose an account for downloads.');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Choose my GitHub account.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Choose an account for downloads.', { exact: true }).waitFor();
  const selected = page.getByRole('button', { name: 'person-123 · Selected', exact: true, pressed: true });
  await selected.waitFor();
  assert.equal(await selected.isDisabled(), true, 'The only connected account is selected without another pick');
  assert.equal((await f.reads.selection(f.one.id, f.member.userId, chatId)).accountId, accountId);
  for (const [index, kind] of [
    'release.download',
    'actions.artifact-download',
    'actions.run-logs-download',
  ].entries()) {
    f.decide(
      [{ tool: 'github.personal.download', operation: { kind, owner: 'octocat', repo: 'private', id: 7 } }],
      downloadAnswer,
    );
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(`Download ${kind}.`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const link = page.getByRole('button', { name: 'Download private archive', exact: true }).nth(index);
    await link.waitFor();
    f.state.delay = 500;
    const downloading = page.waitForEvent('download');
    await link.click();
    await page.getByText('Checking access and downloading…', { exact: false }).waitFor();
    const download = await downloading;
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), archive);
    assert.equal(
      download.suggestedFilename(),
      kind === 'release.download'
        ? 'private.bin'
        : kind === 'actions.artifact-download'
          ? 'private.bin.zip'
          : 'run-7-attempt-2-logs.zip',
    );
    f.state.delay = 0;
    assert.equal(await download.failure(), null);
    await link.focus();
    assert.equal(await link.evaluate(element => element === document.activeElement), true);
  }
  f.decide([], 'GitHub knowledge may be out of date. [Reconnect GitHub](#github-reconnect)');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('What changed in the roadmap?');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const reconnect = page.getByRole('link', { name: 'Reconnect GitHub', exact: true });
  await reconnect.waitFor();
  assert.equal(await reconnect.getAttribute('href'), `/${workspace.slug}/integrations#github-accounts`);
  await page.reload();
  const link = page.getByRole('button', { name: 'Download private archive', exact: true }).last();
  await link.waitFor();
  f.state.expired = true;
  const failureResponse = page.waitForResponse(response => response.url().includes('/downloads/'));
  await link.click();
  const failedDownload = await failureResponse;
  assert.equal(failedDownload.status(), 409);
  await page.getByRole('alert').filter({ hasText: 'Download unavailable' }).waitFor();
  await page.screenshot({
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/github-download-error.png',
    fullPage: true,
  });
  await link.click();
  await page.getByRole('alert').filter({ hasText: 'Download unavailable' }).waitFor();
  f.state.expired = false;
  const recovered = page.waitForEvent('download');
  await link.click();
  assert.equal(await (await recovered).failure(), null);
  await page.screenshot({
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/github-downloads-desktop.png',
    fullPage: true,
  });
  f.state.deny = true;
  await link.click();
  await page.getByRole('alert').filter({ hasText: 'Download unavailable' }).waitFor();
  await page.reload();
  await page
    .getByText(/This reply is unavailable/)
    .first()
    .waitFor();
  assert.equal(await page.getByRole('button', { name: 'Download private archive', exact: true }).count(), 0);
  f.state.deny = false;
  await page.reload();
  await link.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/github-downloads-mobile.png',
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    'PASS Chromium downloads all three binary kinds through actual HTTP API and worker composition with PostgreSQL. Exact bytes, reload, loading, repeated failure, recovery, access-loss concealment, keyboard, mobile/dark. Provider and model are local fixtures.',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await app.close();
  await f.close();
}
