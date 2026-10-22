import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const port = Number(process.env.TASK_COMPOSER_BROWSER_PORT ?? 5271);
const origin = `http://127.0.0.1:${port}`;
const shots = process.env.TASK_COMPOSER_SCREENSHOTS;
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
const uuid = digit =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const [wid, mid, tid, aid, idleId, scopedId, rid, taskId, pausedId, activationId, otherActivationId] = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'a',
  'b',
].map(uuid);
const at = '2026-10-05T09:00:00Z';
const workspace = {
  id: wid,
  slug: 'acme',
  name: 'Acme Operations',
  status: 'ready',
  createdAt: at,
  soulCommit: 'a'.repeat(40),
};
const teams = [{ id: tid, name: 'Customer operations', description: 'Customer support', membershipIds: [mid] }];
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
const scope = [{ assetId: rid, permissions: ['table.row.read'] }];
const agentFixture = (id, name, activations) => ({
  id,
  name,
  owningTeamId: tid,
  savedRevision: 'a'.repeat(40),
  definitionRevision: 'b'.repeat(64),
  definition: {
    name,
    instructions: 'Review customer rows and prepare follow-ups.',
    tools: ['rows.list'],
    modelFamilyId: 'claude-sonnet',
  },
  capabilities: ['read', 'invoke', 'delete'],
  admin: false,
  activations,
});
const agents = [
  agentFixture(aid, 'Customer follow-up assistant', [{ id: activationId, revision: 'b'.repeat(64), scope }]),
  agentFixture(idleId, 'Inactive assistant', []),
  agentFixture(scopedId, 'Scoped assistant', [
    { id: activationId, revision: 'b'.repeat(64), scope },
    { id: otherActivationId, revision: 'c'.repeat(64), scope: [] },
  ]),
];
const limits = { toolCalls: 100, activeMilliseconds: 300000, credits: 100 };
// Task summaries carry delegation fields since cloud aed31db6 (#803), packages/agents/src/task-contracts.ts:52.
const taskFixture = (id, status) => ({
  id,
  generation: 1,
  status,
  agentId: aid,
  activationId,
  definitionRevision: 'b'.repeat(64),
  skills: [],
  scope,
  parentTaskId: null,
  delegationDepth: 0,
  limits,
  flowId: uuid('c'),
  activeMilliseconds: '18000',
  toolCalls: 3,
  createdAt: at,
  cost: { chargedCreditUnits: '0', heldCreditUnits: '0' },
});
const tasks = [taskFixture(taskId, 'completed'), { ...taskFixture(pausedId, 'paused'), toolCalls: 100 }];
const commands = [],
  errors = [];
let deletes = 0;
let browser, active;

