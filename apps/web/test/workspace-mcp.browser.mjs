import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';

const port = Number(process.env.MCP_BROWSER_PORT ?? 20000 + Math.floor(Math.random() * 30000));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: new URL('..', import.meta.url), stdio: 'ignore' },
);
let browser, page;
const workspace = {
  id: randomUUID(),
  slug: 'mcp-proof',
  name: 'MCP browser proof',
  status: 'ready',
  createdAt: '2026-10-02T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
const agentId = randomUUID(),
  teamId = randomUUID(),
  chatId = randomUUID(),
  taskId = randomUUID();
const longTool = `inspect_${'customer_account_contract_'.repeat(8)}`;
const tool = {
  name: longTool,
  description: 'Untrusted tool ![remote](https://untrusted.example/track.png)',
  revision: 'tool-revision-2',
  previousRevision: 'tool-revision-1',
  inputSchema: { type: 'object', properties: { customer: { type: 'string' } } },
  outputSchema: null,
  compatibility: 'compatible',
  reason: null,
  review: 'changed',
  enabled: false,
  standingException: false,
};
const integration = {
  id: randomUUID(),
  name: 'Private customer service',
  ownership: 'personal',
  endpoint: 'https://mcp.example.com/mcp',
  accountLabel: 'Private account Ada',
  authMethod: 'bearer',
  status: 'ready',
  version: 1,
  authorizationEpoch: 2,
  canManage: true,
  canUse: true,
  barrier: null,
  statusReason: null,
};
const shared = {
  ...integration,
  id: randomUUID(),
  name: 'Shared operations',
  ownership: 'shared',
  accountLabel: 'Operations credential',
};
const details = new Map(
  [integration, shared].map(item => [
    item.id,
    {
      integration: item,
      tools: [structuredClone(tool)],
      grants: [],
      grantOptions: [
        { kind: 'member', id: 'membership-incarnation-1', label: 'Ada' },
        { kind: 'team', id: teamId, label: 'Operations' },
      ],
      descriptor: {
        kind: 'reviewable',
        id: 'descriptor-1',
        label: 'Customer service',
        identity: 'reviewed-endpoint-contract-1',
      },
    },
  ]),
);
const slot = {
  slotId: 'customer-slot',
  serverIdentity: 'reviewed-endpoint-contract-1',
  label: 'Customer service',
  binding: { kind: 'personal' },
  tools: [{ name: longTool, revision: tool.revision }],
};
let permissions = {
    savedRevision: 'a'.repeat(40),
    activeRevision: 'older-active-revision',
    canEdit: true,
    slots: [],
    choices: [slot],
  },
  agentReceipt;
const selection = {
  id: 'selection-1',
  version: 0,
  bindings: [],
  stale: false,
  choices: [{ integration, slotId: null, slotLabel: null, unavailableReason: null }],
};
const selections = new Map();
const action = {
  id: randomUUID(),
  digest: 'immutable-action-digest',
  integrationId: integration.id,
  integrationName: integration.name,
  status: 'awaiting-approval',
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
  canDecide: true,
  canReconcile: true,
  integrationPaused: false,
  reconciliation: null,
  receipt: null,
  visibility: 'full',
  exact: {
    origin: { kind: 'chat', id: chatId },
    requester: 'Ada',
    endpoint: integration.endpoint,
    accountLabel: integration.accountLabel,
    authorizationEpoch: 2,
    toolName: longTool,
    toolRevision: tool.revision,
    arguments: { customer: 'Confidential customer', note: '![remote](https://untrusted.example/argument.png)' },
    sourceLabels: ['Private requester message', 'Protected source invoice'],
    outboundConsentRequired: true,
    standingExceptionApplied: true,
  },
};
let actions = [],
  enabled = true,
  dispatch = true,
  listStatus = 200,
  catalogStatus = 200,
  catalogDelay = 0,
  actionStatus = 200,
  actionDelay = 0,
  setupMode = 'saved';
const writes = [],
  errors = [],
  remoteLoads = [],
  mcpReads = [];
const agent = {
  id: agentId,
  name: 'Customer assistant',
  owningTeamId: teamId,
  savedRevision: permissions.savedRevision,
  definitionRevision: 'b'.repeat(64),
  definition: { name: 'Customer assistant', instructions: 'Inspect customer contracts.', tools: [] },
  capabilities: ['read', 'edit', 'invoke'],
  admin: false,
  activations: [
    {
      id: randomUUID(),
      revision: 'a'.repeat(40),
      definitionRevision: 'b'.repeat(64),
      scope: [],
      createdAt: '2026-10-02T00:00:00Z',
    },
  ],
};
try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    assert.ok(attempt < 150 && server.exitCode === null);
    await setTimeout(100);
  }
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(60000);
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => {
    if (request.url().includes('untrusted.example')) remoteLoads.push(request.url());
  });
  await page.route('**/v1/**', async route => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      method = request.method();
    let json,
      status = 200;
    if (path.includes('/workspace-mcp')) {
      const suffix = path.split('/workspace-mcp')[1];
      if (method === 'GET') mcpReads.push(suffix);
      if (method !== 'GET') {
        writes.push({ suffix, body: request.postDataJSON() });
        await setTimeout(180);
      }
      const body = method === 'GET' ? null : request.postDataJSON();
      if (suffix === '/capabilities')
        json = enabled
          ? { enabled: true, canManageShared: true, integrationsEnabled: true, dispatchEnabled: dispatch }
          : { enabled: false };
      else if (suffix === '/catalog') {
        await setTimeout(catalogDelay);
        status = catalogStatus;
        json = {
          source: 'Official MCP Registry',
          snapshotVersion: 'snapshot-2026-10-02',
          syncedAt: '2026-10-01T00:00:00Z',
          stale: true,
          entries:
            url.searchParams.get('search') === 'no-match'
              ? []
              : [
                  {
                    id: 'registry-1',
                    name: 'Registry customer server',
                    description: '![remote](https://untrusted.example/catalog.png)',
                    version: '1.2.3',
                    endpoint: integration.endpoint,
                    compatibility: 'eligible',
                    reason: null,
                    authentication: 'unknown',
                  },
                ],
          nextCursor: null,
        };
      } else if (suffix === '/integrations' && method === 'GET') {
        status = listStatus;
        json = { integrations: [...details.values()].map(item => item.integration) };
      } else if (suffix === '/integrations' || suffix.endsWith('/setup')) {
        const next = {
          ...integration,
          id: suffix.endsWith('/setup') ? suffix.split('/')[2] : randomUUID(),
          name: body.name,
          endpoint: body.endpoint,
          ownership: body.ownership,
          authMethod: body.auth.kind,
          status:
            setupMode === 'saved'
              ? 'review-required'
              : setupMode === 'oauth'
                ? 'oauth-pending'
                : 'registration-required',
        };
        details.set(next.id, {
          integration: next,
          tools: [],
          grants: [],
          grantOptions: [],
          descriptor: { kind: 'chat-only', reason: 'No approved descriptor yet.' },
        });
        json =
          setupMode === 'registration-required'
            ? {
                kind: setupMode,
                integration: next,
                registration: {
                  instructions: 'Register with your provider administrator.',
                  redirectUri: 'https://api.tulipfarm.ai/mcp/callback',
                  clientMetadataUrl: 'https://api.tulipfarm.ai/mcp/client.json',
                },
              }
            : setupMode === 'oauth'
              ? { kind: setupMode, integration: next, authorizationUrl: 'https://provider.example/authorize' }
              : { kind: 'saved', integration: next };
      } else if (suffix.startsWith('/integrations/')) {
        const id = suffix.split('/')[2],
          detail = details.get(id);
        if (suffix.endsWith('/tools')) {
          detail.tools = detail.tools.map(item => ({
            ...item,
            ...body.tools.find(candidate => candidate.name === item.name),
            review: 'reviewed',
          }));
          detail.integration.version++;
        }
        if (suffix.endsWith('/grants')) {
          detail.grants = body.grants;
          detail.managers = body.managers;
          detail.integration.version++;
        }
        if (suffix.endsWith('/descriptor')) {
          detail.descriptor.kind = 'approved';
          detail.integration.version++;
        }
        if (suffix.endsWith('/lifecycle')) {
          if (body.operation === 'delete') details.delete(id);
          else
            detail.integration.status =
              body.operation === 'enable' ? 'ready' : body.operation === 'disable' ? 'disabled' : 'disconnected';
          json = { saved: true };
        } else json = detail;
      } else if (suffix.startsWith('/selections/')) {
        let value = selections.get(suffix);
        if (!value) {
          value = structuredClone(selection);
          value.id = suffix.split('/').at(-1);
          if (!suffix.includes('/chat/'))
            value.choices[0] = { ...value.choices[0], slotId: slot.slotId, slotLabel: slot.label };
          selections.set(suffix, value);
        }
        if (body) {
          value.bindings = body.bindings;
          value.version++;
          value.stale = false;
        }
        json = value;
      } else if (suffix.includes('/permissions')) {
        if (body) {
          permissions = { ...permissions, slots: body.slots, savedRevision: 'c'.repeat(40) };
          agent.savedRevision = permissions.savedRevision;
          agent.definition.mcp = body.slots.map(slot => ({
            id: slot.slotId,
            serverIdentity: slot.serverIdentity,
            tools: slot.tools,
            ...(slot.binding.kind === 'shared' ? { integrationId: slot.binding.integrationId } : {}),
          }));
        }
        json = permissions;
      } else if (suffix === '/actions') {
        await setTimeout(actionDelay);
        status = actionStatus;
        json = { actions, nextCursor: null };
      } else if (suffix.endsWith('/decision')) {
        assert.equal(body.digest, actions[0].digest);
        actions[0] = {
          ...actions[0],
          status: body.decision === 'reject' ? 'rejected' : 'outcome-unknown',
          integrationPaused: body.decision === 'approve',
          receipt:
            body.decision === 'approve'
              ? {
                  dispatchedAt: new Date().toISOString(),
                  receivedAt: null,
                  outcome: 'unknown',
                  text: null,
                  structured: null,
                }
              : null,
        };
        json = actions[0];
      } else if (suffix.endsWith('/reconciliation')) {
        actions[0] = {
          ...actions[0],
          integrationPaused: body.outcome === 'still-unknown',
          canReconcile: body.outcome === 'still-unknown',
          reconciliation: {
            ...body,
            notes: actions[0].visibility === 'full' ? body.notes : '',
            observedAt: new Date().toISOString(),
            observer: 'Ada',
            administrative: false,
          },
        };
        json = actions[0];
      }
    } else if (path === '/v1/auth/get-session')
      json = {
        session: { id: 'mcp-session', userId: 'ada' },
        user: { id: 'ada', name: 'Ada', email: 'ada@example.test' },
      };
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
    else if (path.endsWith('/governance/me'))
      json = {
        membershipId: workspace.id,
        role: 'member',
        teams: [{ id: teamId, name: 'Operations' }],
        capabilities: { manageGovernance: false, canLeave: true },
      };
    else if (path.endsWith('/model-catalog')) json = chatCatalog;
    else if (path.endsWith('/agents/authoring-context'))
      json = { currentSoulRevision: agent.savedRevision, teams: [{ id: teamId, name: 'Operations' }], admin: false };
    else if (path.includes('/agents/commands/')) json = agentReceipt;
    else if (path.endsWith(`/agents/${agentId}`)) {
      if (method === 'PUT') {
        const body = request.postDataJSON();
        writes.push({ suffix: '/ordinary-agent-save', body });
        agent.definition = body.definition;
        agent.savedRevision = 'd'.repeat(40);
        agentReceipt = { commandId: randomUUID(), agentId, savedRevision: agent.savedRevision, status: 'accepted' };
        json = agentReceipt;
      } else json = agent;
    } else if (path.endsWith('/chat/availability') || path.endsWith(`/agents/${agentId}/chat`))
      json = { configured: true };
    else if (path.includes('/conversations/'))
      json = path.endsWith('/messages')
        ? {
            messages: [
              {
                id: randomUUID(),
                sequence: 1,
                author: 'assistant',
                createdAt: '2026-10-02T00:00:00Z',
                parts: [
                  {
                    kind: 'text',
                    text: 'Retained confidential answer ![remote](https://untrusted.example/history.png)',
                  },
                ],
                turn: null,
                tools: [],
              },
            ],
            nextBefore: null,
            hasGitHubProposals: false,
          }
        : {
            id: chatId,
            title: 'Protected chat title',
            titleRevision: 1,
            titleManual: true,
            archived: false,
            activityAt: '2026-10-02T00:00:00Z',
            createdAt: '2026-10-02T00:00:00Z',
          };
    else if (path.endsWith('/agent-tasks') && method === 'POST') {
      writes.push({ suffix: '/task-start', body: request.postDataJSON() });
      json = { id: taskId, generation: 0, status: 'pending' };
    }
    // Task summaries carry delegation fields since cloud aed31db6 (#803), packages/agents/src/task-contracts.ts:52.
    else if (path.includes('/agent-tasks/'))
      json = path.endsWith('/history')
        ? {
            messages: [
              {
                sequence: 1,
                role: 'owner',
                text: 'Inspect private task',
                generation: 0,
                createdAt: '2026-10-02T00:00:00Z',
                sources: [],
              },
            ],
            nextCursor: null,
          }
        : path.endsWith('/proposals')
          ? { proposals: [], nextCursor: null }
          : {
              id: taskId,
              agentId,
              status: 'completed',
              definitionRevision: 'b'.repeat(64),
              activationId: agent.activations[0].id,
              generation: 0,
              parentTaskId: null,
              delegationDepth: 0,
              skills: [],
              scope: [],
              flowId: randomUUID(),
              createdAt: '2026-10-02T00:00:00Z',
              updatedAt: '2026-10-02T00:00:00Z',
              limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
              toolCalls: 1,
              activeMilliseconds: '1000',
              cost: { chargedCreditUnits: '0', heldCreditUnits: '0' },
            };
    if (!json) {
      status = 404;
      json = { error: 'not-found' };
    }
    if (status !== 200) json = { error: 'fixture-unavailable' };
    await route.fulfill({ status, json });
  });
  const go = path => page.goto(`${origin}/${workspace.slug}${path}`);
  const changed = (family = 'actions') =>
    page.evaluate(
      ({ workspaceId, family }) => {
        const channel = new BroadcastChannel('tulipfarm:query:v1');
        channel.postMessage({
          version: 1,
          id: crypto.randomUUID(),
          sessionId: 'mcp-session',
          scope: { kind: 'workspace', userId: 'ada', workspaceId, membershipId: workspaceId },
          kind: 'change',
          keys: [['workspace-mcp', family]],
        });
        channel.close();
      },
      { workspaceId: workspace.id, family },
    );
  const select = async (label, option) => {
    await page.getByRole('combobox', { name: label, exact: true }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };

  enabled = false;
  await go('/integrations');
  await page.getByRole('heading', { name: 'Integrations', exact: true }).waitFor();
  await setTimeout(400);
  assert.equal(await page.getByRole('heading', { name: 'Custom MCP integrations' }).count(), 0);
  enabled = true;
  listStatus = 503;
  await page.reload();
  await page.getByRole('heading', { name: 'MCP integrations could not load' }).waitFor();
  await page.getByRole('button', { name: 'Check mcp integrations again' }).click();
  await page.getByRole('heading', { name: 'MCP integrations could not load' }).waitFor();
  listStatus = 200;
  await page.getByRole('button', { name: 'Check mcp integrations again' }).click();
  await page.getByRole('button', { name: `Manage ${integration.name}` }).waitFor();
  const beforeFocus = mcpReads.length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await setTimeout(300);
  assert.equal(mcpReads.length, beforeFocus, 'window focus does not bypass MCP query freshness');
  catalogDelay = 500;
  await page.getByRole('button', { name: 'Find MCP servers' }).click();
  await page.getByRole('status', { name: 'Loading mcp catalog' }).waitFor();
  await page.getByText(/The Registry snapshot is stale/).waitFor();
  assert.equal(
    await page.getByRole('link', { name: 'mcpservers.org' }).getAttribute('href'),
    'https://mcpservers.org/',
  );
  catalogDelay = 0;
  catalogStatus = 503;
  await changed('catalog');
  await page.getByRole('button', { name: 'Check mcp catalog again' }).waitFor();
  await page.getByRole('heading', { name: 'Registry customer server' }).waitFor();
  await page.getByRole('button', { name: 'Add MCP endpoint' }).click();
  await page.getByRole('textbox', { name: 'Integration name', exact: true }).fill('No auth proof');
  await page.getByRole('textbox', { name: 'MCP endpoint' }).fill(integration.endpoint);
  await select('Authentication', 'No authentication');
  const count = writes.length;
  await page.getByRole('button', { name: 'Verify and discover tools' }).dblclick();
  await page.getByRole('button', { name: 'Review integration', exact: true }).waitFor();
  assert.equal(writes.length, count + 1);
  assert.deepEqual(writes.at(-1).body.auth, { kind: 'none' });
  await page.getByRole('button', { name: 'Close setup' }).click();
  catalogStatus = 200;
  await page.getByRole('button', { name: 'Check mcp catalog again' }).click();
  await page.getByRole('searchbox', { name: 'Search MCP Registry' }).fill('no-match');
  await page.getByRole('button', { name: 'Search catalog' }).click();
  await page.getByRole('heading', { name: 'No matching remote servers' }).waitFor();
  await page.getByRole('button', { name: 'Clear search', exact: true }).last().click();
  await page.getByRole('button', { name: 'Set up Registry customer server' }).click();
  await page.getByText(/missing metadata does not mean no authentication/).waitFor();
  await select('Authentication', 'Bearer token');
  await page.getByLabel('Bearer token', { exact: true }).fill('fixture-secret');
  await page.getByRole('button', { name: 'Verify and discover tools' }).click();
  await page.getByRole('button', { name: 'Review integration', exact: true }).waitFor();
  assert.equal(writes.at(-1).body.auth.token, 'fixture-secret');
  assert.equal(await page.getByLabel('Bearer token', { exact: true }).inputValue(), '');
  await page.getByRole('button', { name: 'Close setup' }).click();
  await page.getByRole('button', { name: 'Add MCP endpoint' }).click();
  await page.getByLabel('Integration name', { exact: true }).fill('Headers proof');
  await page.getByLabel('MCP endpoint').fill(integration.endpoint);
  await select('Authentication', 'Secret headers / API key');
  await page.getByLabel('Header name 1').fill('X-Api-Key');
  await page.getByLabel('Header secret 1').fill('header-secret');
  await page.getByRole('button', { name: 'Verify and discover tools' }).click();
  await page.getByRole('button', { name: 'Review integration', exact: true }).waitFor();
  assert.deepEqual(writes.at(-1).body.auth.headers, [{ name: 'X-Api-Key', value: 'header-secret' }]);
  await page.getByRole('button', { name: 'Close setup' }).click();
  setupMode = 'registration-required';
  await page.getByRole('button', { name: 'Add MCP endpoint' }).click();
  await page.getByLabel('Integration name', { exact: true }).fill('OAuth proof');
  await page.getByLabel('MCP endpoint').fill(integration.endpoint);
  await select('Authentication', 'OAuth');
  await page.getByRole('button', { name: 'Start OAuth setup' }).click();
  await page.getByRole('heading', { name: 'Register an OAuth client' }).waitFor();
  await page.getByLabel('Registered client ID, if required').fill('registered-client');
  setupMode = 'oauth';
  await page.getByRole('button', { name: 'Start OAuth setup' }).click();
  await page.getByRole('heading', { name: 'Authorization pending' }).waitFor();
  assert.equal(await page.locator('a[href="https://provider.example/authorize"]').getAttribute('target'), '_blank');
  await page.getByRole('button', { name: 'Close setup' }).click();
  await page.getByRole('button', { name: `Manage ${integration.name}` }).click();
  await page.getByText('Changed, paused until reviewed', { exact: true }).waitFor();
  await page.getByRole('checkbox', { name: `Enable reviewed tool ${longTool}` }).check();
  await page.getByRole('checkbox', { name: `Standing exception for ${longTool}` }).check();
  await page.getByRole('button', { name: 'Save reviewed tools' }).click();
  await page.getByText('Reviewed', { exact: true }).waitFor();
  assert.equal(details.get(integration.id).tools[0].standingException, true);
  await page.getByRole('button', { name: 'Approve account-independent descriptor' }).click();
  await page.getByText('Descriptor approved').waitFor();
  await page.getByRole('button', { name: 'Disable integration', exact: true }).click();
  await page.getByRole('button', { name: 'Enable integration', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Enable integration', exact: true }).click();
  await page.getByRole('button', { name: 'Disable integration', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close integration details' }).click();
  await page.getByRole('button', { name: `Manage ${shared.name}` }).click();
  await page.getByRole('checkbox', { name: 'Ada (member)', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Operations (team)', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Allow Ada to manage and share', exact: true }).check();
  await page.getByRole('button', { name: 'Save shared grants' }).click();
  await page.getByText('Change confirmed by the server.', { exact: true }).waitFor();
  assert.equal(details.get(shared.id).grants.length, 2);
  assert.deepEqual(details.get(shared.id).managers, [{ kind: 'member', id: 'membership-incarnation-1' }]);
  for (const [method, label] of [
    ['none', 'none, public client'],
    ['client_secret_basic', 'client_secret_basic, HTTP Basic'],
    ['client_secret_post', 'client_secret_post, request body'],
  ]) {
    await page.getByRole('button', { name: 'Add MCP endpoint' }).click();
    await page.getByLabel('Integration name', { exact: true }).fill(`Registered ${method}`);
    await page.getByLabel('MCP endpoint').fill('https://both-methods.example/mcp');
    await select('Authentication', 'OAuth');
    await page.getByLabel('Registered client ID, if required').fill(`client-${method}`);
    await select('Registered client authentication method', label);
    if (method !== 'none') await page.getByLabel('Client secret, if required').fill('registered-secret');
    await page.getByRole('button', { name: 'Start OAuth setup' }).click();
    await page.getByRole('heading', { name: 'Authorization pending' }).waitFor();
    assert.equal(writes.at(-1).body.auth.client.authMethod, method);
    assert.equal(writes.at(-1).body.endpoint, 'https://both-methods.example/mcp');
    await page.getByRole('button', { name: 'Close setup' }).click();
  }

  await go(`/chat/${chatId}`);
  await page.getByText('Retained confidential answer', { exact: false }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'MCP integration selection' }).count(), 0);
  assert.equal(await page.getByRole('region', { name: 'MCP actions and receipts' }).count(), 0);
  actions = [structuredClone(action)];
  await changed();
  await page.getByRole('button', { name: 'Approve exact MCP action' }).waitFor();
  assert.deepEqual(JSON.parse(await page.getByLabel('Exact MCP arguments').innerText()), action.exact.arguments);
  const before = writes.length;
  await page.getByRole('button', { name: 'Approve exact MCP action' }).focus();
  await page.keyboard.press('Enter');
  await page.getByText('Outcome unknown', { exact: true }).waitFor();
  assert.equal(writes.length, before + 1);
  assert.equal(await page.getByRole('button', { name: /retry|execute|approve/i }).count(), 0);
  await page.getByLabel('Evidence and notes').fill('External service still unavailable.');
  await page.getByRole('button', { name: 'Record reconciliation' }).click();
  await page.getByRole('region', { name: 'Human reconciliation' }).waitFor();
  assert.equal(actions[0].integrationPaused, true);
  await page.reload();
  await page.getByText('Outcome unknown', { exact: true }).waitFor();
  await select('Observed outcome', 'Confirmed not performed');
  await page.getByLabel('Evidence and notes').fill('Provider audit log confirms no operation.');
  await page.getByRole('button', { name: 'Record reconciliation' }).click();
  await page
    .getByRole('region', { name: 'Human reconciliation' })
    .getByText('Provider audit log confirms no operation.', { exact: true })
    .waitFor();
  assert.equal(actions[0].status, 'outcome-unknown');
  assert.equal(actions[0].integrationPaused, false);
  actions = [
    {
      ...actions[0],
      visibility: 'requester-metadata',
      canDecide: false,
      canReconcile: true,
      integrationPaused: true,
      reconciliation: null,
      receipt: null,
    },
  ];
  delete actions[0].exact;
  await changed();
  await page.getByRole('heading', { name: 'MCP action status', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Exact MCP arguments').count(), 0);
  assert.equal(await page.getByText(/The requester has left/).count(), 0);
  assert.equal(await page.getByText('Provider audit log confirms no operation.', { exact: true }).count(), 0);
  await page.getByText(/Arguments, results, and previous notes are concealed/).waitFor();
  await select('Observed outcome', 'Confirmed not performed');
  await page.getByLabel('Evidence and notes').fill('Independent private recovery evidence');
  await page.getByRole('button', { name: 'Record reconciliation' }).click();
  await page
    .getByRole('region', { name: 'Human reconciliation' })
    .getByText(/not-performed/)
    .waitFor();
  assert.equal(await page.getByRole('button', { name: 'Record reconciliation' }).count(), 0);
  assert.equal(await page.getByText('Independent private recovery evidence', { exact: true }).count(), 0);
  assert.equal(actions[0].integrationPaused, false);
  actions = [{ ...structuredClone(action), expiresAt: new Date(Date.now() + 600).toISOString() }];
  await page.reload();
  await page.getByText(/This exact approval expired/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve exact MCP action' }).count(), 0);
  actions = [structuredClone(action)];
  await page.reload();
  await page.getByRole('button', { name: 'Reject MCP action' }).click();
  await page.getByText('Rejected before dispatch', { exact: true }).waitFor();
  actions = [
    {
      ...structuredClone(action),
      status: 'succeeded',
      receipt: {
        dispatchedAt: '2026-10-02T00:00:00Z',
        receivedAt: '2026-10-02T00:00:01Z',
        outcome: 'succeeded',
        text: '![remote](https://untrusted.example/result.png)',
        structured: { safe: true },
      },
    },
  ];
  await page.reload();
  await page.getByText('Provider receipt received', { exact: true }).waitFor();
  actionStatus = 503;
  await changed();
  await page.getByRole('button', { name: 'Check connected-tool actions again' }).waitFor();
  await page.getByText('Provider receipt received', { exact: true }).waitFor();
  actionStatus = 200;
  await page.getByRole('button', { name: 'Check connected-tool actions again' }).click();
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.screenshot({
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/workspace-mcp-mobile.png',
    fullPage: true,
  });
  actionStatus = 403;
  await changed();
  await page.getByRole('heading', { name: 'Private context access changed' }).waitFor();
  assert.equal(await page.getByText('Retained confidential answer', { exact: false }).count(), 0);
  assert.equal(await page.getByLabel('Exact MCP arguments').count(), 0);
  assert.equal(await page.getByText('Protected chat title', { exact: true }).count(), 0);
  actionStatus = 200;
  actions = [];
  await page.setViewportSize({ width: 1440, height: 1000 });
  await go(`/agents/${agentId}`);
  await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
  await page.getByRole('region', { name: 'Agent MCP allowlist' }).waitFor();
  const allowlist = page.getByRole('region', { name: 'Agent MCP allowlist' });
  assert.equal(await allowlist.getByText(/Private account Ada|Private customer service/).count(), 0);
  await allowlist.getByRole('checkbox').check();
  await allowlist.getByRole('button', { name: 'Save MCP allowlist' }).click();
  await allowlist.getByText('c'.repeat(40), { exact: true }).waitFor();
  assert.deepEqual(permissions.slots, [slot]);
  assert.equal(JSON.stringify(writes.at(-1).body).includes(integration.id), false);
  await page.reload();
  await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Instructions', exact: true })
    .fill('Inspect carefully without changing MCP permissions.');
  await page.getByRole('button', { name: 'Save agent', exact: true }).click();
  await page.getByText('Agent saved.', { exact: true }).waitFor();
  assert.deepEqual(writes.find(write => write.suffix === '/ordinary-agent-save').body.definition.mcp, [
    { id: slot.slotId, serverIdentity: slot.serverIdentity, tools: slot.tools },
  ]);
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Single-step request', exact: true }).click();
  await page.getByRole('region', { name: 'Agent chat', exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole('region', { name: 'Agent chat', exact: true })
      .getByRole('region', { name: 'MCP integration selection' })
      .count(),
    0,
  );
  await page.getByRole('textbox', { name: 'What should this agent do?' }).fill('Inspect the private customer.');
  const start = page.getByRole('region', { name: 'Run agent now' });
  await start.getByRole('checkbox', { name: /Private customer service/ }).check();
  await start.getByText(/Save your MCP integration selection/).waitFor();
  assert.equal(await start.getByRole('button', { name: 'Start task', exact: true }).isDisabled(), true);
  await start.getByRole('button', { name: 'Save MCP selection' }).click();
  await start.getByText('Change confirmed by the server.', { exact: true }).waitFor();
  assert.equal(await start.getByText(/Save your MCP integration selection/).count(), 0);
  await page.screenshot({
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/workspace-mcp-desktop.png',
    fullPage: true,
  });
  await start.getByRole('button', { name: 'Start task', exact: true }).click();
  await page.waitForURL(`**/agent-tasks/${taskId}`);
  assert.ok(writes.find(write => write.suffix === '/task-start').body.mcpSelection);
  await page.getByRole('heading', { name: 'MCP integrations for this private task' }).waitFor();
  actionStatus = 403;
  await changed();
  await page.getByRole('heading', { name: 'Private task access changed' }).waitFor();
  assert.equal(await page.getByText('Inspect private task', { exact: true }).count(), 0);
  actionStatus = 200;
  const taskStarts = () => writes.filter(write => write.suffix === '/task-start');
  for (const dispatchEnabled of [false, true]) {
    dispatch = dispatchEnabled;
    await go(`/agents/${agentId}`);
    const textOnly = page.getByRole('region', { name: 'Run agent now' });
    await textOnly.getByText('No integrations selected. This task has no custom MCP tools.', { exact: true }).waitFor();
    await page
      .getByRole('textbox', { name: 'What should this agent do?' })
      .fill('Classify this fictional support report.');
    const before = taskStarts().length;
    await textOnly.getByRole('button', { name: 'Start task', exact: true }).click();
    await page.waitForURL(`**/agent-tasks/${taskId}`);
    assert.equal(taskStarts().length, before + 1);
    assert.equal(
      'mcpSelection' in taskStarts().at(-1).body,
      false,
      `text-only start sends no MCP receipt when dispatch is ${dispatchEnabled ? 'enabled' : 'disabled'}`,
    );
  }
  await go('/workflows');
  await page.getByRole('heading', { name: 'Workflows', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'MCP integration selection' }).count(), 0);
  assert.deepEqual(remoteLoads, []);
  assert.deepEqual(errors, []);
  console.log(
    'PASS fixture-backed MCP catalog/setup/tool review/grants/lifecycle, personal chat/task selections, account-independent agent allowlist, exact approval/rejection/expiry, unknown barrier/reconciliation, receipt, refresh/access-loss, keyboard, themes/mobile/long names, and no remote image requests. This is not real API/storage P8 proof.',
  );
} catch (error) {
  console.error(await page?.locator('body').innerText(), errors);
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
