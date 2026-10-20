import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startBuiltApp, builderBrowserOptions, captureBrowserFailure } from './built-app.fixture.mjs';

const uuid = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const [wid, mid, teamId, aid, tableId, activationId, taskId, chatId, fileId, draftId, priorId, fileChatId] =
  '123456789abc'.split('').map(uuid);
const at = '2026-10-11T04:00:00.000Z';
const workspace = {
  id: wid,
  slug: 'agent-proof',
  name: 'Agent proof',
  status: 'ready',
  createdAt: at,
  soulCommit: 'a'.repeat(40),
};
const teams = [{ id: teamId, name: 'Operations', membershipIds: [mid] }];
const scope = [{ assetId: tableId, permissions: ['table.row.read'] }];
const limits = { toolCalls: 100, activeMilliseconds: 300000, credits: 100 };
const agent = {
  id: aid,
  name: 'Customer reviewer',
  owningTeamId: teamId,
  savedRevision: 'a'.repeat(40),
  definitionRevision: 'b'.repeat(64),
  definition: {
    name: 'Customer reviewer',
    instructions: 'Review customer requests.',
    tools: ['rows.list'],
    modelFamilyId: 'claude-sonnet',
  },
  capabilities: ['read', 'edit', 'invoke', 'delete', 'manage'],
  admin: true,
  activations: [{ id: activationId, revision: 'b'.repeat(64), scope }],
};
const task = {
  id: taskId,
  generation: 1,
  status: 'completed',
  parentTaskId: null,
  delegationDepth: 0,
  agentId: aid,
  activationId,
  definitionRevision: 'b'.repeat(64),
  skills: [],
  scope,
  limits,
  flowId: uuid('d'),
  activeMilliseconds: '1000',
  toolCalls: 1,
  createdAt: at,
  cost: { chargedCreditUnits: '0', heldCreditUnits: '0' },
};
const chat = {
  id: chatId,
  title: 'Customer review plan',
  titleRevision: 1,
  titleManual: true,
  archived: false,
  activityAt: at,
  createdAt: at,
  projectId: null,
};
const policy = {
  version: 1,
  owningTeamId: teamId,
  grants: [{ teamId, permissions: ['read', 'edit', 'invoke'] }],
  personGrants: [{ membershipId: mid, permissions: ['manage'] }],
  enrollment: [teamId],
  enabled: true,
  limits: scope,
};
const definition = {
  version: 1,
  name: 'Review customers',
  trigger: { kind: 'manual' },
  steps: [
    { id: 'review_customers', kind: 'agent', agentId: aid, prompt: { kind: 'literal', value: 'Review customers.' } },
  ],
};
const draft = {
  id: draftId,
  digest: 'd'.repeat(64),
  status: 'pending',
  outcome: null,
  agentChange: null,
  workflowNextRunAt: null,
  proposal: { kind: 'workflow', targetId: uuid('e'), input: { expectedRevision: null, activate: true, definition } },
};
const attachment = {
  id: fileId,
  filename: 'Customer review policy.txt',
  mediaType: 'text/plain',
  size: 24,
  state: 'bound',
  sha256: 'f'.repeat(64),
  expiresAt: at,
};
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
const binding = {
  installationId: uuid('e'),
  installationGeneration: 1,
  identityId: uuid('f'),
  slackUserId: 'UPROOF',
  teamId: 'TPROOF',
};

