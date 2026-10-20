import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

test(
  'provider queries share reads, retain transient failures, and conceal cross-tab authority changes',
  { timeout: 60000 },
  async t => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const server = await createServer({
      root,
      configFile: `${root}/vite.config.ts`,
      envDir: false,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, hmr: false },
    });
    await server.listen();
    const origin = server.resolvedUrls.local[0];
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const id = '11111111-1111-4111-8111-111111111111';
    let reads = 0,
      fail = false,
      hold = false,
      generation = 1;
    const pending = [];
    await context.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/availability')) return route.fulfill({ json: { configured: true } });
      if (path.endsWith('/google-workspace'))
        return route.fulfill({
          json: {
            status: 'connected',
            integrationId: id,
            generation,
            accountId: 'fixture',
            email: 'fixture@example.test',
            scopes: [],
          },
        });
      assert.ok(path.endsWith(`/proposals/${id}`));
      reads++;
      if (hold) await new Promise(resolve => pending.push(resolve));
      return route.fulfill({
        status: fail ? 503 : 200,
        json: fail
          ? { error: 'unavailable' }
          : {
              id,
              operation: { kind: 'docs.documents.create', title: `Private generation ${generation}` },
              digest: 'a'.repeat(64),
              expiresAt: '2099-01-01T00:00:00Z',
              integration: { integrationId: id, accountId: 'fixture', generation, scopes: [], requiredScopes: [] },
              decision: null,
              receipt: null,
            },
      });
    });
    await context.route('**/proof', route =>
      route.fulfill({
        contentType: 'text/html',
        body: `<div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
    const {React,createRoot,SessionQueryProvider,WorkspaceQueryProvider} = await import('/test/query-browser-fixture.tsx');
    const {useGoogleProposal,useGoogleIntegration,useIntegrationChanges} = await import('/src/features/integrations/queries.ts');
    const identity={userId:'fixture',sessionId:'session'}, scope={kind:'workspace',userId:'fixture',workspaceId:'${id}',membershipId:'${id}'};
    function Reader({name}) { const read=useGoogleProposal('${id}','${id}'); return React.createElement('p',{'data-reader':name,'data-state':read.state.kind,'data-error':!!read.error},read.data?.operation.title ?? read.state.kind); }
    function App() {
      useGoogleIntegration('${id}'); const changes=useIntegrationChanges(); const read=useGoogleProposal('${id}','${id}');
      const [show,setShow]=React.useState(true);
      return React.createElement(React.Fragment,null,
        React.createElement('button',{onClick:()=>setShow(!show)},'Toggle readers'),
        React.createElement('button',{onClick:()=>read.refresh()},'Check proposal'),
        React.createElement('button',{onClick:()=>changes.authority('google')},'Change source'),
        show && React.createElement(React.Fragment,null,React.createElement(Reader,{name:'one'}),React.createElement(Reader,{name:'two'})));
    }
    createRoot(document.getElementById('root')).render(React.createElement(SessionQueryProvider,{identity},React.createElement(WorkspaceQueryProvider,{scope,admitted:()=>true,subscribe:()=>()=>{}},React.createElement(App))));
  </script>`,
      }),
    );
    try {
      const page = await context.newPage();
      const started = performance.now();
      await page.goto(`${origin}proof`);
      await page.locator('[data-reader="two"]').filter({ hasText: 'Private generation 1' }).waitFor();
      assert.equal(reads, 1, 'three observers share one initial read');
      t.diagnostic(
        `Cold provider proof: ${reads} proposal request, ${Math.round(performance.now() - started)} ms to both readers.`,
      );
      await page.getByRole('button', { name: 'Toggle readers' }).click();
      await page.getByRole('button', { name: 'Toggle readers' }).click();
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await delay(250);
      assert.equal(reads, 1, 'fresh remount and focus issue no requests');
      fail = true;
      await page.getByRole('button', { name: 'Check proposal' }).click();
      await page.locator('[data-reader="one"][data-error="true"]').waitFor();
      assert.equal(await page.locator('[data-reader="one"]').innerText(), 'Private generation 1');
      assert.equal(reads, 4, 'transient read gets at most two retries');
      fail = false;
      const other = await context.newPage();
      await other.goto(`${origin}proof`);
      await other.locator('[data-reader="one"][data-state="ready"]').waitFor();
      hold = true;
      generation = 2;
      await other.getByRole('button', { name: 'Change source' }).click();
      await page.locator('[data-reader="one"][data-state="loading"]').waitFor();
      assert.equal(await page.getByText('Private generation 1', { exact: true }).count(), 0);
      hold = false;
      pending.splice(0).forEach(resolve => resolve());
      await page.locator('[data-reader="one"]').filter({ hasText: 'Private generation 2' }).waitFor();
      await delay(200);
      const settled = reads;
      await delay(300);
      assert.equal(reads, settled, 'received invalidation does not echo');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
