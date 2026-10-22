import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';

const port = 5237,
  origin = `http://127.0.0.1:${port}`;
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
const id = '11111111-1111-4111-8111-111111111111';
const batch = {
  snapshot: {
    id,
    workspaceId: id,
    membershipId: id,
    commandId: id,
    accountId: id,
    generation: 1,
    selectionVersion: 1,
    origin: { kind: 'chat', conversationId: id, turnId: id, generation: 0 },
    sources: [],
    actions: [{ kind: 'issue.create', owner: 'octocat', repo: 'private', title: 'Exact', body: 'Body' }],
    configurationDigest: 'a'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z',
  },
  digest: 'b'.repeat(64),
  expired: false,
  decision: null,
  actions: [{ ordinal: 0, status: 'unattempted', result: null, reconciliation: null }],
};
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {
      if (attempt > 100) throw new Error('Vite unavailable');
    }
    await setTimeout(100);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const held = Promise.withResolvers(),
    gate = Promise.withResolvers(),
    delivered = Promise.withResolvers();
  const recovery = Promise.withResolvers(),
    recoveryGate = Promise.withResolvers();
  let gets = 0,
    posts = 0;
  await page.route('**/v1/**', async route => {
    if (route.request().method() === 'POST') {
      posts++;
      return route.fulfill({ status: 503, json: { error: 'batch-unavailable' } });
    }
    const request = ++gets;
    if (request === 2) {
      held.resolve();
      await gate.promise;
    }
    if (request === 3) {
      recovery.resolve();
      await recoveryGate.promise;
    }
    await route.fulfill({ json: { batches: [batch] } });
    if (request === 2) delivered.resolve();
  });
  await page.route('**/review', route =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
    const React=(await import('/node_modules/.vite/deps/react.js')).default;
    const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const {GitHubBatches}=await import('/src/features/chat/github-batches.tsx');
    const {SessionQueryProvider,WorkspaceQueryProvider}=await import('/src/lib/query/index.ts');
    const root=createRoot(document.getElementById('root')); let revision=0;
    const identity={userId:'fixture',sessionId:'session'},scope={kind:'workspace',userId:'fixture',workspaceId:'${id}',membershipId:'${id}'},admitted=()=>true,subscribe=()=>()=>{};
    window.refresh=()=>root.render(React.createElement(SessionQueryProvider,{identity},React.createElement(WorkspaceQueryProvider,{scope,admitted,subscribe},React.createElement(GitHubBatches,{workspaceId:'${id}',chatId:'${id}',revision:String(revision++)})))); window.refresh();
  </script></body></html>`,
    }),
  );
  await page.goto(`${origin}/review`);
  await page.getByRole('button', { name: 'View GitHub changes', exact: true }).click();
  const approve = page.getByRole('button', { name: 'Approve exact batch' });
  await approve.waitFor();
  await page.evaluate(() => window.refresh());
  await held.promise;
  await approve.click();
  await page.getByRole('alert').waitFor();
  assert.equal(await approve.isDisabled(), true);
  gate.resolve();
  await delivered.promise;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await approve.isDisabled(), true, 'the pre-approval GET cannot clear failed approval uncertainty');
  assert.equal(await page.getByRole('alert').count(), 1);
  assert.equal(gets, 2);
  await page.getByRole('button', { name: 'Check batch status' }).click();
  await recovery.promise;
  assert.equal(await approve.isDisabled(), true, 'the fresh status check must finish before another decision');
  recoveryGate.resolve();
  await page.getByRole('alert').waitFor({ state: 'detached' });
  assert.equal(await approve.isEnabled(), true);
  assert.equal(gets, 3);
  assert.equal(posts, 1);
  assert.deepEqual(errors, []);
  console.log(
    'PASS deferred pre-approval GET cannot clear failed POST uncertainty; explicit fresh status restores actions; one POST.',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
