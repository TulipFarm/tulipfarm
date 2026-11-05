import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:5241';
const workspace = {
  id: '10000000-0000-4000-8000-000000000001',
  slug: 'secrets',
  name: 'Secrets',
  createdAt: new Date().toISOString(),
  status: 'ready',
  soulCommit: 'a'.repeat(40),
};
const you = '40000000-0000-4000-8000-000000000001';
const team = { id: '30000000-0000-4000-8000-000000000001', name: 'Finance' };
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5241', '--strictPort'], {
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const creates = [];
  let createFailures = 1;
  let listDelay = 0;
  await page.route('**/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
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
        membershipId: you,
        role: 'member',
        teams: [team],
        capabilities: { manageGovernance: false, canLeave: true },
      };
    else if (path.endsWith('/secrets/capabilities')) json = { enabled: true };
    else if (path.endsWith('/secrets') && request.method() === 'POST') {
      creates.push(request.postDataJSON());
      // The first save is lost on the way back, as if the connection dropped after the server stored it.
      if (createFailures-- > 0) return route.fulfill({ status: 503, json: { error: 'secrets-unavailable' } });
      json = { ok: true };
    } else if (path.endsWith('/secrets')) {
      await setTimeout(listDelay);
      json = { secrets: [] };
    } else return route.fulfill({ status: 404, json: { error: 'not-found' } });
    return route.fulfill({ json });
  });

  await page.goto(`${origin}/${workspace.slug}/settings/secrets`);
  await page.getByRole('button', { name: 'Add secret' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add secret' });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('GitHub');
  const value = dialog.getByLabel('Key or token', { exact: true });
  await value.fill('ghp_example');
  await dialog.getByRole('textbox', { name: 'Used with' }).fill('api.github.com');
  await dialog.getByRole('button', { name: 'Advanced' }).click();

  const body = dialog.locator('.overflow-y-auto');
  const [scrollWidth, clientWidth] = await body.evaluate(element => [element.scrollWidth, element.clientWidth]);
  assert.equal(scrollWidth, clientWidth, 'The form never scrolls sideways');

  // Only a single person may manage a secret, so teams and everyone get no role choice.
  await dialog.getByText('My team', { exact: true }).click();
  assert.equal(await dialog.getByLabel('What they can do').count(), 0);
  await dialog.getByText('Everyone', { exact: true }).click();
  assert.equal(await dialog.getByLabel('What they can do').count(), 0);

  await dialog.getByLabel('Type').click();
  await page.getByRole('option', { name: 'Token' }).click();
  assert.equal(await dialog.getByRole('textbox', { name: 'Variable name' }).inputValue(), 'GITHUB_TOKEN');
  await dialog.getByLabel('Delete it').click();
  await page.getByRole('option', { name: 'In 1 day' }).click();

  await dialog.getByRole('button', { name: 'Add secret' }).click();
  await dialog.getByRole('alert').waitFor();
  // A retry a moment later must send the same change so the server replays it.
  await setTimeout(1100);
  listDelay = 1500;
  await dialog.getByRole('button', { name: 'Add secret' }).click();
  await dialog.getByRole('button', { name: 'Adding…' }).waitFor();
  while (creates.length < 2) await setTimeout(50);
  await setTimeout(200);
  assert.equal(await value.inputValue(), '', 'The value is cleared once saved, before the list reloads');
  await dialog.waitFor({ state: 'detached' });

  const [first, retry] = creates;
  assert.equal(retry.requestId, first.requestId);
  assert.equal(retry.expiresAt, first.expiresAt);
  assert.ok(first.expiresAt);
  assert.equal(first.kind, 'token');
  assert.deepEqual(first.grants, [{ grantee: { kind: 'workspace' }, role: 'use' }]);
  assert.equal(first.variableName, undefined, 'An untouched variable name is left to the server');
  assert.deepEqual(errors, []);
  console.log('Secrets browser proof passed.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
