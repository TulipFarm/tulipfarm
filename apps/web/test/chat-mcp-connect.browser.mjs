import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { createWorkspaceFixture, serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';

const port = Number(process.env.CHAT_MCP_PORT ?? 5419);
const origin = `http://127.0.0.1:${port}`;
const id = '11111111-1111-4111-8111-111111111111';
const toolId = '22222222-2222-4222-8222-222222222222';
const secretId = '33333333-3333-4333-8333-333333333333';
const otherSecretId = '55555555-5555-4555-8555-555555555555';
const savedId = '44444444-4444-4444-8444-444444444444';
const endpoint = 'https://mcp.posthog.com/mcp';
const { workspace, session } = createWorkspaceFixture({ slug: 'mcp-chat', name: 'MCP chat' });
const shell = new Map(workspaceShellReads(workspace.id));
const secret = (secretId, name, value) => ({
  id: secretId,
  name,
  variableName: 'POSTHOG_KEY',
  kind: 'api-key',
  placement: { kind: 'bearer' },
  placementSource: 'member',
  lifetime: 'saved',
  origin: null,
  destinations: [{ kind: 'endpoint', value }],
  grants: [],
  ownerMembershipId: id,
  status: 'active',
  version: 1,
  policyVersion: 1,
  expiresAt: null,
  createdAt: workspace.createdAt,
  replacedAt: null,
  lastUsedAt: null,
  canManage: true,
});

const authorizationUrl = 'https://oauth.posthog.com/oauth/authorize?client_id=tulipfarm';

async function withCard(authentication, steps) {
  const server = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: new URL('..', import.meta.url), stdio: 'ignore' },
  );
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
      assert.ok(attempt < 300, 'Vite starts');
      await delay(100);
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const integrations = [];
    const setups = [];
    await page.route('**/v1/**', async route => {
      if (await serveWorkspaceShellEvent(route, workspace)) return;
      const request = route.request(),
        path = new URL(request.url()).pathname,
        method = request.method();
      let json;
      if (path === '/v1/user/visit') json = { firstSession: false };
      else if (path === '/v1/auth/get-session') json = session;
      else if (path === '/v1/workspaces') json = [workspace];
      else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
      else if (path.endsWith('/workspace-mcp/capabilities'))
        json = { enabled: true, canManageShared: true, integrationsEnabled: true, dispatchEnabled: true };
      else if (path.endsWith('/workspace-mcp/integrations') && method === 'GET') json = { integrations };
      else if (path.endsWith('/workspace-mcp/integrations') && method === 'POST') {
        const body = request.postDataJSON();
        setups.push(body);
        const integration = {
          id: savedId,
          name: body.name,
          ownership: body.ownership,
          endpoint: body.endpoint,
          accountLabel: null,
          authMethod: authentication === 'oauth' ? 'oauth' : 'secret-headers',
          status: authentication === 'oauth' ? 'oauth-pending' : 'review-required',
          version: 1,
          authorizationEpoch: 1,
          canManage: true,
          canUse: true,
          barrier: null,
          statusReason: null,
        };
        integrations.push(integration);
        json =
          authentication === 'oauth'
            ? { kind: 'oauth', integration, authorizationUrl }
            : { kind: 'saved', integration };
      } else if (path.endsWith(`/workspace-mcp/integrations/${savedId}`))
        json = {
          integration: integrations[0],
          tools: [],
          grants: [],
          grantOptions: [],
          descriptor: { kind: 'chat-only', reason: 'Personal integration.' },
        };
      else if (path.endsWith('/workspace-mcp/actions')) json = { actions: [], nextCursor: null };
      else if (path.includes('/workspace-mcp/selections/'))
        json = { id: 'selection', version: 0, bindings: [], stale: false, choices: [] };
      else if (path.endsWith('/system-package-installations')) json = { installations: [], nextCursor: null };
      else if (path.endsWith('/secrets/capabilities')) json = { enabled: true };
      else if (path.endsWith('/secrets'))
        json = {
          secrets: [
            secret(secretId, 'PostHog personal key', endpoint),
            secret(otherSecretId, 'Other service key', 'https://mcp.other.example/mcp'),
          ],
        };
      else if (shell.has(path)) json = shell.get(path);
      else if (path.endsWith('/governance/me'))
        json = {
          membershipId: id,
          role: 'member',
          teams: [],
          capabilities: { manageGovernance: false, canLeave: true },
        };
      else if (path.endsWith('/model-catalog')) json = chatCatalog;
      else if (path.endsWith('/messages'))
        json = {
          messages: [
            {
              id,
              sequence: 1,
              author: 'human',
              createdAt: workspace.createdAt,
              parts: [{ kind: 'text', text: 'Connect PostHog.' }],
              turn: { id, status: 'completed', generation: 0 },
              tools: [
                {
                  id: toolId,
                  tool: 'integrations.mcp.connect',
                  status: 'completed',
                  integration: { action: 'mcp', name: 'PostHog', endpoint, authentication },
                },
              ],
            },
          ],
          nextBefore: null,
          hasGitHubProposals: false,
        };
      else if (/\/conversations\/[\w-]+$/.test(path))
        json = {
          id,
          title: 'PostHog',
          titleRevision: 1,
          archived: false,
          activityAt: workspace.createdAt,
          createdAt: workspace.createdAt,
        };
      else return route.fulfill({ status: 404, json: { error: 'not-found' } });
      return route.fulfill({ json });
    });

    await page.route('https://oauth.posthog.com/**', route =>
      route.fulfill({ contentType: 'text/html', body: '<title>PostHog sign-in</title>' }),
    );
    await page.goto(`${origin}/${workspace.slug}/chat/${id}`);
    const card = page.getByRole('region', { name: 'Connect PostHog' });
    await card.getByRole('group', { name: 'Who can use it' }).waitFor();
    await steps({ page, card, integrations, setups });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.kill();
  }
}

