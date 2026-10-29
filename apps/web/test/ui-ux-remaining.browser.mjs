import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { assertConfiguration, showWorkflowList } from './workflow-definition.fixture.mjs';
import { governanceSnapshot } from './governance-snapshot.mjs';

const baseline = process.env.UI_BASELINE === '1';
const output = new URL('../../../docs/evidence/ui-ux-remaining/', import.meta.url);
await mkdir(output, { recursive: true });
const port = 5459,
  origin = `http://127.0.0.1:${port}`;
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: process.env.UI_APP_ROOT ?? new URL('..', import.meta.url),
  stdio: 'ignore',
});
const ids = Array.from(
  { length: 9 },
  (_, i) =>
    `${i + 1}`.repeat(8) +
    '-' +
    `${i + 1}`.repeat(4) +
    '-4' +
    `${i + 1}`.repeat(3) +
    '-8' +
    `${i + 1}`.repeat(3) +
    '-' +
    `${i + 1}`.repeat(12),
);
const [wid, mid, tid, aid, rid, sid, taskId, cid, activationId] = ids;
const at = '2026-09-30T09:00:00Z';
const workspace = {
  id: wid,
  slug: 'acme',
  name: 'Acme Operations',
  status: 'ready',
  createdAt: at,
  soulCommit: 'a'.repeat(40),
};
const teams = [{ id: tid, name: 'Customer Operations', description: 'Customer support', membershipIds: [mid] }];
const families = [
  {
    id: 'claude-sonnet',
    displayName: 'Claude Sonnet',
    vendor: 'anthropic',
    provider: 'anthropic',
    currentVersion: 'sonnet-v1',
    inputCreditsPerMillionTokens: 300,
    outputCreditsPerMillionTokens: 1500,
    available: true,
    unavailableReason: null,
    mappingRevision: 'mapping-1',
    pricingRevision: 'pricing-1',
    fallbackFor: [],
  },
];
const field = {
  id: sid,
  label: 'Customer name',
  kind: 'text',
  required: true,
  unique: false,
  columnName: `f_${sid.replaceAll('-', '')}`,
};
const definition = {
  formatVersion: 1,
  id: rid,
  label: 'Customers',
  revision: 'a'.repeat(40),
  tableName: `r_${rid.replaceAll('-', '')}`,
  fields: [field],
};
const capabilities = {
  manageSchema: true,
  createRecord: true,
  readRecords: true,
  updateRecord: true,
  deleteRecord: true,
  confirmMigration: true,
};
const resource = {
  id: rid,
  owningTeamId: tid,
  name: 'Customers',
  savedRevision: definition.revision,
  appliedRevision: definition.revision,
  appliedDefinition: definition,
  maintenance: false,
  migration: null,
};
const agent = {
  id: aid,
  name: 'Customer follow-up assistant',
  owningTeamId: tid,
  savedRevision: 'a'.repeat(40),
  definitionRevision: 'b'.repeat(64),
  definition: {
    name: 'Customer follow-up assistant',
    instructions: 'Review customer rows and prepare changes for approval.',
    tools: ['rows.list', 'rows.update'],
    modelFamilyId: 'claude-sonnet',
  },
  capabilities: ['read', 'edit', 'invoke', 'delete'],
  admin: true,
  activations: [
    {
      id: activationId,
      revision: 'b'.repeat(64),
      scope: [{ assetId: rid, permissions: ['table.row.read', 'table.row.update'] }],
    },
  ],
};
// Task summaries carry delegation fields since cloud aed31db6 (#803), packages/agents/src/task-contracts.ts:52.
const task = {
  id: taskId,
  generation: 1,
  status: 'completed',
  agentId: aid,
  activationId,
  definitionRevision: 'b'.repeat(64),
  skills: [],
  scope: agent.activations[0].scope,
  parentTaskId: null,
  delegationDepth: 0,
  limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
  flowId: cid,
  activeMilliseconds: '18000',
  toolCalls: 3,
  createdAt: at,
  cost: { chargedCreditUnits: '2500000000000', heldCreditUnits: '0' },
};
const skill = {
  id: sid,
  revision: 'c'.repeat(64),
  definition: {
    name: 'Customer follow-up procedure',
    instructions: 'Review the last contact. Draft a follow-up and ask for approval.',
  },
  reviewedDefinition: {
    name: 'Customer follow-up procedure',
    instructions: 'Review the last contact. Ask a person to draft the message.',
  },
  management: { id: sid, version: 3, savedRevision: 'c'.repeat(64), activeRevision: 'd'.repeat(64), enabled: true },
  canReview: true,
};
const workflows = Array.from({ length: 20 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  revision: `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  activeRevision: null,
  enabled: false,
  generation: 1,
  nextRunAt: null,
  activeTrigger: null,
  webhookConfigured: false,
  capabilities: { read: true, invoke: true, manage: true },
  definition: {
    version: 1,
    name: `Customer review ${i + 1}`,
    trigger: { kind: 'manual' },
    steps: [{ id: 'review', kind: 'human', prompt: 'Review the customer request.', timeoutSeconds: 86400 }],
  },
}));
const chat = {
  id: cid,
  title: 'Plan customer follow-ups',
  titleRevision: 0,
  archived: false,
  activityAt: at,
  createdAt: at,
};
let browser;
try {
  for (
    let i = 0;
    !(await fetch(origin).then(
      r => r.ok,
      () => false,
    ));
    i++
  ) {
    if (i > 150) throw Error('Vite did not start');
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  for (const device of [
    { name: 'desktop', width: 1440, height: 1000, theme: 'light' },
    { name: 'mobile', width: 390, height: 844, theme: 'dark' },
  ]) {
    const context = await browser.newContext({
      viewport: device,
      colorScheme: device.theme,
      isMobile: device.name === 'mobile',
      hasTouch: device.name === 'mobile',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(60000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    let signedIn = true,
      failPath = '',
      longMember = false;
    const searches = [];
    await page.route('**/v1/**', async route => {
      const url = new URL(route.request().url()),
        p = url.pathname;
      const send = (json, status = 200) => route.fulfill({ status, json });
      if (p === failPath) return send({ error: 'unavailable' }, 503);
      if (p === '/v1/auth/get-session')
        return send(
          signedIn
            ? { session: { id: 'fixture', userId: 'ada' }, user: { id: 'ada', name: 'Ada', email: 'ada@example.com' } }
            : null,
        );
      if (p === '/v1/workspaces') return send([workspace]);
      if (p === '/v1/workspaces/acme') return send(workspace);
      if (p.endsWith('/credits'))
        return send({ available: 100, granted: 100, used: 0, held: 0, days: [], breakdown: [], series: [] });
      if (p.endsWith('/settings'))
        return send({ workspaceId: wid, name: workspace.name, slug: 'acme', revision: 1, canManage: true });
      if (p.endsWith('/personal-memory'))
        return send({ content: 'Use concise answers and include next steps.', revision: 1 });
      if (p.endsWith('/governance/me'))
        return send({
          membershipId: mid,
          role: 'admin',
          teams,
          capabilities: { manageGovernance: true, canLeave: true },
        });
      if (p.endsWith('/governance'))
        return send(
          governanceSnapshot({
            actorMembershipId: mid,
            members: [
              { id: mid, userId: 'ada', name: 'Ada', email: 'ada@example.com', role: 'admin' },
              {
                id: sid,
                userId: 'sam',
                name: longMember ? 'International customer support coordinator '.repeat(20) : 'Sam',
                email: 'sam@example.com',
                role: 'member',
              },
            ],
            teams,
            resources: [{ id: rid, name: 'Customers', owningTeamId: tid }],
            grants: [],
          }),
        );
      if (p.endsWith('/invitations')) return send([]);
      if (p.endsWith('/model-catalog')) return send({ families });
      if (p.endsWith('/model-policy/availability'))
        return send({ items: [{ familyId: 'claude-sonnet', enabled: true, revision: 1 }] });
      if (p.includes('/model-policy/rules/'))
        return send({
          sourceFamilyId: 'claude-sonnet',
          targetFamilyId: null,
          revision: 1,
          editorMembershipId: mid,
          updatedAt: at,
        });
      if (p.endsWith('/tables/authoring-context') || p.endsWith(`/tables/${rid}/authoring-context`))
        return send({
          currentSoulRevision: definition.revision,
          savedDefinition: p.includes(rid) ? definition : null,
          appliedDefinition: p.includes(rid) ? definition : null,
          teams: teams.map(({ id, name }) => ({ id, name })),
          capabilities,
        });
      if (p.endsWith('/tables')) return send({ tables: [resource], total: 1, nextCursor: null });
      if (p.endsWith(`/tables/${rid}`)) return send(resource);
      if (p.endsWith('/rows/query'))
        return send({ records: [{ id: cid, values: { [sid]: 'Northwind Traders' } }], total: '1', nextCursor: null });
      if (p.endsWith('/migrations')) return send([]);
      if (p.endsWith('/agents/authoring-context'))
        return send({ currentSoulRevision: 'a'.repeat(40), teams, admin: true });
      if (p.endsWith('/agents')) {
        searches.push(url.searchParams.get('search'));
        const match =
          !url.searchParams.get('search') ||
          agent.name.toLowerCase().includes(url.searchParams.get('search').toLowerCase());
        return send({ agents: match ? [agent] : [], count: match ? 1 : 0, nextCursor: null });
      }
      if (p.endsWith(`/agents/${aid}`)) return send(agent);
      if (p.endsWith('/policy'))
        return send({
          version: 1,
          owningTeamId: tid,
          grants: [],
          enrollment: [tid],
          enabled: true,
          limits: agent.activations[0].scope,
        });
      if (p.endsWith('/schedules')) return send([]);
      if (p.endsWith('/chat')) return send({ configured: true });
      if (p.endsWith('/skills'))
        return send({
          workspace: [
            {
              id: sid,
              name: skill.definition.name,
              description: skill.definition.description ?? 'Reusable workspace procedure.',
              revision: skill.revision,
            },
          ],
          nextCursor: null,
        });
      if (p.endsWith(`/skills/${sid}`)) return send(skill);
      if (p.endsWith('/agent-tasks')) return send({ tasks: [task], nextCursor: null });
      if (p.includes('/agent-tasks/') && p.endsWith('/history'))
        return send({
          messages: [
            {
              sequence: 0,
              generation: 1,
              role: 'owner',
              text: 'Review customers needing follow-up.',
              sources: [],
              createdAt: at,
            },
            {
              sequence: 1,
              generation: 1,
              role: 'agent',
              text: 'Northwind Traders needs a follow-up.',
              sources: [],
              createdAt: at,
            },
          ],
          nextCursor: null,
        });
      if (p.includes('/agent-tasks/') && p.endsWith('/proposals')) return send({ proposals: [], nextCursor: null });
      if (p.includes('/agent-tasks/')) return send(task);
      if (p.endsWith('/conversations')) return send({ chats: [chat], nextCursor: null });
      if (p.endsWith(`/conversations/${cid}`)) return send(chat);
      if (p.endsWith('/messages')) return send({ messages: [], nextBefore: null });
      if (p.endsWith('/integrations/creation-context'))
        return send({ teams: teams.map(({ id, name }) => ({ id, name })) });
      if (p.endsWith('/integrations')) return send({ integrations: [] });
      if (p.endsWith('/google-workspace/availability')) return send({ configured: true });
      if (p.endsWith('/google-workspace')) return send({ status: 'disconnected' });
      if (p.endsWith('/google-workspace/operations/proposals')) return send({ proposals: [], nextCursor: null });
      if (p.endsWith('/atlassian/accounts')) return send({ accounts: [], providers: [] });
      if (p.endsWith('/atlassian/sources'))
        return send({ sources: [], mcp: { enabled: false, explanation: 'Fixture operations unavailable.' } });
      if (p.endsWith('/workflows')) return send(workflows);
      const workflow = workflows.find(item => p.endsWith(`/workflows/${item.id}`));
      if (workflow)
        return send({
          workflowId: workflow.id,
          revision: workflow.revision,
          savedRevision: workflow.revision,
          activeRevision: null,
          definition: workflow.definition,
          actor: null,
          canManage: true,
          archived: false,
        });
      if (p.endsWith('/workflows/sharing-candidates')) return send({ membershipId: mid, people: [], teams: [] });
      if (p.includes('/workflows/') && p.endsWith('/grants')) return send([]);
      if (p.endsWith('/runs')) return send({ runs: [], nextCursor: null });
      if (p.endsWith('/provider-integrations')) return send([]);
      return send({ error: 'fixture-unavailable' }, 404);
    });
    async function visit(path) {
      await page.goto(origin + path);
      await delay(500);
    }
    async function shot(name) {
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: new URL(`${baseline ? 'before' : 'after'}-${device.name}-${name}.png`, output).pathname,
      });
    }
    async function contained() {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await visit(`/acme/agents/${aid}`);
    await shot('readiness');
    if (!baseline) {
      await page.getByRole('list', { name: 'Setup steps', exact: true }).waitFor();
      await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
      await page.getByRole('heading', { name: 'Permitted actions', exact: true }).waitFor();
    }
    await visit('/acme/agents/new');
    if (!baseline) {
      await page.getByRole('checkbox', { name: 'Find rows', exact: true }).waitFor();
      await page.getByRole('checkbox', { name: 'Update rows', exact: true }).waitFor();
    }
    await page
      .getByRole('region', { name: 'Permitted actions', exact: true })
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    await shot('authoring');
    await visit('/acme/agents');
    if (!baseline) {
      await page.getByRole('searchbox', { name: 'Find agents', exact: true }).fill('follow-up');
      await page.getByRole('button', { name: agent.name, exact: true }).waitFor();
      assert.ok(searches.includes('follow-up'));
      await page.getByRole('button', { name: agent.name, exact: true }).click();
      await page.getByRole('link', { name: 'Back to agents' }).click();
      assert.equal(await page.getByRole('searchbox', { name: 'Find agents', exact: true }).inputValue(), 'follow-up');
      await page.getByRole('searchbox', { name: 'Find agents', exact: true }).fill('No matching name');
      await page.getByRole('heading', { name: 'No matching agents' }).waitFor();
      await page.getByRole('button', { name: 'Clear search', exact: true }).last().click();
    }
    await shot('agents');
    await visit('/acme/skills');
    await shot('skills');
    if (!baseline) {
      await page.getByRole('button', { name: 'Read Define business rows' }).click();
      await page.getByText(/Discover tables first/).waitFor();
    }
    await visit(`/acme/skills/${sid}`);
    if (!baseline) await page.getByRole('region', { name: 'Procedure comparison' }).scrollIntoViewIfNeeded();
    await shot('skill-review');
    await visit('/acme/workflows');
    await shot('workflows');
    if (!baseline) {
      await page.getByLabel('Find workflows').fill('review 20');
      await page.getByRole('link', { name: 'Customer review 20', exact: true }).click();
      const viewer = page.getByRole('region', { name: 'Customer review 20 workflow', exact: true });
      await viewer.getByText('Saved revision', { exact: true }).waitFor();
      await assertConfiguration(viewer, 1, workflows[19].definition.steps[0]);
      assert.equal(await page.getByLabel('Name', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Save revision', exact: true }).count(), 0);
      await page.getByRole('tab', { name: 'Runs', exact: true }).click();
      await page.getByRole('heading', { name: 'Run manually', exact: true }).waitFor();
      await page.getByText('No runs yet. Activate the saved revision, and run it above.', { exact: true }).waitFor();
      await page.getByRole('tab', { name: 'Definition', exact: true }).click();
      await viewer.getByRole('button', { name: 'Edit in chat', exact: true }).waitFor();
      await assertConfiguration(viewer, 1, workflows[19].definition.steps[0]);
      await shot('workflow-inspector');
      await showWorkflowList(page);
      assert.equal(await page.getByLabel('Find workflows').inputValue(), 'review 20');
      await page.getByRole('button', { name: 'New workflow', exact: true }).click();
      await page.waitForURL(url => /^\/acme\/?$/.test(url.pathname));
      assert.equal(await page.getByRole('alertdialog').count(), 0);
      await page
        .getByRole('textbox', { name: 'Message', exact: true })
        .getByText(/^Help me create a workflow\./)
        .waitFor();
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill('');
    }
    await visit(`/acme/tables/${rid}`);
    await shot('records');
    if (!baseline) {
      assert.equal(await page.getByRole('navigation', { name: 'Row pages' }).count(), 0);
      assert.equal(await page.getByText('Northwind Traders', { exact: true }).count(), 1);
      await page.getByRole('button', { name: 'Filters', exact: true }).click();
      await page.getByLabel('Filter field', { exact: true }).waitFor();
    }
    await visit(`/acme/tables/${rid}/edit`);
    if (!baseline)
      assert.equal(await page.getByRole('combobox', { name: 'Change', exact: true }).innerText(), 'Add field');
    await page.getByRole('combobox', { name: 'Change', exact: true }).scrollIntoViewIfNeeded();
    await shot('schema-label');
    await visit('/acme/settings');
    await shot('settings');
    if (!baseline && device.name === 'mobile') {
      await page.getByLabel('Settings section').selectOption('models');
      await page.getByRole('heading', { name: 'Models', exact: true }).waitFor();
    } else await visit('/acme/settings/models');
    await shot('models');
    await visit('/acme/grants');
    await page.getByLabel('Team receiving access').click();
    await page.getByRole('option', { name: 'Customer Operations', exact: true }).click();
    await shot('permissions');
    await visit(`/acme/chat/${cid}`);
    if (!baseline) assert.equal(await page.getByRole('navigation', { name: 'Pending Google actions' }).count(), 0);
    await shot('chat');
    if (!baseline) {
      await visit('/acme/help');
      await page.getByRole('heading', { name: 'Help and support' }).waitFor();
      assert.match(
        await page.getByRole('link', { name: 'Email support', exact: true }).getAttribute('href'),
        /^mailto:hello@tulipfarm.ai/,
      );
      await shot('help');
    }
    longMember = true;
    await visit('/acme/members');
    await page.getByRole('button', { name: 'Make admin', exact: true }).click();
    if (!baseline) {
      await page.setViewportSize({ width: 320, height: 400 });
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      const bounds = await dialog.boundingBox();
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 400);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).scrollIntoViewIfNeeded();
      await contained();
      await shot('dialog');
      await page.keyboard.press('Escape');
      await page.setViewportSize(device);
    } else {
      await shot('dialog');
      await page.keyboard.press('Escape');
    }
    signedIn = false;
    await visit('/login');
    await shot('login');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS remaining recommendations ${baseline ? 'baseline' : 'after'} ${device.name}`);
  }
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
