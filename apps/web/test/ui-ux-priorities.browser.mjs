import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { governanceSnapshot } from './governance-snapshot.mjs';

const baseline = process.env.UI_BASELINE === '1';
const output = new URL('../../../docs/evidence/ui-ux-priorities/', import.meta.url);
await mkdir(output, { recursive: true });
const origin = 'http://127.0.0.1:5458';
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5458', '--strictPort'], {
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
const teamName = 'International customer operations and enterprise account coordination across all regions';
const teams = [{ id: tid, name: teamName, description: 'Customer support', membershipIds: [mid] }];
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
const subjects = [
  'Review customers needing follow-up this week.',
  'Prepare the quarterly account summary.',
  'Check overdue invoices.',
  'Review proposed customer updates.',
  'Summarize open support requests.',
];
const statuses = ['completed', 'pending', 'paused', 'waiting-approval', 'failed'];
const tasks = subjects.map((_, i) => ({ ...task, id: i ? ids[i] : taskId, status: statuses[i] }));
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
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    let failPath = '',
      slowPath = '',
      submission = 'success',
      command = null,
      posts = 0;
    await page.route('**/v1/**', async route => {
      const p = new URL(route.request().url()).pathname;
      const send = (json, status = 200) => route.fulfill({ status, json });
      if (p === failPath) return send({ error: 'unavailable' }, 503);
      if (p === slowPath) await delay(800);
      if (p === '/v1/auth/get-session')
        return send({
          session: { id: 'fixture', userId: 'ada' },
          user: { id: 'ada', name: 'Ada', email: 'ada@example.com' },
        });
      if (p === '/v1/workspaces') return send([workspace]);
      if (p === '/v1/workspaces/acme') return send(workspace);
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
            members: [{ id: mid, userId: 'ada', name: 'Ada', email: 'ada@example.com', role: 'admin' }],
            teams,
            resources: [{ id: rid, name: 'Customers', owningTeamId: tid }],
            grants: [],
          }),
        );
      if (p.endsWith('/model-catalog')) return send({ families });
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
      if (p.endsWith('/rows/query')) return send({ records: [], total: '0', nextCursor: null });
      if (p.endsWith('/migrations')) return send([]);
      if (p.endsWith('/agents/authoring-context'))
        return send({ currentSoulRevision: 'a'.repeat(40), teams, admin: true });
      if (p.endsWith('/agents')) return send({ agents: [agent], count: 1, nextCursor: null });
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
      if (p.endsWith('/skills')) return send({ workspace: [], nextCursor: null });
      if ((p.endsWith('/agent-tasks') && route.request().method() === 'POST') || p.endsWith('/reopen')) {
        posts++;
        if (command) assert.deepEqual(route.request().postDataJSON(), command);
        command = route.request().postDataJSON();
        if (submission === 'uncertain') return route.abort('failed');
        return send({ id: taskId, generation: 1, status: 'completed' });
      }
      if (p.endsWith('/agent-tasks')) return send({ tasks, nextCursor: null });
      if (p.includes('/agent-tasks/') && p.endsWith('/history')) {
        const index = Math.max(
          0,
          tasks.findIndex(t => p.includes(t.id)),
        );
        return send({
          messages: [
            { sequence: 0, generation: 1, role: 'owner', text: subjects[index], sources: [], createdAt: at },
            {
              sequence: 1,
              generation: 1,
              role: 'agent',
              text: 'Northwind Traders needs a follow-up. The customer review is ready.',
              sources: [],
              createdAt: at,
            },
          ],
          nextCursor: null,
        });
      }
      if (p.includes('/agent-tasks/') && p.endsWith('/proposals')) return send({ proposals: [], nextCursor: null });
      if (p.includes('/agent-tasks/')) return send(tasks.find(t => p.endsWith(t.id)) ?? task);
      if (p.endsWith('/conversations')) return send({ chats: [chat], nextCursor: null });
      if (p.endsWith(`/conversations/${cid}`)) return send(chat);
      if (p.endsWith('/messages'))
        return send({
          messages: [
            {
              id: mid,
              sequence: 1,
              author: 'human',
              createdAt: at,
              parts: [
                { kind: 'text', text: 'Keep these files for my customer review.' },
                { kind: 'attachment', attachmentId: sid },
                { kind: 'attachment', attachmentId: rid },
              ],
              turn: null,
            },
          ],
          nextBefore: null,
        });
      if (p.endsWith(`/uploads/${sid}`))
        return send({
          id: sid,
          filename: 'customer-notes.txt',
          mediaType: 'text/plain',
          size: 1200,
          state: 'bound',
          sha256: 'a'.repeat(64),
          expiresAt: at,
        });
      if (p.endsWith(`/uploads/${rid}`))
        return send({
          id: rid,
          filename: 'customer-report.pdf',
          mediaType: 'application/pdf',
          size: 19000,
          state: 'bound',
          sha256: 'b'.repeat(64),
          expiresAt: at,
        });
      if (p.endsWith('/integrations/creation-context'))
        return send({ teams: teams.map(({ id, name }) => ({ id, name })) });
      if (p.includes('/integrations/creation-grants/'))
        return send({ owningTeamId: tid, teamIds: [tid], version: 'a'.repeat(64) });
      if (p.endsWith('/integrations')) return send({ integrations: [] });
      if (p.endsWith('/github/accounts')) return send({ configured: true, accounts: [] });
      if (p.includes('/github/tasks/') && p.endsWith('/selection'))
        return send({ accountId: null, generation: null, version: 0 });
      if (p.endsWith('/google-workspace/availability')) return send({ configured: true });
      if (p.endsWith('/google-workspace')) return send({ status: 'disconnected' });
      if (p.endsWith('/google-workspace/operations/proposals')) return send({ proposals: [], nextCursor: null });
      if (p.endsWith('/atlassian/accounts'))
        return send({
          accounts: [],
          providers: [
            { protocol: 'atlassian-mcp', configured: false },
            { protocol: 'atlassian-rest', configured: false },
            { protocol: 'trello', configured: false },
          ],
        });
      if (p.endsWith('/atlassian/sources'))
        return send({
          sources: [],
          mcp: { enabled: false, explanation: 'Provider operations are not configured in this fixture.' },
        });
      if (p.endsWith('/workflows') || p.endsWith('/provider-integrations')) return send([]);
      return send({ error: 'fixture-unavailable' }, 404);
    });
    async function shot(name) {
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: new URL(`${baseline ? 'before' : 'after'}-${device.name}-${name}.png`, output).pathname,
      });
    }
    async function visit(path) {
      await page.goto(origin + path);
      await delay(650);
    }
    async function contained() {
      assert.deepEqual(
        await page.locator('main,[data-slot="page-content"],[data-slot="select-trigger"]').evaluateAll(nodes =>
          nodes
            .filter(n => n.checkVisibility() && n.scrollWidth > n.clientWidth + 1)
            .map(n => ({
              slot: n.getAttribute('data-slot') ?? n.tagName,
              width: n.clientWidth,
              scroll: n.scrollWidth,
            })),
        ),
        [],
      );
    }
    await visit('/acme/agent-tasks');
    await shot('tasks');
    if (!baseline) {
      for (const subject of subjects) await page.getByRole('link', { name: subject, exact: true }).waitFor();
    }
    await visit(`/acme/agent-tasks/${taskId}`);
    await shot('task-detail');
    if (!baseline) {
      await page.getByRole('heading', { name: subjects[0], exact: true }).waitFor();
      await page.getByLabel('Follow up on this task').fill('Keep this follow-up.');
      await page.getByRole('link', { name: 'Back to my tasks' }).click();
      await page.getByRole('alertdialog').waitFor();
      await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
      assert.equal(await page.getByLabel('Follow up on this task').inputValue(), 'Keep this follow-up.');
      await page.getByLabel('Follow up on this task').fill('');
    }
    await visit(`/acme/agents/${aid}`);
    await page.getByLabel('What should this agent do?').fill('Review customers needing follow-up this week.');
    await page.getByRole('link', { name: 'Back to agents', exact: true }).click();
    if (!baseline) {
      await page.getByRole('alertdialog').waitFor();
      await shot('draft');
      await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
      assert.equal(await page.getByLabel('What should this agent do?').inputValue(), subjects[0]);
      let reloadBlocked = false;
      page.once('dialog', async dialog => {
        assert.equal(dialog.type(), 'beforeunload');
        reloadBlocked = true;
        await dialog.dismiss();
      });
      await page.reload().catch(() => {});
      assert.equal(reloadBlocked, true);
      submission = 'uncertain';
      await page.getByRole('button', { name: 'Start task', exact: true }).dblclick();
      await page.getByRole('button', { name: 'Retry same operation', exact: true }).waitFor();
      assert.equal(posts, 1);
      assert.equal(await page.getByLabel('What should this agent do?').inputValue(), subjects[0]);
      submission = 'success';
      await page.getByRole('button', { name: 'Retry same operation', exact: true }).click();
      await page.waitForURL(`**/agent-tasks/${taskId}`);
      assert.equal(await page.getByRole('alertdialog').count(), 0);
      await page.getByLabel('Follow up on this task').waitFor();
      assert.equal(await page.getByLabel('Follow up on this task').inputValue(), '');
      await visit(`/acme/agents/${aid}`);
      await page.getByRole('button', { name: 'Task limits', exact: true }).click();
      await page.getByLabel('Credit limit', { exact: true }).fill('125');
      await page.getByRole('link', { name: 'Back to agents', exact: true }).click();
      await page.getByRole('alertdialog').waitFor();
      await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
      assert.equal(await page.getByLabel('Credit limit', { exact: true }).inputValue(), '125');
      await page.getByLabel('Credit limit', { exact: true }).fill('100');
      await page.getByRole('button', { name: 'Attach past task or chat file', exact: true }).click();
      await page.getByRole('combobox', { name: 'Files from a personal chat', exact: true }).click();
      await page.getByRole('option', { name: chat.title, exact: true }).click();
      await page.getByRole('checkbox', { name: 'customer-notes.txt', exact: true }).check();
      await page
        .getByText('Too large for task context. Selecting this file will pause the task.', { exact: true })
        .waitFor();
      await shot('task-files');
      await page.getByRole('link', { name: 'Back to agents', exact: true }).click();
      await page.getByRole('alertdialog').waitFor();
      await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
      assert.equal(await page.getByRole('checkbox', { name: 'customer-notes.txt', exact: true }).isChecked(), true);
      await page.getByRole('link', { name: 'Back to agents', exact: true }).click();
      await page.getByRole('button', { name: 'Leave editor', exact: true }).click();
      await page.waitForURL('**/acme/agents');
    } else await shot('draft');
    await visit(`/acme/chat/${cid}`);
    await shot('files');
    await visit('/acme/integrations');
    await shot('integrations');
    if (!baseline) {
      const panel = async (name, open = true) => {
        const toggle = page.getByRole('dialog').getByRole('button', { name, exact: true });
        if (((await toggle.getAttribute('aria-expanded')) === 'true') !== open) await toggle.click();
      };
      await page.getByRole('button', { name: 'Gmail', exact: true }).click();
      await panel('Settings');
      await page.getByRole('button', { name: 'Connect Gmail', exact: true }).waitFor();
      assert.equal(await page.getByLabel('Bearer token for new source or rotation').isVisible(), false);
      await shot('google');
      await panel('Your account');
      await page.getByRole('heading', { name: 'No Google proposals', exact: true }).waitFor();
      await shot('approvals');
      await visit('/acme/integrations#github');
      await panel('Settings');
      await page.getByRole('button', { name: 'Add GitHub integration', exact: true }).click();
      await page.getByLabel('Integration name', { exact: true }).fill('Customer repositories');
      await panel('Settings', false);
      await panel('Settings');
      assert.equal(await page.getByLabel('Integration name', { exact: true }).inputValue(), 'Customer repositories');
      await visit('/acme/integrations#jira');
      await panel('Your account');
      await page.getByRole('heading', { name: 'Jira and Confluence integration', exact: true }).waitFor();
      await visit('/acme/integrations#gmail');
      await panel('Settings');
      await page.getByRole('link', { name: 'Start workflows from Gmail', exact: true }).click();
      await page.getByRole('heading', { name: 'Advanced workflow inputs', exact: true }).waitFor();
      await page.getByLabel('Gmail account email', { exact: true }).waitFor();
    }
    await visit('/acme/workflows?provider=gmail#provider-setup');
    await shot('workflow');
    await visit('/acme/agents/new');
    await shot('selector');
    if (!baseline) {
      await contained();
      await page.getByRole('combobox', { name: 'Team placement', exact: true }).click();
      await page.getByRole('option', { name: teamName, exact: true }).waitFor();
      await page.keyboard.press('Escape');
    }
    await visit('/acme/skills');
    await shot('skills');
    if (!baseline) await contained();
    await visit(`/acme/tables/${rid}/edit`);
    await page.getByRole('heading', { name: 'Change table fields', exact: true }).waitFor();
    await shot('schema');
    if (!baseline) await contained();
    if (!baseline) {
      await page.setViewportSize({ width: 320, height: 844 });
      for (const path of ['/acme/agents/new', '/acme/skills', `/acme/tables/${rid}/edit`, '/acme/agent-tasks']) {
        await visit(path);
        await contained();
      }
      slowPath = `/v1/workspaces/${wid}/agent-tasks`;
      await page.goto(origin + '/acme/agent-tasks');
      await page.getByRole('status', { name: 'Loading task data' }).waitFor();
      await page.getByRole('link', { name: subjects[0], exact: true }).waitFor();
      slowPath = '';
      failPath = `/v1/workspaces/${wid}/agent-tasks`;
      await page.evaluate(
        ({ workspaceId, membershipId }) => {
          const channel = new BroadcastChannel('tulipfarm:query:v1');
          channel.postMessage({
            version: 1,
            id: crypto.randomUUID(),
            sessionId: 'fixture',
            scope: { kind: 'workspace', userId: 'ada', workspaceId, membershipId },
            kind: 'change',
            keys: [['tasks', 'list']],
          });
          channel.close();
        },
        { workspaceId: wid, membershipId: mid },
      );
      await page.getByRole('button', { name: 'Retry refresh' }).waitFor();
      await page.getByRole('link', { name: subjects[0], exact: true }).waitFor();
      failPath = '';
      await page.getByRole('button', { name: 'Retry refresh' }).click();
    }
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${baseline ? 'baseline' : 'priority fixes'} ${device.name}`);
  }
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
