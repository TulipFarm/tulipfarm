import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import {
  operationRequestSchema,
  proposalRequestSchema,
  createSourceSchema,
} from '@tulipfarm/atlassian/operation-contracts';
import { governanceSnapshot } from './governance-snapshot.mjs';

const port = Number(process.env.ATLASSIAN_BROWSER_PORT ?? 5217);
const origin = `http://127.0.0.1:${port}`;
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
let browser;
const workspaceId = '11111111-1111-4111-8111-111111111111';
const memberId = '22222222-2222-4222-8222-222222222222';
const teamId = '33333333-3333-4333-8333-333333333333';
const cloudId = '44444444-4444-4444-8444-444444444444';
const boardId = 'a'.repeat(24);
const accountIds = [
  '55555555-5555-4555-8555-555555555551',
  '55555555-5555-4555-8555-555555555552',
  '55555555-5555-4555-8555-555555555553',
];
const workspace = {
  id: workspaceId,
  slug: 'acme',
  name: 'Acme',
  createdAt: '2026-09-30T00:00:00.000Z',
  status: 'ready',
  soulCommit: 'a'.repeat(40),
};
const governance = governanceSnapshot({
  actorMembershipId: memberId,
  members: [{ id: memberId, userId: 'ada', name: 'Ada', email: 'ada@example.com', role: 'admin' }],
  teams: [{ id: teamId, name: 'Engineering', description: '', membershipIds: [memberId] }],
  resources: [],
  grants: [],
});
const accounts = ['atlassian-mcp', 'atlassian-rest', 'trello'].map((protocol, index) => ({
  id: accountIds[index],
  protocol,
  ownership: index === 0 ? 'business' : 'personal',
  state: 'active',
  configured: true,
  identity: {
    id: `provider-${index}`,
    label: ['Work Atlassian', 'Confluence fallback', 'Personal Trello'][index],
    qualification: index === 0 ? 'grant-bound-needs-qualification' : 'verified',
  },
  resources:
    protocol === 'atlassian-rest'
      ? [{ id: cloudId, name: 'Acme site', url: 'https://acme.atlassian.net', scopes: [] }]
      : [],
  scopes: [],
  generation: 1,
  grantsVersion: 1,
  capabilities: { read: true, manage: true, use: true },
}));
const providers = accounts.map(account => ({ protocol: account.protocol, configured: false }));
let sources = [];
let accountStatus = 503;
let sourceStatus = 200;
let listDelay = 0;
let showAccounts = false;
let admin = true;
let mcpEnabled = false;
let dropProposal = false;
let dropDecision = false;
let executionTimeout = false;
let dropRead = false;
let emptyRead = false;
let grantsStatus = 200;
let proposalStatus = 200;
let dropSource = false;
let sourceResponseGate;
let readDelay = 150;
let proposalResponseGate;
let consentDelay = 0;
let grants = { expectedVersion: 1, memberIds: [], teamIds: [] };
const proposals = new Map();
const requests = [];
const errors = [];
try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {
      if (attempt === 100) throw new Error('Atlassian browser server did not start');
    }
    await setTimeout(100);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(60000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() : undefined;
    let status = 200;
    let json;
    if (path.includes('/google-workspace')) {
      status = 404;
      json = { error: 'not-found' };
    } else if (path === '/v1/auth/get-session')
      json = { session: { id: 'session', userId: 'ada' }, user: { id: 'ada', name: 'Ada', email: 'ada@example.com' } };
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === '/v1/workspaces/acme') json = workspace;
    else if (path.endsWith('/governance/me'))
      json = {
        membershipId: memberId,
        role: admin ? 'admin' : 'member',
        teams: [],
        capabilities: { manageGovernance: admin, canLeave: true },
      };
    else if (path.endsWith('/governance')) {
      status = admin ? 200 : 404;
      json = admin ? governance : { error: 'governance-not-found' };
    }
    // Grant recipients come from the integrations collaborators read plus the directory since cloud e445ed86 (#478), lib/integrations.ts:26-29.
    else if (path.endsWith('/integrations/collaborators')) {
      status = admin ? 200 : 404;
      json = admin
        ? { members: [{ id: memberId, name: 'user-ada' }], teams: [{ id: teamId, name: 'Engineering' }] }
        : { error: 'not-found' };
    } else if (path.endsWith('/governance/directory'))
      json = { members: [{ id: memberId, name: 'Ada', email: 'ada@example.com', image: null }] };
    else if (path.endsWith('/integrations/creation-context')) json = { teams: [] };
    else if (path.endsWith('/integrations')) json = { integrations: [] };
    else if (path.endsWith('/atlassian/accounts') && method === 'GET') {
      await setTimeout(listDelay);
      status = accountStatus;
      json = status === 200 ? { accounts: showAccounts ? accounts : [], providers } : { error: 'account-disabled' };
    } else if (path.endsWith('/accounts/begin') || path.endsWith('/reconnect')) {
      requests.push({ path, method, body });
      await setTimeout(consentDelay);
      json = {
        accountId: accounts.find(item => path.includes(item.id))?.id ?? accountIds[0],
        url: 'https://mcp.atlassian.com/v1/authorize?state=fixture-consent-state',
      };
    } else if (path.endsWith('/disconnect')) {
      requests.push({ path, method, body });
      const account = accounts.find(item => path.includes(item.id));
      account.state = 'disconnected';
      json = { account, providerRevocation: 'manual-required' };
    } else if (path.endsWith('/grants')) {
      status = grantsStatus;
      if (method === 'PUT') {
        requests.push({ path, method, body });
        if (status === 200) {
          assert.equal(body.expectedVersion, grants.expectedVersion);
          grants = { ...body, expectedVersion: body.expectedVersion + 1 };
          accounts[0].grantsVersion = grants.expectedVersion;
        }
      }
      json = status === 200 ? (method === 'GET' ? grants : accounts[0]) : { error: 'account-conflict' };
    } else if (path.endsWith('/sources') && method === 'GET') {
      status = sourceStatus;
      json =
        status === 200
          ? {
              sources,
              mcp: {
                enabled: mcpEnabled,
                explanation: mcpEnabled
                  ? 'Only operator-reviewed tool contracts are enabled.'
                  : 'MCP operations are disabled until an operator reviews the authenticated catalog and configures trusted contract digests.',
              },
            }
          : { error: 'operation-unavailable' };
    } else if (path.endsWith('/sources') && method === 'POST') {
      requests.push({ path, method, body });
      createSourceSchema.parse(body);
      json = { ...body, id: `66666666-6666-4666-8666-${String(sources.length + 1).padStart(12, '0')}`, enabled: true };
      sources.push(json);
      await sourceResponseGate;
      if (dropSource) {
        dropSource = false;
        await route.abort('failed');
        return;
      }
    } else if (path.endsWith('/disable')) {
      requests.push({ path, method, body });
      const source = sources.find(item => path.includes(item.id));
      source.enabled = false;
      json = source;
    } else if (path.endsWith('/qualify')) {
      requests.push({ path, method, body });
      json = {
        untrusted: true,
        data: {
          identityQualification: 'grant-bound-needs-qualification',
          executionQualification: 'operator-review-required',
          catalog: [],
        },
      };
    } else if (path.endsWith('/operations/read')) {
      requests.push({ path, method, body });
      operationRequestSchema.parse(body);
      await setTimeout(readDelay);
      if (dropRead) {
        await route.abort('failed');
        return;
      }
      json = {
        untrusted: true,
        data: emptyRead
          ? []
          : {
              text: '<script>unsafe()</script>',
              url: 'https://acme.atlassian.net/browse/OPS-1',
              unsafeUrl: 'javascript:alert(1)',
              cards: [{ name: 'Release checklist' }],
            },
      };
    } else if (path.endsWith('/operations/proposals')) {
      requests.push({ path, method, body });
      proposalRequestSchema.parse(body);
      if (proposalStatus !== 200) {
        await route.fulfill({ status: proposalStatus, json: { error: 'operation-conflict' } });
        return;
      }
      let proposal = [...proposals.values()].find(item => item.commandId === body.commandId);
      if (!proposal) {
        proposal = {
          commandId: body.commandId,
          id: `77777777-7777-4777-8777-${String(proposals.size + 1).padStart(12, '0')}`,
          source: structuredClone(sources.find(item => item.id === body.sourceId)),
          operation: body.operation,
          digest: 'f'.repeat(64),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          decision: null,
          receipt: null,
        };
        proposals.set(proposal.id, proposal);
      } else assert.deepEqual(proposal.operation, body.operation);
      await proposalResponseGate;
      if (dropProposal) {
        dropProposal = false;
        await route.abort('failed');
        return;
      }
      const { commandId: _commandId, ...result } = proposal;
      json = result;
    } else if (path.includes('/operations/proposals/')) {
      const id = path.split('/proposals/')[1].split('/')[0];
      const proposal = proposals.get(id);
      assert.ok(proposal);
      if (method === 'POST') requests.push({ path, method, body });
      if (path.endsWith('/decision')) {
        assert.equal(body.digest, proposal.digest);
        proposal.decision = body.decision;
        if (dropDecision) {
          dropDecision = false;
          await route.abort('failed');
          return;
        }
      }
      if (path.endsWith('/execute')) {
        assert.equal(proposal.decision, 'approve');
        assert.equal(body, undefined);
        proposal.receipt = {
          status: executionTimeout ? 'outcome-unknown' : 'succeeded',
          result: executionTimeout ? null : { untrusted: true, data: { id: '123', title: 'Saved' } },
          error: executionTimeout ? 'provider-outcome-unknown' : null,
        };
        if (executionTimeout) {
          await setTimeout(16_000);
          await route.fulfill({ json: proposal.receipt }).catch(() => {});
          return;
        }
        json = proposal.receipt;
      } else {
        const { commandId: _commandId, ...result } = proposal;
        json = result;
      }
    } else {
      status = 404;
      json = { error: 'not-found' };
    }
    await route.fulfill({
      status,
      json,
      headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
    });
  });
  await page.route('https://mcp.atlassian.com/v1/authorize?*', route =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Atlassian sign-in</h1>' }),
  );
  const section = page.getByRole('region', { name: 'Jira and Confluence integration', exact: true });
  const button = name =>
    section.getByRole('button', {
      name: name === 'Refresh Atlassian integrations' ? 'Check integration status' : name,
      exact: true,
    });
  const field = name =>
    /^(Allow |Include |I checked |Shared business account$)/.test(name)
      ? section.getByRole('checkbox', { name, exact: true })
      : section.getByLabel(name, { exact: true });
  const select = async (name, option) => {
    await field(name).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };
  await page.goto(`${origin}/acme/integrations#atlassian-heading`);
  await section.getByRole('heading', { name: 'Could not load Atlassian accounts' }).waitFor();
  assert.equal(await section.getByRole('heading', { name: 'No Atlassian accounts yet' }).count(), 0);
  await button('Retry Atlassian accounts').click();
  await setTimeout(4000);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      button => button.textContent === 'Retry Atlassian accounts' && !button.matches(':disabled'),
    ),
  );
  await section.getByRole('heading', { name: 'Could not load Atlassian accounts' }).waitFor();
  accountStatus = 200;
  listDelay = 500;
  await button('Retry Atlassian accounts').click();
  await section.getByRole('heading', { name: 'Connect an account' }).waitFor();
  assert.equal(await button('Connect account').isDisabled(), true);
  await section.getByText(/This provider is not configured/).waitFor();
  providers.forEach(provider => {
    provider.configured = true;
  });
  listDelay = 0;
  await button('Check integration status').click();
  assert.equal(await field('Provider').isVisible(), false);
  assert.equal(await section.getByRole('heading', { name: 'Your sources' }).isVisible(), false);
  consentDelay = 400;
  await button('Connect account').click();
  assert.equal(await button('Opening sign-in…').isDisabled(), true);
  await page.getByRole('heading', { name: 'Atlassian sign-in' }).waitFor();
  assert.equal(new URL(page.url()).origin, 'https://mcp.atlassian.com');
  assert.equal(requests.filter(item => item.path.endsWith('/begin')).length, 1);
  consentDelay = 0;
  showAccounts = true;
  accounts[0].ownership = 'personal';
  accounts[0].state = 'authorizing';
  accounts[0].identity = null;
  await page.goto(`${origin}/acme/integrations#atlassian-heading`);
  await section.getByText('You have an unfinished integration. Connect account will reuse it.').waitFor();
  assert.equal(await section.getByText(accountIds[0], { exact: true }).count(), 0);
  await button('Connect account').click();
  await page.getByRole('heading', { name: 'Atlassian sign-in' }).waitFor();
  assert.equal(requests.at(-1).path.endsWith(`/accounts/${accountIds[0]}/reconnect`), true);
  assert.equal(requests.filter(item => item.path.endsWith('/begin')).length, 1, 'Retry reuses the unfinished account');
  accounts[0].ownership = 'business';
  accounts[0].state = 'active';
  accounts[0].identity = {
    id: 'provider-0',
    label: 'Work Atlassian',
    qualification: 'grant-bound-needs-qualification',
  };
  await page.goto(`${origin}/atlassian/callback?outcome=connected&workspaceId=${workspaceId}&protocol=atlassian-mcp`);
  await page.getByRole('heading', { name: 'Atlassian account connected' }).waitFor();
  await page.getByRole('link', { name: 'Return to Integrations' }).click();
  await section.getByText(/Your account is connected. Jira and Confluence tools are not enabled/).waitFor();
  await page.goto(`${origin}/atlassian/callback?outcome=denied`);
  await page.getByRole('heading', { name: 'Atlassian sign-in was cancelled' }).waitFor();
  await page.getByRole('link', { name: 'Open my workspace' }).waitFor();
  await page.goto(`${origin}/atlassian/callback?outcome=error`);
  await page.getByRole('heading', { name: 'Could not confirm your integration' }).waitFor();
  await page.goto(`${origin}/acme/integrations#confluence`);
  await page.getByRole('dialog').getByRole('button', { name: 'Your account', exact: true }).click();
  await section.getByText(/Sign in with Atlassian to connect Jira and Confluence together/).waitFor();
  const screenshotDir = process.env.ATLASSIAN_SCREENSHOT_DIR;
  if (screenshotDir) {
    await page.screenshot({ path: `${screenshotDir}/connect-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.screenshot({ path: `${screenshotDir}/connect-mobile.png`, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  }
  showAccounts = true;
  await page.goto(`${origin}/acme/integrations#atlassian-heading`);
  await button('Advanced setup').click();
  await section.getByRole('heading', { name: 'Work Atlassian' }).waitFor();
  await button('Manage use grants').click();
  await field('Allow Ada to use account').check();
  await field('Allow Engineering to use account').check();
  grantsStatus = 409;
  await button('Save use grants').click();
  await section.getByText(/saved state changed or conflicts/).waitFor();
  assert.equal(await field('Allow Ada to use account').isChecked(), true);
  grantsStatus = 200;
  await button('Reload use grants').click();
  await section.getByRole('checkbox', { name: 'Allow Ada to use account', checked: false }).waitFor();
  await field('Allow Ada to use account').check();
  await field('Allow Engineering to use account').check();
  await button('Save use grants').click();
  await section.getByText(/Use grants saved/).waitFor();
  assert.deepEqual(grants.memberIds, [memberId]);
  assert.deepEqual(grants.teamIds, [teamId]);
  async function createSource(accountId, name, product) {
    if (await button('Select another source').count()) await button('Select another source').click();
    const account = accounts.find(item => item.id === accountId);
    await select('Source account', `${account.identity?.label ?? account.protocol} · ${account.id.slice(0, 8)}`);
    await field('Source name').fill(name);
    if (product) {
      await select('Product', product === 'jira' ? 'Jira' : 'Confluence');
      await field('Site cloud ID').fill(cloudId);
    } else if (accountId === accountIds[1]) {
      await select('Verified site', 'Acme site');
      await field('Space ID').fill('42');
    } else await field('Board ID').fill(boardId);
    await button('Save source').click();
    await section.getByText('Source saved. Select it below to run an operation.', { exact: true }).waitFor();
  }
  await createSource(accountIds[0], 'Jira site', 'jira');
  await createSource(accountIds[0], 'Confluence site', 'confluence');
  await createSource(accountIds[1], 'Confluence trash');
  await createSource(accountIds[2], 'Trello board');
  await select('Operation source', sources[0].name);
  assert.equal(await button('Search Jira issues').isDisabled(), true);
  await section.getByRole('button', { name: 'Discover catalog', exact: true }).first().click();
  await section
    .getByText(
      'Operator review is required. Discovery does not verify identity, enable operations, or approve tool contracts.',
    )
    .waitFor();
  mcpEnabled = true;
  await button('Refresh Atlassian integrations').click();
  await field('Jira query (JQL)').fill('project = OPS');
  accountStatus = 503;
  await button('Refresh Atlassian integrations').click();
  await section.getByText(/Last loaded accounts remain visible/).waitFor();
  assert.equal(await field('Jira query (JQL)').count(), 0);
  await section.getByRole('heading', { name: 'Operation access unavailable' }).waitFor();
  accountStatus = 200;
  await button('Refresh Atlassian integrations').click();
  await field('Jira query (JQL)').waitFor();
  assert.equal(await field('Jira query (JQL)').inputValue(), 'project = OPS');
  dropRead = true;
  await button('Search Jira issues').click();
  await button('Retry read').waitFor();
  dropRead = false;
  emptyRead = true;
  await button('Retry read').click();
  await section.getByRole('heading', { name: 'No matching results' }).waitFor();
  emptyRead = false;
  await button('Search Jira issues').click();
  await section.getByRole('link', { name: 'Open https://acme.atlassian.net/browse/OPS-1' }).waitFor();
  assert.equal(await section.locator('a[href^="javascript:"]').count(), 0);
  assert.equal(await section.locator('script').count(), 0);
  async function refreshIntegrations() {
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/atlassian/accounts')),
      page.waitForResponse(response => response.url().endsWith('/atlassian/sources')),
      button('Refresh Atlassian integrations').click(),
    ]);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some(
        button => button.textContent === 'Check integration status' && button.getAttribute('aria-busy') === 'false',
      ),
    );
  }
  const savedSources = [...sources];
  accounts[0].capabilities.use = false;
  sources = [];
  await refreshIntegrations();
  assert.equal(
    await section.getByRole('region', { name: 'Operation results' }).count(),
    0,
    'Revoked use access hides the previous read result',
  );
  accounts[0].capabilities.use = true;
  sources = savedSources;
  await refreshIntegrations();
  await section.getByRole('heading', { name: 'Read results' }).waitFor();
  accounts[0].capabilities.use = false;
  await refreshIntegrations();
  assert.equal(
    await section.getByRole('region', { name: 'Operation results' }).count(),
    0,
    'Account admission hides results even when sources still list the source',
  );
  assert.equal(
    await section
      .getByRole('list', { name: 'Saved Atlassian sources' })
      .getByText('Jira site', { exact: true })
      .count(),
    0,
  );
  accounts[0].capabilities.use = true;
  await refreshIntegrations();
  sources[0].enabled = false;
  await refreshIntegrations();
  assert.equal(
    await section.getByRole('region', { name: 'Operation results' }).count(),
    0,
    'Disabled source hides results',
  );
  sources[0].enabled = true;
  await refreshIntegrations();
  for (const collection of ['accounts', 'sources']) {
    if (collection === 'accounts') accountStatus = 404;
    else sourceStatus = 404;
    await refreshIntegrations();
    await section
      .getByRole('heading', {
        name: collection === 'accounts' ? 'Could not load Atlassian accounts' : 'Could not load sources',
      })
      .waitFor();
    assert.equal(await section.getByRole('region', { name: 'Operation results' }).count(), 0);
    assert.equal(await field('Jira query (JQL)').count(), 0);
    assert.equal(await section.getByRole('list', { name: 'Saved Atlassian sources' }).count(), 0);
    if (collection === 'accounts')
      assert.equal(await section.getByRole('list', { name: 'Atlassian accounts' }).count(), 0);
    accountStatus = 200;
    sourceStatus = 200;
    await button(collection === 'accounts' ? 'Retry Atlassian accounts' : 'Retry sources').click();
    await field('Jira query (JQL)').waitFor();
    assert.equal(await field('Jira query (JQL)').inputValue(), 'project = OPS');
  }
  readDelay = 1200;
  await button('Search Jira issues').click();
  accounts[0].capabilities.use = false;
  await refreshIntegrations();
  await page.waitForTimeout(1400);
  assert.equal(
    await section.getByRole('region', { name: 'Operation results' }).count(),
    0,
    'Late read response stays hidden after revocation',
  );
  accounts[0].capabilities.use = true;
  readDelay = 150;
  await refreshIntegrations();
  await section.getByRole('heading', { name: 'Read results' }).waitFor();
  const operationLabels = {
    'jira.search': 'Search Jira issues',
    'jira.read': 'Read Jira issue',
    'jira.create': 'Create Jira issue',
    'jira.update': 'Update Jira issue',
    'jira.delete': 'Delete Jira issue',
    'confluence.search': 'Search Confluence pages',
    'confluence.read': 'Read Confluence page',
    'confluence.create': 'Create Confluence page',
    'confluence.update': 'Update Confluence page',
    'confluence.trash': 'Move Confluence page to trash',
    'card.search': 'Search Trello cards',
    'card.read': 'Read Trello card',
    'card.create': 'Create Trello card',
    'card.update': 'Update Trello card',
    'card.delete': 'Delete Trello card',
  };
  const cases = [
    ['jira.read', 0, { 'Issue ID or key': 'OPS-1' }],
    ['jira.create', 0, { 'Project key': 'OPS', 'Issue type': 'Task', Summary: 'Release checklist' }],
    ['jira.update', 0, { 'Issue ID or key': 'OPS-1', Summary: 'Updated issue' }, ['Include summary']],
    ['jira.delete', 0, { 'Issue ID or key': 'OPS-1' }],
    ['confluence.search', 1, { 'Confluence query (CQL)': 'type=page' }],
    ['confluence.read', 1, { 'Page ID': '123' }],
    ['confluence.create', 1, { 'Space key': 'OPS', 'Page title': 'Runbook', 'Page body': '<p>Runbook text</p>' }],
    [
      'confluence.update',
      1,
      { 'Page ID': '123', 'Page title': 'Runbook', 'Page body': '<p>Updated</p>', 'New version number': '2' },
    ],
    ['confluence.trash', 2, { 'Page ID': '123' }],
    ['card.search', 3, { 'Card search query': 'release' }],
    ['card.read', 3, { 'Card ID': 'b'.repeat(24) }],
    ['card.create', 3, { 'List ID': 'c'.repeat(24), 'Card title': 'Release', 'Card description': 'Review release' }],
    [
      'card.update',
      3,
      { 'Card ID': 'b'.repeat(24), 'Card title': 'Release updated', 'Due time': '2026-10-01T12:00:00Z' },
      ['Include card title', 'Include due time', 'Include archived', 'Include due complete'],
    ],
    ['card.delete', 3, { 'Card ID': 'b'.repeat(24) }],
  ];
  for (const [kind, sourceIndex, fields, includes = []] of cases) {
    await select('Operation source', sources[sourceIndex].name);
    await select('Operation', operationLabels[kind]);
    for (const label of includes) await field(label).check();
    for (const [label, value] of Object.entries(fields)) await field(label).fill(value);
    const isWrite = !kind.endsWith('.read') && !kind.endsWith('.search');
    if (!isWrite) {
      await section
        .locator('form')
        .filter({ has: page.locator('#operation-kind') })
        .getByRole('button')
        .click();
      await section.getByRole('heading', { name: 'Read results' }).waitFor();
      assert.equal(requests.at(-1).body.operation.kind, kind);
      continue;
    }
    if (kind === 'jira.create') dropProposal = true;
    if (kind === 'jira.update') {
      proposalStatus = 409;
      await button('Prepare write review').click();
      await button('Edit rejected request').click();
      assert.equal(await field('Summary').inputValue(), 'Updated issue');
      proposalStatus = 200;
    }
    const before = requests.length;
    const proposalRequestsBefore = requests.filter(item => item.path.endsWith('/operations/proposals')).length;
    await button('Prepare write review').dblclick();
    if (kind === 'jira.create') {
      await button('Recover original review').waitFor();
      assert.equal(requests.length, before + 1);
      const original = structuredClone(requests.at(-1).body);
      assert.equal(await field('Summary').isDisabled(), true);
      accountStatus = 404;
      await refreshIntegrations();
      assert.equal(await button('Recover original review').count(), 0);
      assert.equal(await section.getByText(/Command reference/).count(), 0);
      accountStatus = 200;
      await button('Retry Atlassian accounts').click();
      await button('Recover original review').waitFor();
      assert.equal(
        requests.filter(item => item.path.endsWith('/operations/proposals')).length,
        proposalRequestsBefore + 1,
        'Restoring access retains the original command without retrying it',
      );
      proposalStatus = 404;
      await button('Recover original review').click();
      await section.getByText(/This account or action is unavailable/).waitFor();
      assert.equal(await button('Edit rejected request').count(), 0);
      assert.deepEqual(requests.filter(item => item.path.endsWith('/operations/proposals')).at(-1).body, original);
      proposalStatus = 200;
      await button('Recover original review').click();
      await section.getByRole('heading', { name: 'Review saved action' }).waitFor();
      assert.deepEqual(requests.filter(item => item.path.endsWith('/operations/proposals')).at(-1).body, original);
    }
    await section.getByRole('heading', { name: 'Review saved action' }).waitFor();
    assert.equal(requests.filter(item => item.path.endsWith('/operations/proposals')).at(-1).body.operation.kind, kind);
    await page.waitForFunction(() => document.activeElement?.textContent === 'Review saved action');
    if (kind === 'jira.create') {
      const writeCount = requests.filter(item => item.path.endsWith('/operations/proposals')).length;
      const review = await section.getByRole('region', { name: 'Immutable write review' }).textContent();
      for (const loss of ['use', 'missing', 'disabled', 'accounts404', 'sources404']) {
        if (loss === 'use') accounts[0].capabilities.use = false;
        if (loss === 'missing') sources = [];
        if (loss === 'disabled') savedSources[0].enabled = false;
        if (loss === 'accounts404') accountStatus = 404;
        if (loss === 'sources404') sourceStatus = 404;
        await refreshIntegrations();
        assert.equal(
          await section.getByRole('region', { name: 'Immutable write review' }).count(),
          0,
          `${loss} hides immutable review`,
        );
        assert.equal(await section.getByText(/Command reference/).count(), 0);
        assert.equal(await field('Summary').count(), 0);
        accounts[0].capabilities.use = true;
        sources = savedSources;
        sources[0].enabled = true;
        accountStatus = 200;
        sourceStatus = 200;
        await refreshIntegrations();
        assert.equal(await section.getByRole('region', { name: 'Immutable write review' }).textContent(), review);
        assert.equal(await field('Summary').inputValue(), 'Release checklist');
        assert.equal(
          requests.filter(item => item.path.endsWith('/operations/proposals')).length,
          writeCount,
          'Restoring access does not resend a proposal',
        );
        await page.waitForFunction(() => document.activeElement?.textContent === 'Review saved action');
      }
    }
    if (kind === 'jira.delete') {
      await button('Reject action').click();
      await section.getByText('Action rejected. It will not be executed.').waitFor();
      assert.equal(await button('Execute approved action').count(), 0);
    } else {
      if (kind === 'card.create') dropDecision = true;
      await button('Approve exact action').click();
      if (kind === 'card.create') {
        await section
          .getByText('The decision is unconfirmed. Check the saved receipt before making another decision.')
          .waitFor();
        await button('Check saved receipt').click();
      }
      await button('Execute approved action').waitFor();
      assert.equal(requests.filter(item => item.path.endsWith('/decision')).at(-1).body.decision, 'approve');
      const executeBefore = requests.filter(item => item.path.endsWith('/execute')).length;
      executionTimeout = kind === 'card.create';
      await button('Execute approved action').dblclick();
      if (executionTimeout) {
        await section.getByText(/The response could not be confirmed/).waitFor();
        assert.equal(await button('Execute approved action').isDisabled(), true);
        await button('Check saved receipt').click();
        await section.getByRole('heading', { name: 'Receipt · outcome-unknown' }).waitFor();
        accounts[2].capabilities.use = false;
        await refreshIntegrations();
        assert.equal(await section.getByRole('region', { name: 'Immutable write review' }).count(), 0);
        accounts[2].capabilities.use = true;
        await refreshIntegrations();
        assert.equal(
          await button('Execute approved action').isDisabled(),
          true,
          'Restored access cannot replay an uncertain execution',
        );
        await button('Check saved receipt').click();
        assert.equal(requests.filter(item => item.path.endsWith('/execute')).length, executeBefore + 1);
        assert.equal(await button('Prepare a new action').isDisabled(), true);
        await field('I checked the provider and know whether a replacement is needed.').check();
        executionTimeout = false;
      } else await section.getByText('The provider confirmed this action.').waitFor();
      assert.equal(requests.filter(item => item.path.endsWith('/execute')).length, executeBefore + 1);
    }
    await button('Prepare a new action').click();
  }
  assert.equal(new Set(requests.filter(item => item.body?.operation).map(item => item.body.operation.kind)).size, 15);
  if (await button('Select another source').count()) await button('Select another source').click();
  await select('Source account', 'Personal Trello · 55555555');
  await field('Source name').fill('Recovered board');
  await field('Board ID').fill(boardId);
  dropSource = true;
  const sourceCount = sources.length;
  await button('Save source').dblclick();
  await section.getByText(/Source creation is unconfirmed/).waitFor();
  assert.equal(sources.length, sourceCount + 1);
  assert.equal(await button('Save source').isDisabled(), true);
  await button('Refresh sources').click();
  await section
    .getByRole('list', { name: 'Saved Atlassian sources' })
    .getByText('Recovered board', { exact: true })
    .waitFor();
  const sourcePosts = () => requests.filter(item => item.path.endsWith('/sources') && item.method === 'POST').length;
  const sourceReview = section.getByRole('checkbox', {
    name: 'I refreshed sources and checked whether this source was saved.',
  });
  const uncertainSourcePosts = sourcePosts();
  for (const collection of ['sources', 'accounts']) {
    if (collection === 'sources') sourceStatus = 404;
    else accountStatus = 403;
    await refreshIntegrations();
    assert.equal(await field('Source name').count(), 0, `${collection} access loss hides the source draft`);
    assert.equal(await sourceReview.count(), 0, `${collection} access loss hides source reconciliation`);
    assert.equal(await section.getByText(/Source creation is unconfirmed/).count(), 0);
    accountStatus = 200;
    sourceStatus = 200;
    await button(collection === 'sources' ? 'Retry sources' : 'Retry Atlassian accounts').click();
    await field('Source name').waitFor();
    assert.equal(
      await field('Source name').inputValue(),
      'Recovered board',
      `${collection} recovery retains the uncertain source draft`,
    );
    assert.equal(await field('Source account').innerText(), 'Personal Trello · 55555555');
    assert.equal(await field('Board ID').inputValue(), boardId);
    await section.getByText(/Source creation is unconfirmed/).waitFor();
    assert.equal(await sourceReview.isChecked(), false);
    assert.equal(await button('Finish source status review').isDisabled(), true);
    assert.equal(await button('Save source').isDisabled(), true);
    await field('Source name').evaluate(input => input.form.requestSubmit());
    assert.equal(
      sourcePosts(),
      uncertainSourcePosts,
      'Restoring collection access cannot send another source POST before reconciliation',
    );
  }
  await section
    .getByRole('checkbox', { name: 'I refreshed sources and checked whether this source was saved.' })
    .check();
  await button('Finish source status review').click();
  assert.equal(sources.length, sourceCount + 1);
  for (const collection of ['sources', 'accounts']) {
    for (const outcome of ['saved', 'uncertain']) {
      if (await button('Select another source').count()) await button('Select another source').click();
      const draft = `Delayed ${collection} ${outcome}`;
      await field('Source name').fill(draft);
      let releaseSource;
      sourceResponseGate = new Promise(resolve => {
        releaseSource = resolve;
      });
      dropSource = outcome === 'uncertain';
      const before = sourcePosts();
      const sent = page.waitForRequest(
        request => request.url().endsWith('/atlassian/sources') && request.method() === 'POST',
      );
      await button('Save source').click();
      const request = await sent;
      assert.equal(await button('Save source').getAttribute('aria-busy'), 'true');
      if (collection === 'sources') sourceStatus = 404;
      else accountStatus = 403;
      await refreshIntegrations();
      assert.equal(await field('Source name').count(), 0);
      accountStatus = 200;
      sourceStatus = 200;
      await refreshIntegrations();
      assert.equal(await field('Source name').inputValue(), draft);
      assert.equal(
        await button('Save source').getAttribute('aria-busy'),
        'true',
        'A pending source request survives collection failure and restoration',
      );
      assert.equal(await button('Save source').isDisabled(), true);
      await field('Source name').evaluate(input => input.form.requestSubmit());
      assert.equal(sourcePosts(), before + 1);
      if (collection === 'sources') sourceStatus = 404;
      else accountStatus = 403;
      await refreshIntegrations();
      const settled =
        outcome === 'uncertain'
          ? page.waitForEvent('requestfailed', failed => failed === request)
          : page.waitForResponse(response => response.request() === request);
      releaseSource();
      await settled;
      sourceResponseGate = undefined;
      await refreshIntegrations();
      assert.equal(await field('Source name').count(), 0, 'A late creation response keeps the private draft hidden');
      assert.equal(
        await section.getByText('Source saved. Select it below to run an operation.', { exact: true }).count(),
        0,
      );
      assert.equal(await section.getByText(/Source creation is unconfirmed/).count(), 0);
      accountStatus = 200;
      sourceStatus = 200;
      await refreshIntegrations();
      assert.equal(await field('Source name').inputValue(), draft);
      assert.equal(await field('Source account').innerText(), 'Personal Trello · 55555555');
      assert.equal(await field('Board ID').inputValue(), boardId);
      assert.equal(await button('Save source').isDisabled(), true);
      assert.equal(sourcePosts(), before + 1, 'A late creation response and restored access do not repeat the POST');
      if (outcome === 'uncertain') {
        await section.getByText(/Source creation is unconfirmed/).waitFor();
        assert.equal(await sourceReview.isChecked(), false);
        assert.equal(await button('Finish source status review').isDisabled(), true);
        await field('Source name').evaluate(input => input.form.requestSubmit());
        assert.equal(sourcePosts(), before + 1);
        await sourceReview.check();
        await button('Finish source status review').click();
        assert.equal(await button('Save source').isDisabled(), false);
      } else await section.getByText('Source saved. Select it below to run an operation.', { exact: true }).waitFor();
    }
  }
  sourceStatus = 503;
  await button('Refresh sources').click();
  await section.getByText(/Last loaded sources remain visible/).waitFor();
  sourceStatus = 200;
  await button('Refresh sources').click();
  await button('Disable Trello board').click();
  await button('Confirm disable source').click();
  await section.getByText('Source disabled. Pending writes using it cannot execute.').waitFor();
  assert.equal(sources[3].enabled, false);
  const trelloRow = section
    .getByRole('list', { name: 'Atlassian accounts' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'Personal Trello' }) });
  await trelloRow.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.getByRole('heading', { name: 'Atlassian sign-in' }).waitFor();
  await page.goto(`${origin}/acme/integrations#atlassian-heading`);
  await button('Advanced setup').click();
  await trelloRow.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await trelloRow.getByRole('button', { name: 'Confirm disconnect' }).click();
  await trelloRow.getByText(/Account disconnected. Revoke/).waitFor();
  assert.equal(accounts[2].state, 'disconnected');
  const savedProposal = [...proposals.values()].find(item => item.receipt?.status === 'outcome-unknown');
  const executeCount = requests.filter(item => item.path.endsWith('/execute')).length;
  sources[3].enabled = true;
  accounts[2].state = 'active';
  await page.reload();
  await button('Advanced setup').click();
  await button('Recover a saved proposal').click();
  await field('Proposal reference').fill(savedProposal.id);
  await button('Load saved proposal').click();
  await section.getByRole('heading', { name: 'Receipt · outcome-unknown' }).waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Review saved action');
  assert.equal(await button('Execute approved action').isDisabled(), true);
  await button('Check saved receipt').click();
  assert.equal(requests.filter(item => item.path.endsWith('/execute')).length, executeCount);
  await field('I checked the provider and know whether a replacement is needed.').check();
  await button('Prepare a new action').click();
  await select('Operation source', sources[0].name);
  await select('Operation', 'Create Jira issue');
  await field('Project key').fill('OPS');
  await field('Issue type').fill('Task');
  await field('Summary').fill('Delayed review');
  let releaseProposal;
  proposalResponseGate = new Promise(resolve => {
    releaseProposal = resolve;
  });
  const lateProposalCount = requests.filter(item => item.path.endsWith('/operations/proposals')).length;
  const proposalSent = page.waitForRequest(
    request => request.url().endsWith('/operations/proposals') && request.method() === 'POST',
  );
  await button('Prepare write review').click();
  const pendingProposal = await proposalSent;
  accounts[0].capabilities.use = false;
  await refreshIntegrations();
  const proposalReceived = page.waitForResponse(response => response.request() === pendingProposal);
  releaseProposal();
  await (await proposalReceived).finished();
  proposalResponseGate = undefined;
  await refreshIntegrations();
  assert.equal(
    await section.getByRole('region', { name: 'Immutable write review' }).count(),
    0,
    'Late proposal stays hidden after revocation',
  );
  accounts[0].capabilities.use = true;
  await refreshIntegrations();
  await section.getByRole('heading', { name: 'Review saved action' }).waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Review saved action');
  assert.equal(requests.filter(item => item.path.endsWith('/operations/proposals')).length, lateProposalCount + 1);
  await field('Source name').focus();
  await button('Refresh Atlassian integrations').evaluate(element => element.click());
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      button => button.textContent === 'Check integration status' && button.getAttribute('aria-busy') === 'false',
    ),
  );
  assert.equal(
    await field('Source name').evaluate(element => element === document.activeElement),
    true,
    'Refreshing an admitted review does not steal focus',
  );
  await button('Check saved receipt').evaluate(element => element.click());
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      button => button.textContent === 'Check saved receipt' && !button.disabled,
    ),
  );
  assert.equal(
    await field('Source name').evaluate(element => element === document.activeElement),
    true,
    'Updating the same proposal does not steal focus',
  );
  mcpEnabled = false;
  await refreshIntegrations();
  assert.equal(
    await section.getByRole('region', { name: 'Immutable write review' }).count(),
    0,
    'MCP admission hides the review',
  );
  mcpEnabled = true;
  await refreshIntegrations();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Review saved action');
  assert.equal(
    requests.filter(item => item.path.endsWith('/operations/proposals')).length,
    lateProposalCount + 1,
    'Restoring MCP admission does not resend a proposal',
  );
  await button('Reject action').click();
  await button('Prepare a new action').click();
  const workRow = section
    .getByRole('list', { name: 'Atlassian accounts' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'Work Atlassian' }) });
  await workRow.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.getByRole('heading', { name: 'Atlassian sign-in' }).waitFor();
  await page.goto(`${origin}/acme/integrations#atlassian-heading`);
  await button('Advanced setup').click();
  consentDelay = 1200;
  await workRow.getByRole('button', { name: 'Reconnect', exact: true }).click();
  accounts[0].capabilities.manage = false;
  await refreshIntegrations();
  await page.waitForTimeout(1400);
  assert.equal(new URL(page.url()).origin, origin, 'Late reconnect cannot navigate after access loss');
  accounts[0].capabilities.manage = true;
  consentDelay = 0;
  await refreshIntegrations();
  await field('Shared business account').check();
  await button('Connect account').click();
  await page.getByRole('heading', { name: 'Atlassian sign-in' }).waitFor();
  await page.goto(`${origin}/acme/integrations#atlassian-heading`);
  await button('Advanced setup').click();
  await field('Shared business account').check();
  consentDelay = 1200;
  await button('Connect account').click();
  admin = false;
  await refreshIntegrations();
  // Shared business accounts are no longer admin-only (cloud e445ed86 #478, features/atlassian/accounts.tsx:41,51), so admin loss does not stop consent.
  await page.getByRole('heading', { name: 'Atlassian sign-in' }).waitFor();
  await page.goto(`${origin}/acme/integrations#atlassian-heading`);
  await button('Advanced setup').click();
  consentDelay = 0;
  admin = false;
  accounts[0].capabilities.manage = false;
  await button('Refresh Atlassian integrations').click();
  await page.waitForTimeout(200);
  assert.equal(await button('Manage use grants').count(), 0);
  assert.equal(await field('Shared business account').count(), 1);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await select('Operation source', sources[1].name);
  await select('Operation', 'Update Confluence page');
  await field('Page title').fill('A long title '.repeat(30));
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement !== document.body), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (screenshotDir) {
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${screenshotDir}/mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await page.screenshot({ path: `${screenshotDir}/desktop.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  process.stdout.write(
    'Atlassian browser checks passed. Direct sign-in navigation, unfinished-account reuse, callback success/denial/failure, Jira and Confluence shared setup, advanced disclosure, all 15 structured operations, grants, four source bindings, read retries, retained drafts, approval and receipt recovery, disconnect, revocation, delayed responses, and mobile dark/reduced-motion checks. Provider and API responses were fixtures; no live consent or provider writes.\n',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