test('agent flows resolve permitted names without changing commands or approvals', { timeout: 240000 }, async () => {
  const server = await startBuiltApp({ port: Number(process.env.AGENT_FLOW_PORT ?? 0) });
  const cdp = process.env.AGENT_FLOW_CDP_PORT;
  const browser = await chromium.launch(builderBrowserOptions(cdp));
  const { origin } = server;
  const shots = process.env.AGENT_FLOW_SCREENSHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  let activePage;
  try {
    for (const width of [1440, 320, 375, 414, 768]) {
      const context = await browser.newContext({
        viewport: { width, height: 1100 },
        reducedMotion: 'reduce',
        hasTouch: width < 768,
        isMobile: width < 768,
        colorScheme: width === 375 ? 'dark' : 'light',
      });
      const page = await context.newPage();
      activePage = page;
      page.setDefaultTimeout(15000);
      const writes = [],
        failures = [];
      let tableStatus = 200,
        tableVisible = true,
        agentStatus = 200,
        sourceStatus = 200,
        fileStatus = 200;
      let slackStatus = 200,
        slackCode = 'slack-insufficient-scope',
        slackEmpty = false,
        writeStatus = 200;
      let attached = false,
        noActivations = false,
        agentDelay = 0;
      let releaseChannels;
      const channelsReady = new Promise(resolve => {
        releaseChannels = resolve;
      });
      page.on('pageerror', error => failures.push(error.message));
      await page.route('**/v1/**', async route => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname;
        const send = (json, status = 200) => route.fulfill({ json, status });
        if (path === '/v1/auth/get-session')
          return send({
            session: { id: 'synthetic-proof', userId: 'proof' },
            user: { id: 'proof', name: 'Proof member', email: 'proof@example.test' },
          });
        if (path === '/v1/user/visit') return send({ firstSession: false });
        if (path === '/v1/workspaces') return send([workspace]);
        if (path === `/v1/workspaces/${workspace.slug}`) return send(workspace);
        if (path.endsWith('/governance/me'))
          return send({
            membershipId: mid,
            role: 'admin',
            teams,
            capabilities: { manageGovernance: true, canLeave: true },
          });
        if (path.endsWith('/credits'))
          return send({ available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] });
        if (path.endsWith('/model-catalog')) return send({ families });
        if (path.endsWith('/agents/authoring-context'))
          return send({ currentSoulRevision: 'a'.repeat(40), teams, admin: true });
        if (path.endsWith('/agents/sharing-candidates'))
          return send({
            membershipId: mid,
            people: [{ membershipId: mid, userId: 'proof', name: 'Proof member', email: 'proof@example.test' }],
            teams,
          });
        if (path.endsWith(`/agents/${aid}`)) {
          if (agentDelay) await new Promise(resolve => setTimeout(resolve, agentDelay));
          return agentStatus === 200
            ? send({ ...agent, activations: noActivations ? [] : agent.activations })
            : send({ error: 'agent-unavailable' }, agentStatus);
        }
        if (path.endsWith('/policy')) return send(policy);
        if (path.endsWith('/schedules'))
          return send([
            {
              id: uuid('d'),
              activationId,
              action: { kind: 'inspect', tableId },
              trigger: { kind: 'interval', minutes: 60 },
              sponsorMembershipId: mid,
              historyAudience: [],
              enabled: true,
              revoked: false,
              paused: false,
              pauseReason: null,
              revision: 'b'.repeat(64),
              nextRunAt: at,
              lastRun: null,
            },
          ]);
        if (path.endsWith('/slack/destinations')) return send({ destinations: [] });
        if (path.endsWith('/knowledge/slack/discover')) {
          assert.equal(url.searchParams.get('kind'), 'channels');
          await channelsReady;
          await new Promise(resolve => setTimeout(resolve, 300));
          if (slackStatus !== 200) return send({ error: slackCode }, slackStatus);
          return send({
            binding,
            items: slackEmpty
              ? []
              : [
                  {
                    conversationId: url.searchParams.has('cursor') ? 'GPRIVATE' : 'CCUSTOMERS',
                    title: url.searchParams.has('cursor') ? 'Customer escalations' : 'Customer operations',
                    kind: url.searchParams.has('cursor') ? 'private' : 'public',
                  },
                ],
            nextCursor: slackEmpty || url.searchParams.has('cursor') ? null : 'second-page',
          });
        }
        if (path.includes('/slack/channels/')) {
          if (request.method() === 'PUT') {
            writes.push({ path, body: request.postDataJSON() });
            attached = true;
            return send({ version: 1 });
          }
          return send({
            version: attached ? 1 : 0,
            agentId: attached ? aid : null,
            occupied: attached,
            channelResponses: true,
          });
        }
        if (path.endsWith('/chat')) return send({ configured: true });
        if (path.endsWith('/tables'))
          return tableStatus === 200
            ? send({
                tables: tableVisible
                  ? [
                      {
                        id: tableId,
                        revision: 'a'.repeat(40),
                        appliedAt: at,
                        recordCount: '0',
                        definition: {
                          formatVersion: 2,
                          id: tableId,
                          owningTeamId: teamId,
                          label: 'Customers',
                          fields: [],
                          uniqueKeys: [],
                        },
                      },
                    ]
                  : [],
                nextCursor: null,
              })
            : send({ error: 'table-unavailable' }, tableStatus);
        if (path.includes('/workspace-mcp/')) return send({ enabled: false });
        if (path.endsWith('/github/accounts')) return send({ configured: true, accounts: [] });
        if (path.includes('/github/tasks/') && path.endsWith('/selection'))
          return send({ accountId: null, generation: null, version: 0 });
        if (path.includes('/google-workspace')) return send({ configured: false, status: 'disconnected' });
        if (path.endsWith('/projects') || path.endsWith('/candidates')) return send([]);
        if (request.method() === 'POST' && path.includes('/agent-tasks')) {
          writes.push({ path, body: request.postDataJSON() });
          await new Promise(resolve => setTimeout(resolve, 200));
          return writeStatus === 200
            ? send({ id: taskId, generation: 2, status: 'pending' })
            : send({ error: 'unconfirmed' }, writeStatus);
        }
        if (path.endsWith('/agent-tasks'))
          return send({
            tasks: [{ ...task, id: priorId }],
            nextCursor: url.searchParams.has('after') ? null : 'next-tasks',
          });
        if (path.endsWith(`/agent-tasks/${taskId}`)) return send(task);
        if (path.endsWith('/history'))
          return path.includes(priorId) && sourceStatus !== 200
            ? send({ error: 'source-unavailable' }, sourceStatus)
            : send({
                messages: [
                  {
                    sequence: 0,
                    generation: 1,
                    role: 'owner',
                    text: 'Review overdue invoices',
                    sources: [],
                    createdAt: at,
                  },
                ],
                nextCursor: null,
              });
        if (path.endsWith('/proposals')) return send({ proposals: [], nextCursor: null });
        if (path.endsWith('/conversations'))
          return send({ chats: [{ ...chat, id: fileChatId, title: 'Review documents' }], nextCursor: null });
        if (path.endsWith(`/conversations/${chatId}`)) return send(chat);
        if (path.endsWith(`/conversations/${fileChatId}`))
          return send({ ...chat, id: fileChatId, title: 'Review documents' });
        if (path.endsWith(`/drafts/${draftId}/decision`)) {
          writes.push({ path, body: request.postDataJSON() });
          return send({
            kind: 'workflow',
            workflowId: uuid('e'),
            revision: draftId,
            enabled: true,
            nextRunAt: null,
            activation: 'activated',
          });
        }
        if (path.endsWith(`/drafts/${draftId}`)) return send(draft);
        if (path.endsWith(`/uploads/${fileId}`))
          return fileStatus === 200 ? send(attachment) : send({ error: 'file-unavailable' }, fileStatus);
        if (path.endsWith('/messages'))
          return send({
            messages: [
              {
                id: uuid('e'),
                sequence: 1,
                author: 'human',
                createdAt: at,
                parts: path.includes(fileChatId)
                  ? [{ kind: 'attachment', attachmentId: fileId }]
                  : [{ kind: 'text', text: 'Prepare a customer review workflow.' }],
                turn: { id: uuid('f'), status: 'completed', generation: 0 },
                tools: path.includes(fileChatId)
                  ? []
                  : [
                      {
                        id: draftId,
                        tool: 'workflows.draft',
                        status: 'completed',
                        activity: null,
                        presentation: { label: 'Preparing a workflow for review', brand: null },
                        web: null,
                      },
                    ],
                calendarResults: [],
              },
            ],
            nextBefore: null,
            hasGitHubProposals: false,
          });
        if (path.endsWith('/plans')) return send({ plans: [], nextCursor: null });
        return send({ error: 'synthetic-route-unavailable' }, 404);
      });
      const invalidate = keys =>
        page.evaluate(
          ({ keys, workspaceId, membershipId }) => {
            const channel = new BroadcastChannel('tulipfarm:query:v1');
            channel.postMessage({
              version: 1,
              id: crypto.randomUUID(),
              sessionId: 'other-tab',
              scope: { kind: 'workspace', userId: 'proof', workspaceId, membershipId },
              kind: 'change',
              keys,
            });
            channel.close();
          },
          { keys, workspaceId: wid, membershipId: mid },
        );
      const capture = async label => {
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          `${label}: viewport ${width}`,
        );
        assert.equal(
          await page.locator('main').evaluate(node => node.scrollWidth <= node.clientWidth + 1),
          true,
          `${label}: main ${width}`,
        );
        if (!shots) return;
        await page.evaluate(() => document.fonts.ready);
        if (cdp)
          execFileSync(
            'agent-browser',
            ['--session', 'agent-flows-regression', '--cdp', cdp, 'screenshot', `${shots}/${label}-${width}.png`],
            { stdio: 'pipe' },
          );
        else await page.screenshot({ path: `${shots}/${label}-${width}.png` });
      };
      const addContext = async () => {
        await page.getByRole('button', { name: 'Attach past task or chat file', exact: true }).click();
        await page.getByRole('checkbox', { name: 'Review overdue invoices', exact: true }).check();
        await page.getByRole('combobox', { name: 'Files from a personal chat', exact: true }).click();
        await page.getByRole('option', { name: 'Review documents', exact: true }).click();
        await page.getByRole('checkbox', { name: attachment.filename, exact: true }).check();
        await page.getByRole('button', { name: 'Hide optional context', exact: true }).click();
        const selected = page.getByRole('list', { name: 'Selected task context', exact: true });
        await selected.getByText('Review overdue invoices', { exact: true }).waitFor();
        await selected.getByText(attachment.filename, { exact: true }).waitFor();
        assert.doesNotMatch(await selected.innerText(), /reference [12]/);
      };
      const removeContext = async () => {
        await page.getByRole('button', { name: 'Remove Review overdue invoices', exact: true }).click();
        await page.getByRole('button', { name: `Remove ${attachment.filename}`, exact: true }).click();
      };
      const openTab = name => page.getByRole('tab', { name, exact: true }).click();
      await page.goto(`${origin}/agent-proof/agents/${aid}`);
      const form = page.getByRole('form', { name: 'Task message', exact: true });
      await form.waitFor();
      assert.equal(await page.getByText(/optional prompt/).count(), 0);
      await page.getByRole('button', { name: 'Start task', exact: true }).click();
      await page.getByText('Write what the agent should do.', { exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole('textbox', { name: 'What should this agent do?', exact: true })
          .getAttribute('aria-required'),
        'true',
      );
      assert.equal(writes.length, 0);
      await addContext();
      await form.scrollIntoViewIfNeeded();
      await capture('start-context');
      if (width === 1440) {
        await page.getByRole('button', { name: 'Attach past task or chat file', exact: true }).click();
        await page.getByRole('button', { name: 'More past tasks', exact: true }).click();
        await page.getByRole('button', { name: 'Hide optional context', exact: true }).click();
        await page.getByRole('button', { name: 'Remove Review overdue invoices', exact: true }).waitFor();
        sourceStatus = 403;
        fileStatus = 403;
        await invalidate([
          ['tasks', 'detail', priorId],
          ['conversations', 'detail', fileChatId],
        ]);
        const selected = page.getByRole('list', { name: 'Selected task context', exact: true });
        await selected.getByText('Task name unavailable', { exact: true }).waitFor();
        await selected.getByText('File name unavailable', { exact: true }).waitFor();
        assert.equal(await selected.getByText('Review overdue invoices', { exact: true }).count(), 0);
        sourceStatus = 400;
        await page.getByRole('button', { name: 'Check task name again', exact: true }).click();
        await selected.getByText('Task name could not load', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Check task name again', exact: true }).click();
        await selected.getByText('Task name could not load', { exact: true }).waitFor();
        sourceStatus = 200;
        fileStatus = 200;
        await page.getByRole('button', { name: 'Check task name again', exact: true }).click();
        await page.getByRole('button', { name: 'Check file name again', exact: true }).click();
        await selected.getByText(attachment.filename, { exact: true }).waitFor();
        await page
          .getByRole('textbox', { name: 'What should this agent do?', exact: true })
          .fill('Review these sources.');
        writeStatus = 500;
        await page.getByRole('button', { name: 'Start task', exact: true }).dblclick();
        await page.getByRole('button', { name: 'Retry same operation', exact: true }).waitFor();
        assert.equal(writes.length, 1);
        assert.deepEqual(writes[0].body.sources, [
          { kind: 'task', taskId: priorId, throughSequence: 0 },
          { kind: 'attachment', conversationId: fileChatId, attachmentId: fileId },
        ]);
        assert.equal(
          await page.getByRole('textbox', { name: 'What should this agent do?', exact: true }).inputValue(),
          'Review these sources.',
        );
        writeStatus = 200;
        await page.getByRole('button', { name: 'Retry same operation', exact: true }).click();
        await page.waitForURL(`**/agent-tasks/${taskId}`);
        assert.deepEqual(writes[1], writes[0], 'uncertain start retries the same request and source IDs');
      } else await removeContext();
      await page.goto(`${origin}/agent-proof/agent-tasks/${taskId}`);
      await addContext();
      await form.scrollIntoViewIfNeeded();
      await capture('reply-context');
      if (width === 1440) {
        await page.getByRole('textbox', { name: 'Follow up on this task', exact: true }).fill('Continue the review.');
        await page.getByRole('button', { name: 'Send follow-up', exact: true }).click();
        await page.getByRole('list', { name: 'Selected task context', exact: true }).waitFor({ state: 'detached' });
        assert.deepEqual(writes.at(-1).body.sources, writes[0].body.sources);
        assert.equal(writes.at(-1).body.expectedGeneration, 1);
      } else await removeContext();
      await page.goto(`${origin}/agent-proof/agents/${aid}`);
      await openTab('Execution');
      await page.getByRole('button', { name: 'Saved execution limits (1)', exact: true }).click();
      const execution = page.getByRole('region', { name: 'Execution', exact: true });
      await execution.getByText('Customers', { exact: true }).waitFor();
      assert.doesNotMatch(await execution.innerText(), new RegExp(tableId));
      await capture('saved-limits');
      const activations = page.getByRole('region', { name: 'Agent activations', exact: true });
      await activations.getByText('Customers', { exact: true }).first().waitFor();
      assert.doesNotMatch(await activations.innerText(), new RegExp(tableId));
      await activations.scrollIntoViewIfNeeded();
      await capture('activation');
      if (width === 1440) {
        tableStatus = 400;
        await invalidate([['tables']]);
        await activations.getByText('Could not refresh this name.', { exact: true }).first().waitFor();
        await activations.getByText('Customers', { exact: true }).first().waitFor();
        tableStatus = 200;
        tableVisible = false;
        await activations.getByRole('button', { name: 'Check table name again', exact: true }).first().click();
        await activations.getByText('Table name unavailable', { exact: true }).first().waitFor();
        assert.equal(await activations.getByText('Customers', { exact: true }).count(), 0);
        tableVisible = true;
        await activations.getByRole('button', { name: 'Check table name again', exact: true }).first().click();
        await activations.getByText('Customers', { exact: true }).first().waitFor();
        noActivations = true;
        await page.reload();
      }
      await openTab('Triggers');
      const schedules = page.getByRole('list', { name: 'Agent schedule list', exact: true });
      await schedules.getByText('Customers', { exact: true }).waitFor();
      assert.doesNotMatch(await schedules.innerText(), new RegExp(tableId));
      await schedules.scrollIntoViewIfNeeded();
      await capture('inspection-schedule');
      await openTab('Slack');
      const slack = page.getByRole('region', { name: 'Slack channel attachment', exact: true });
      await slack.getByRole('status', { name: 'Loading Slack channels', exact: true }).waitFor();
      releaseChannels();
      const retryChannelList = async () => {
        await page.waitForFunction(() =>
          [...document.querySelectorAll('button')].some(
            button => button.textContent === 'Retry channel list' && !button.disabled,
          ),
        );
        await Promise.all([
          page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/knowledge/slack/discover')),
          slack.getByRole('button', { name: 'Retry channel list', exact: true }).click(),
        ]);
      };
      await slack.getByRole('combobox', { name: 'Slack channel', exact: true }).click();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await slack.getByText('Customer operations', { exact: true }).waitFor();
      await capture('slack-picker');
      await slack.getByRole('button', { name: 'Next channels', exact: true }).click();
      await slack.getByRole('combobox', { name: 'Slack channel', exact: true }).click();
      await page.getByRole('option', { name: 'Customer escalations (private)', exact: true }).click();
      if (width === 1440) {
        const before = writes.length;
        await slack.getByRole('button', { name: 'Check channel', exact: true }).click();
        await slack.getByText('No agent is attached to this channel.', { exact: true }).waitFor();
        assert.equal(writes.length, before);
        await slack.getByRole('button', { name: 'Attach agent', exact: true }).click();
        await slack.getByText('Agent attached', { exact: true }).waitFor();
        assert.equal(writes.at(-1).path.endsWith('/channels/GPRIVATE'), true);
        assert.deepEqual(writes.at(-1).body, { agentId: aid, expectedVersion: 0 });
        slackStatus = 403;
        await invalidate([['integrations', 'slack']]);
        await slack.getByText(/Your current Slack link cannot list channels/).waitFor();
        assert.equal(await slack.getByText('Customer escalations', { exact: true }).count(), 0);
        await slack.getByRole('button', { name: 'Use a channel ID instead', exact: true }).click();
        await slack.getByRole('textbox', { name: 'Slack channel ID', exact: true }).fill('COTHER');
        await slack.getByRole('button', { name: 'Check channel', exact: true }).click();
        await slack.getByText('This agent is already attached.', { exact: true }).waitFor();
        await slack.getByRole('button', { name: 'Choose from my Slack channels', exact: true }).click();
        slackStatus = 400;
        slackCode = 'synthetic-failure';
        await retryChannelList();
        await slack.getByText(/Could not refresh Slack channels/).waitFor();
        await retryChannelList();
        await slack.getByText(/Could not refresh Slack channels/).waitFor();
        slackStatus = 200;
        slackEmpty = true;
        await retryChannelList();
        await slack.getByText('No Slack channels on this page', { exact: true }).waitFor();
        slackStatus = 400;
        await retryChannelList();
        await slack.getByText(/Could not refresh Slack channels/).waitFor();
        assert.equal(await slack.getByRole('button', { name: 'Retry channel list', exact: true }).count(), 1);
        slackStatus = 200;
        slackEmpty = false;
        await retryChannelList();
        await slack.getByRole('combobox', { name: 'Slack channel', exact: true }).click();
        await page.getByRole('option', { name: 'Customer escalations (private)', exact: true }).waitFor();
        await page.keyboard.press('Escape');
      }
      noActivations = false;
      agentDelay = width === 1440 ? 1000 : 0;
      await page.goto(`${origin}/agent-proof/chat/${chatId}`);
      const review = page.getByRole('region', { name: 'Review workflow draft', exact: true });
      await review
        .getByRole('region', { name: 'Workflow: View workflow draft', exact: true })
        .getByRole('button', { name: 'View workflow', exact: true })
        .click();
      await page.getByRole('region', { name: 'Canvas', exact: true }).waitFor();
      const workflow = page.getByRole('region', { name: 'Review customers workflow', exact: true });
      if (width === 1440) await workflow.getByText('Loading connected names...', { exact: false }).waitFor();
      await workflow.getByRole('button', { name: 'Steps', exact: true }).click();
      await workflow.getByRole('button', { name: 'Inspect Run an agent task', exact: true }).click();
      const inspector = workflow.getByRole('region', { name: 'Step details', exact: true });
      await inspector.getByText('Customer reviewer', { exact: true }).first().waitFor();
      await inspector.getByText('"Review customers."', { exact: true }).waitFor();
      assert.doesNotMatch(await inspector.innerText(), new RegExp(aid));
      await capture('workflow-agent');
      if (width === 1440) {
        agentStatus = 403;
        await invalidate([['agents', 'detail', aid]]);
        await inspector.getByText('Agent name unavailable', { exact: true }).first().waitFor();
        assert.equal(await workflow.getByText('Customer reviewer', { exact: true }).count(), 0);
        agentStatus = 400;
        await workflow.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
        await workflow.getByText(/Some names could not refresh/).waitFor();
        assert.equal(await workflow.getByText('Customer reviewer', { exact: true }).count(), 0);
        agentStatus = 200;
        await workflow.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
        await inspector.getByText('Customer reviewer', { exact: true }).first().waitFor();
        await page.getByRole('button', { name: 'Close Workflow draft', exact: true }).click();
        assert.equal(await workflow.count(), 0, 'the compact review still works without an open workflow diagram');
        await review.getByRole('button', { name: 'Save and activate', exact: true }).click();
        for (let count = 0; !writes.at(-1)?.path.endsWith('/decision'); count++) {
          assert.ok(count < 50);
          await page.waitForTimeout(50);
        }
        assert.deepEqual(Object.keys(writes.at(-1).body).sort(), ['commandId', 'decision', 'digest']);
        assert.equal(writes.at(-1).body.digest, draft.digest);
        assert.equal(writes.at(-1).body.decision, 'save');
      }
      assert.deepEqual(failures, []);
      await context.close();
    }
  } catch (error) {
    await captureBrowserFailure(activePage, 'agent-flow-names');
    throw error;
  } finally {
    await browser.close();
    await server.close();
  }
});