test('a chat MCP proposal sets up a personal integration with saved secrets', { timeout: 120000 }, () =>
  withCard('secrets', async ({ page, card, setups }) => {
    await card.locator('[data-slot="button"]', { hasText: 'Connect PostHog' }).click();
    const setup = page.getByRole('dialog', { name: 'Connect PostHog' });
    assert.equal(await setup.getByLabel('Server link').inputValue(), endpoint);
    await setup.getByRole('checkbox', { name: /PostHog personal key/ }).check();
    assert.equal(await setup.getByText('Other service key').count(), 0, 'only secrets for this endpoint are offered');
    await setup.getByRole('button', { name: 'Connect', exact: true }).click();

    const connected = page.getByRole('region', { name: 'PostHog connection' });
    await connected.getByRole('button', { name: 'Turn on PostHog' }).waitFor();
    assert.equal(setups.length, 1);
    assert.deepEqual(
      { ...setups[0], requestId: undefined },
      {
        name: 'PostHog',
        endpoint,
        ownership: 'personal',
        auth: { kind: 'secrets', secretIds: [secretId] },
        requestId: undefined,
      },
    );
  }),
);

test(
  'a chat OAuth proposal connects in one click and shows the connection when the chat comes back',
  { timeout: 120000 },
  () =>
    withCard('oauth', async ({ page, card, integrations, setups }) => {
      await card.locator('[data-slot="button"]', { hasText: 'Connect PostHog' }).click();
      await page.waitForURL(authorizationUrl);
      assert.equal(setups.length, 1);
      assert.deepEqual(setups[0].auth, { kind: 'oauth' });
      assert.equal(setups[0].ownership, 'personal');

      integrations[0] = { ...integrations[0], status: 'ready' };
      await page.goto(`${origin}/${workspace.slug}/chat/${id}`);
      const connected = page.getByRole('region', { name: 'PostHog connection' });
      await connected.getByText('Connected', { exact: true }).waitFor();
      await connected.getByText(/Ask away/).waitFor();
    }),
);