async function open(device) {
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    colorScheme: device.theme,
    isMobile: device.width < 500,
    hasTouch: device.width < 500,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/v1/**', async route => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (path === '/v1/auth/get-session')
      return send({
        session: { id: 'fixture', userId: 'ada' },
        user: { id: 'ada', name: 'Ada', email: 'ada@example.com' },
      });
    if (path === '/v1/workspaces') return send([workspace]);
    if (path === '/v1/workspaces/acme') return send(workspace);
    if (path.endsWith('/governance/me'))
      return send({
        membershipId: mid,
        role: 'member',
        teams,
        capabilities: { manageGovernance: false, canLeave: true },
      });
    if (path.endsWith('/model-catalog')) return send({ families });
    if (path.endsWith('/agents/authoring-context'))
      return send({ currentSoulRevision: 'a'.repeat(40), teams, admin: false });
    const agent = agents.find(item => path.endsWith(`/agents/${item.id}`));
    if (agent && method === 'DELETE') {
      deletes++;
      return deletes === 1 ? route.abort('failed') : send({ deleted: true });
    }
    if (agent) return send(agent);
    if (path.endsWith('/chat')) return send({ configured: true });
    if (path.includes('/workspace-mcp/')) return send({ enabled: false });
    // Channel reads report occupancy and channel responses since cloud 3e124b0f (#1004), features/agents/slack-queries.ts:30.
    if (path.includes('/slack/channels/'))
      return send({ version: 0, agentId: null, occupied: false, channelResponses: false });
    if (path.endsWith('/github/accounts')) return send({ configured: true, accounts: [] });
    if (path.includes('/github/tasks/') && path.endsWith('/selection'))
      return send({ accountId: null, generation: null, version: 0 });
    if (method === 'POST' && path.includes('/agent-tasks')) {
      commands.push({ path: path.split('/agent-tasks')[1], body: request.postDataJSON() });
      await delay(600);
      const task = tasks.find(item => path.includes(item.id)) ?? tasks[0];
      return send({ id: task.id, generation: 2, status: 'pending' });
    }
    if (path.endsWith('/agent-tasks')) return send({ tasks, nextCursor: null });
    if (path.endsWith('/history'))
      return send({
        messages: [
          {
            sequence: 0,
            generation: 1,
            role: 'owner',
            text: 'Review customers needing follow-up this week.',
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
    if (path.endsWith('/proposals')) return send({ proposals: [], nextCursor: null });
    const task = tasks.find(item => path.endsWith(`/agent-tasks/${item.id}`));
    if (task) return send(task);
    return send({ error: 'fixture-unavailable' }, 404);
  });
  return { context, page };
}
const focusedId = page => page.evaluate(() => document.activeElement?.id);
const describedBy = (locator, page) =>
  locator.getAttribute('aria-describedby').then(ids =>
    page.evaluate(
      list =>
        list
          .split(' ')
          .map(id => document.getElementById(id)?.textContent)
          .join(' | '),
      ids,
    ),
  );

try {
  for (
    let attempt = 0;
    !(await fetch(origin).then(
      response => response.ok,
      () => false,
    ));
    attempt++
  ) {
    assert.ok(attempt < 150, 'Vite did not start');
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  const { context, page } = await open({ width: 1440, height: 1000, theme: 'light' });
  active = page;

  await page.goto(`${origin}/acme/agents/${aid}`);
  // The private task form is the "Run agent now" section (cloud features/tasks/composer.tsx:35, 7b51be61 #727).
  const region = page.getByRole('region', { name: 'Run agent now', exact: true });
  const message = region.getByRole('textbox', { name: 'What should this agent do?', exact: true });
  const start = region.getByRole('button', { name: 'Start task', exact: true });
  await message.waitFor();
  assert.equal(await message.getAttribute('aria-required'), 'true');
  assert.notEqual(await start.getAttribute('aria-disabled'), 'true', 'an empty message does not disable Start task');
  await start.click();
  await region.getByText('Write what the agent should do.', { exact: true }).waitFor();
  assert.equal(await message.getAttribute('aria-invalid'), 'true');
  assert.match(await describedBy(message, page), /^Write what the agent should do\./);
  await page.waitForFunction(() => document.activeElement?.id === 'task-message');
  assert.equal(commands.length, 0, 'an invalid submit sends no command');

  await message.fill('Review customers needing follow-up this week.');
  assert.equal(await region.getByText('Write what the agent should do.', { exact: true }).count(), 0);
  const limitsToggle = region.getByRole('button', { name: 'Task limits', exact: true });
  await limitsToggle.click();
  const credits = region.getByRole('spinbutton', { name: 'Credit limit', exact: true });
  assert.equal(await credits.getAttribute('aria-required'), 'true');
  await credits.fill('0');
  await limitsToggle.click();
  await credits.waitFor({ state: 'hidden' });
  await start.click();
  await region.getByText('Use 1 to 10,000 credits.', { exact: true }).waitFor();
  assert.equal(await limitsToggle.getAttribute('aria-expanded'), 'true', 'a limit error opens Task limits');
  await page.waitForFunction(() => document.activeElement?.id === 'task-credits');
  assert.equal(await credits.getAttribute('aria-invalid'), 'true');
  assert.equal(commands.length, 0);

  await credits.fill('250');
  await start.dblclick();
  const sending = region.getByRole('button', { name: 'Sending…', exact: true });
  await sending.waitFor();
  assert.equal(await sending.getAttribute('aria-busy'), 'true');
  assert.equal(await sending.getAttribute('aria-disabled'), 'true');
  await page.waitForURL(`**/acme/agent-tasks/${taskId}`);
  assert.equal(commands.length, 1, 'a double click sends one command');
  const { requestId, ...body } = commands[0].body;
  assert.ok(requestId);
  assert.deepEqual(body, {
    agentId: aid,
    text: 'Review customers needing follow-up this week.',
    sources: [],
    scope,
    limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 250 },
  });

  const followUp = page.getByRole('textbox', { name: 'Follow up on this task', exact: true });
  await followUp.waitFor();
  await page.getByRole('button', { name: 'Send follow-up', exact: true }).click();
  await page.getByText('Write your message.', { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'task-message');
  assert.equal(commands.length, 1);

  await page.goto(`${origin}/acme/agent-tasks/${pausedId}`);
  const toolCalls = page.getByRole('spinbutton', { name: 'Tool call limit', exact: true });
  await toolCalls.waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Task limits', exact: true }).getAttribute('aria-expanded'),
    'true',
    'a task paused at its tool call limit opens Task limits',
  );
  await page.getByRole('textbox', { name: 'Your answer or continuation', exact: true }).fill('Finish the report.');
  await toolCalls.fill('50');
  await page.getByRole('button', { name: 'Continue task', exact: true }).click();
  await page.getByText('Use 100 to 1,000 tool calls.', { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'task-toolCalls');
  assert.equal(commands.length, 1);
  await toolCalls.fill('150');
  await page.getByRole('button', { name: 'Continue task', exact: true }).click();
  for (let attempt = 0; commands.length < 2; attempt++) {
    assert.ok(attempt < 50, 'continue command sent');
    await delay(100);
  }
  assert.equal(commands[1].path, `/${pausedId}/continue`);
  assert.deepEqual(commands[1].body.limits, { toolCalls: 150, activeMilliseconds: 300000, credits: 100 });
  assert.equal(commands[1].body.expectedSequence, 1);

  await page.goto(`${origin}/acme/agents/${idleId}`);
  const idleStart = region.getByRole('button', { name: 'Start task', exact: true });
  await idleStart.waitFor();
  assert.equal(await idleStart.getAttribute('aria-disabled'), 'true');
  assert.equal(
    await describedBy(idleStart, page),
    'An agent manager must activate this agent before you can start a task.',
  );
  assert.equal(
    await region.getByRole('textbox', { name: 'What should this agent do?', exact: true }).isDisabled(),
    true,
  );
  await idleStart.click({ force: true });
  await idleStart.dispatchEvent('click');
  await idleStart.focus();
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    'Start task',
    'a blocked Start task stays focusable',
  );
  await page.keyboard.press('Enter');
  await delay(300);
  assert.equal(commands.length, 2, 'a blocked Start task sends nothing');

  await page.goto(`${origin}/acme/agents/${scopedId}`);
  await region.getByText('Choose a task data scope first.', { exact: true }).waitFor();
  assert.equal(
    await region.getByRole('button', { name: 'Start task', exact: true }).getAttribute('aria-disabled'),
    'true',
  );
  await region.getByRole('button', { name: 'Go to Task data scope', exact: true }).click();
  assert.equal(await focusedId(page), 'task-scope');
  await region.getByRole('combobox', { name: 'Task data scope', exact: true }).click();
  await page.getByRole('option', { name: 'No table access', exact: true }).click();
  assert.notEqual(
    await region.getByRole('button', { name: 'Start task', exact: true }).getAttribute('aria-disabled'),
    'true',
  );
  assert.equal(await region.getByText('Choose a task data scope first.', { exact: true }).count(), 0);

  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  const deletion = page.getByRole('region', { name: 'Delete agent', exact: true });
  const remove = deletion.getByRole('button', { name: 'Delete agent', exact: true });
  await remove.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Keep agent', exact: true }).click();
  assert.equal(deletes, 0);
  await remove.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete saved agent', exact: true }).click();
  await deletion.getByRole('button', { name: 'Retry same operation', exact: true }).waitFor();
  assert.equal(await remove.getAttribute('aria-disabled'), 'true');
  assert.equal(await describedBy(remove, page), 'Check whether the agent was deleted before trying again.');
  await page.getByRole('alertdialog').waitFor({ state: 'detached' });
  await remove.click({ force: true });
  await remove.dispatchEvent('click');
  await delay(300);
  assert.equal(await page.getByRole('alertdialog').count(), 0, 'a blocked Delete agent opens no confirmation');
  await deletion.getByRole('button', { name: 'Retry same operation', exact: true }).click();
  await page.getByRole('heading', { name: 'Agent deleted', exact: true }).waitFor();
  assert.equal(deletes, 2);
  await context.close();

  for (const device of [
    { width: 1440, height: 1000, theme: 'light' },
    { width: 1440, height: 1000, theme: 'dark' },
    { width: 390, height: 1600, theme: 'light' },
    { width: 390, height: 1600, theme: 'dark' },
  ]) {
    if (!shots && device.width > 500) continue;
    const { context: themed, page: view } = await open(device);
    const name = `${device.width}-${device.theme}`;
    const shoot = async (locator, label) => {
      if (shots) {
        await mkdir(shots, { recursive: true });
        await view.evaluate(() => document.fonts.ready);
        await locator.screenshot({ path: `${shots}/${label}-${name}.png` });
      }
    };
    await view.goto(`${origin}/acme/agents/${aid}`);
    const startRegion = view.getByRole('region', { name: 'Run agent now', exact: true });
    await startRegion.getByRole('textbox', { name: 'What should this agent do?', exact: true }).waitFor();
    await shoot(startRegion, 'start');
    await startRegion.getByRole('button', { name: 'Task limits', exact: true }).click();
    await startRegion.getByRole('spinbutton', { name: 'Credit limit', exact: true }).fill('0');
    await startRegion.getByRole('button', { name: 'Start task', exact: true }).click();
    await startRegion.getByText('Use 1 to 10,000 credits.', { exact: true }).waitFor();
    await shoot(startRegion, 'start-errors');
    await view.getByRole('tab', { name: 'Slack', exact: true }).click();
    const slack = view.getByRole('region', { name: 'Slack channel attachment', exact: true });
    await slack.getByRole('button', { name: 'Use a channel ID instead', exact: true }).click();
    await slack.getByRole('button', { name: 'Check channel', exact: true }).click();
    await slack.getByText('Enter a channel ID that starts with C or G.', { exact: true }).waitFor();
    await shoot(slack, 'slack-error');
    await slack.getByRole('textbox', { name: 'Slack channel ID', exact: true }).fill('C0123456789');
    await slack.getByRole('button', { name: 'Check channel', exact: true }).click();
    await slack.getByText('No agent is attached to this channel.', { exact: true }).waitFor();
    await shoot(slack, 'slack-checked');
    assert.equal(
      await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `no horizontal page overflow at ${name}`,
    );
    assert.equal(
      await view
        .locator('[data-slot="page-content"]')
        .locator('..')
        .evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 1).length),
      0,
      `no overflow inside main at ${name}`,
    );
    await themed.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS task composer: inline message and limit errors with focus, limits reopen, one command per double click, reply minimums, blocked reasons with focus and a jump fix, responsive sections.',
  );
} catch (error) {
  console.error(
    await active
      ?.locator('body')
      .innerText()
      .catch(() => ''),
    errors,
  );
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
