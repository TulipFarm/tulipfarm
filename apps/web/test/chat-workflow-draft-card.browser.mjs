import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture, serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';
import { assertConfiguration } from './workflow-definition.fixture.mjs';

const chatId = '12121212-1212-4212-8212-121212121212';
const workflowId = '66666666-6666-4666-8666-666666666666';
const saveDraft = '14141414-1414-4414-8414-141414141414';
const webhookDraft = '16161616-1616-4616-8616-161616161616';
const codeSource = 'export default ({ amount }) => {\n  return { cents: Math.round(amount * 100) };\n};';
const webhookDefinition = {
  version: 1,
  name: 'Record Stripe payments',
  trigger: {
    kind: 'webhook',
    payload: {
      mode: 'raw',
      dedupe: { source: 'body', path: ['data', 'id'] },
      headers: ['stripe-account', 'x-request-id'],
    },
  },
  steps: [
    {
      id: 'shape_payment',
      kind: 'transform',
      fields: { amount: { kind: 'input', path: ['body', 'amount'] }, currency: { kind: 'literal', value: 'usd' } },
    },
    {
      id: 'to_cents',
      kind: 'code',
      language: 'javascript',
      source: codeSource,
      input: { kind: 'step', step: 'shape_payment', path: [] },
    },
  ],
};
const disableDraft = '15151515-1515-4515-8515-151515151515';
const recordDraft = '18181818-1818-4818-8818-181818181818';
const recordDefinition = {
  version: 1,
  name: 'Ticket due reminder',
  trigger: {
    kind: 'record',
    tableId: '19191919-1919-4919-8919-191919191919',
    field: {
      kind: 'date',
      fieldId: '20202020-2020-4020-8020-202020202020',
      offset: { direction: 'before', amount: 1, unit: 'days' },
      time: '09:00',
      timezone: 'America/New_York',
    },
    filter: {
      fieldId: '21212121-2121-4121-8121-212121212121',
      match: 'is-not',
      value: { kind: 'single-select', optionId: '23232323-2323-4323-8323-232323232323' },
    },
  },
  steps: [{ id: 'note', kind: 'transform', fields: { record: { kind: 'input', path: ['recordId'] } } }],
};
const rowDraft = '24242424-2424-4424-8424-242424242424';
const slackDraft = '28282828-2828-4828-8828-282828282828';
const destinationId = '29292929-2929-4929-8929-292929292929';
const slackDefinition = {
  version: 1,
  name: 'Tickets to #tech',
  trigger: { kind: 'row', tableId: '19191919-1919-4919-8919-191919191919', event: 'created' },
  steps: [
    { id: 'notify', kind: 'slack-message', destinationId, text: { kind: 'input', path: ['values', 'title', 'value'] } },
  ],
};
const rowDefinition = {
  version: 1,
  name: 'Large order note',
  trigger: {
    kind: 'row',
    tableId: '26262626-2626-4262-8262-262626262626',
    event: 'updated',
    fieldIds: ['25252525-2525-4525-8525-252525252525'],
    filter: {
      fieldId: '25252525-2525-4525-8525-252525252525',
      match: 'gte',
      value: { kind: 'numeric', value: '1000' },
    },
  },
  steps: [
    {
      id: 'note',
      kind: 'transform',
      fields: { amount: { kind: 'input', path: ['values', '25252525-2525-4525-8525-252525252525', 'value'] } },
    },
  ],
};
const revision = '77777777-7777-4777-8777-777777777777';
const definition = {
  version: 1,
  name: 'Review open tickets',
  trigger: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'America/New_York' },
  steps: [{ id: 'review_tickets', kind: 'human', prompt: 'Review open tickets.', timeoutSeconds: 86400 }],
};
const tool = (id, name) => ({
  id,
  tool: name,
  status: 'completed',
  activity: null,
  presentation: { label: 'Preparing a workflow for review', brand: null },
  web: null,
});
const savedOutcome = {
  kind: 'workflow',
  workflowId,
  revision: saveDraft,
  enabled: true,
  nextRunAt: '2026-10-12T13:00:00.000Z',
  activation: 'activated',
};
const tableDefinitions = [
  {
    formatVersion: 2,
    id: recordDefinition.trigger.tableId,
    owningTeamId: membership.membershipId,
    label: 'Tickets',
    uniqueKeys: [],
    fields: [
      { id: recordDefinition.trigger.field.fieldId, label: 'Due date', kind: 'date', required: false },
      {
        id: recordDefinition.trigger.filter.fieldId,
        label: 'Stage',
        kind: 'single-select',
        required: false,
        options: [{ id: recordDefinition.trigger.filter.value.optionId, label: 'Closed', retired: false }],
      },
    ],
  },
  {
    formatVersion: 2,
    id: rowDefinition.trigger.tableId,
    owningTeamId: membership.membershipId,
    label: 'Orders',
    uniqueKeys: [],
    fields: [
      {
        id: rowDefinition.trigger.fieldIds[0],
        label: 'Amount',
        kind: 'numeric',
        required: false,
        precision: 12,
        scale: 2,
      },
    ],
  },
];
const initialDrafts = () => ({
  [saveDraft]: {
    id: saveDraft,
    digest: 'd'.repeat(64),
    status: 'pending',
    outcome: null,
    agentChange: null,
    workflowNextRunAt: '2026-10-12T13:00:00.000Z',
    proposal: { kind: 'workflow', targetId: workflowId, input: { expectedRevision: null, definition, activate: true } },
  },
  [disableDraft]: {
    id: disableDraft,
    digest: 'e'.repeat(64),
    status: 'pending',
    outcome: null,
    agentChange: null,
    workflowNextRunAt: null,
    proposal: {
      kind: 'workflow-activation',
      targetId: workflowId,
      input: {
        revision,
        enabled: false,
        definition: { ...definition, name: 'Old ticket sweep', steps: [{ id: 'sweep', kind: 'delay', seconds: 60 }] },
      },
    },
  },
  [webhookDraft]: {
    id: webhookDraft,
    digest: 'f'.repeat(64),
    status: 'pending',
    outcome: null,
    agentChange: null,
    workflowNextRunAt: null,
    proposal: {
      kind: 'workflow',
      targetId: workflowId,
      input: { expectedRevision: null, definition: webhookDefinition, activate: true },
    },
  },
  [recordDraft]: {
    id: recordDraft,
    digest: 'a'.repeat(64),
    status: 'pending',
    outcome: null,
    agentChange: null,
    workflowNextRunAt: null,
    workflowRecordSource: {
      table: 'Tickets',
      field: 'Due date',
      filter: { field: 'Stage', match: 'is-not', value: 'Closed' },
    },
    proposal: {
      kind: 'workflow',
      targetId: workflowId,
      input: { expectedRevision: null, definition: recordDefinition, activate: true },
    },
  },
  [rowDraft]: {
    id: rowDraft,
    digest: 'b'.repeat(64),
    status: 'pending',
    outcome: null,
    agentChange: null,
    workflowNextRunAt: null,
    workflowRowSource: {
      table: 'Orders',
      fields: ['Amount'],
      filter: { field: 'Amount', match: 'gte', value: '1000' },
    },
    proposal: {
      kind: 'workflow',
      targetId: workflowId,
      input: { expectedRevision: null, definition: rowDefinition, activate: true },
    },
  },
  [slackDraft]: {
    id: slackDraft,
    digest: 'c'.repeat(64),
    status: 'pending',
    outcome: null,
    agentChange: null,
    workflowNextRunAt: null,
    workflowRowSource: { table: 'Tickets', fields: [], filter: null },
    proposal: {
      kind: 'workflow',
      targetId: workflowId,
      input: { expectedRevision: null, definition: slackDefinition, activate: true },
    },
  },
});

test(
  'compact workflow reviews use Canvas inspectors and same-chat editing while retaining exact approval and Slack checks',
  { timeout: 120000 },
  async () => {
    const { workspace, session } = createWorkspaceFixture();
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const cdpPort = process.env.WORKFLOW_DRAFT_CDP_PORT;
    const browser = await chromium.launch({
      headless: process.env.CHAT_BROWSER_HEADED !== '1',
      ...(cdpPort ? { args: [`--remote-debugging-port=${cdpPort}`] } : {}),
    });
    const shots = process.env.WORKFLOW_DRAFT_SCREENSHOTS;
    try {
      for (const mobile of [false, true]) {
        const context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
          hasTouch: mobile,
          isMobile: mobile,
          colorScheme: mobile ? 'dark' : 'light',
          reducedMotion: 'reduce',
          timezoneId: 'Europe/London',
          locale: 'en-US',
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        page.setDefaultNavigationTimeout(60000);
        const errors = [],
          reads = [],
          decisions = [],
          sendRequests = [],
          definitionReads = [];
        const drafts = initialDrafts();
        let failReads = true;
        let slackFailure = 503;
        let tableFailure = 0;
        let loseDecisionResponse = true;
        page.on('pageerror', error => errors.push(error.message));
        const chat = {
          id: chatId,
          title: 'Workflow drafts',
          titleRevision: 1,
          titleManual: false,
          archived: false,
          activityAt: '2026-10-08T10:00:00.000000Z',
          createdAt: '2026-10-08T10:00:00.000000Z',
          projectId: null,
        };
        const history = [
          {
            id: '13131313-1313-4313-8313-131313131313',
            sequence: 1,
            author: 'human',
            createdAt: '2026-10-08T10:00:01.000Z',
            parts: [
              {
                kind: 'text',
                text: 'Every weekday at 9am in New York, ask me to review open tickets. Also turn off the old sweep.',
              },
            ],
            turn: { id: '88888888-8888-4888-8888-888888888888', status: 'completed', generation: 0 },
            tools: [
              tool(saveDraft, 'workflows.draft'),
              tool(disableDraft, 'workflows.draft'),
              tool(webhookDraft, 'workflows.draft'),
              tool(recordDraft, 'workflows.draft'),
              tool(rowDraft, 'workflows.draft'),
              tool(slackDraft, 'workflows.draft'),
            ],
            calendarResults: [],
          },
          {
            id: '17171717-1717-4717-8717-171717171717',
            sequence: 2,
            author: 'assistant',
            createdAt: '2026-10-08T10:00:02.000Z',
            parts: [{ kind: 'text', text: 'Review both cards.' }],
            turn: null,
            tools: [],
            calendarResults: [],
          },
        ];
        await page.route('**/v1/**', async route => {
          const request = route.request();
          const path = new URL(request.url()).pathname;
          const method = request.method();
          if (await serveWorkspaceShellEvent(route, workspace)) return;
          const shell = workspaceShellReads(workspace.id).find(([url]) => url === path);
          if (shell) return route.fulfill({ json: shell[1] });
          if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
          if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
          if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
          if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
          if (path.endsWith('/governance/me')) return route.fulfill({ json: membership });
          if (path.endsWith('/credits')) return route.fulfill({ json: credits });
          if (path.endsWith('/model-catalog')) return route.fulfill({ json: chatCatalog });
          if (path.endsWith('/google-workspace/availability')) return route.fulfill({ json: { configured: false } });
          if (path.endsWith('/google-workspace')) return route.fulfill({ json: { status: 'disconnected' } });
          if (path.endsWith('/projects')) return route.fulfill({ json: [] });
          if (path.endsWith('/google-workspace/operations/proposals'))
            return route.fulfill({ json: { proposals: [], nextCursor: null } });
          if (path.endsWith('/workspace-mcp/capabilities'))
            return route.fulfill({ status: 404, json: { error: 'not-found' } });
          if (path.endsWith('/candidates')) return route.fulfill({ json: [] });
          if (path.endsWith('/integrations')) return route.fulfill({ json: { integrations: [] } });
          if (path.endsWith('/system-package-installations'))
            return route.fulfill({ json: { installations: [], nextCursor: null } });
          if (path.endsWith('/governance')) return route.fulfill({ status: 404, json: { error: 'not-found' } });
          const table = tableDefinitions.find(item => path.endsWith(`/tables/${item.id}`));
          if (table)
            return tableFailure
              ? route.fulfill({ status: tableFailure, json: { error: 'table-unavailable' } })
              : route.fulfill({
                  json: {
                    id: table.id,
                    saved: null,
                    applied: { revision: 'a'.repeat(40), definition: table, appliedAt: workspace.createdAt },
                  },
                });
          if (path.endsWith(`/workflows/${workflowId}`)) {
            const requestedRevision = new URL(request.url()).searchParams.get('revision');
            definitionReads.push(requestedRevision);
            assert.equal(
              requestedRevision,
              saveDraft,
              'the settled review opens its exact saved revision, not the draft or current workflow',
            );
            return route.fulfill({
              json: {
                workflowId,
                revision: saveDraft,
                savedRevision: saveDraft,
                activeRevision: saveDraft,
                definition,
                actor: null,
                canManage: true,
                archived: false,
              },
            });
          }
          if (path.endsWith(`/slack/destinations/${destinationId}`)) {
            await new Promise(resolve => setTimeout(resolve, 300));
            return slackFailure
              ? route.fulfill({ status: slackFailure, json: { error: 'slack-destination-unavailable' } })
              : route.fulfill({
                  json: {
                    id: destinationId,
                    name: 'tech',
                    channel: 'CTECH',
                    teamId: 'TTEST',
                    installationId: workflowId,
                  },
                });
          }
          if (path.endsWith('/conversations') && method === 'GET')
            return route.fulfill({ json: { chats: [chat], nextCursor: null } });
          const conversation = /\/conversations\/([\w-]+)(\/.*)?$/.exec(path);
          if (conversation) {
            const [, , rest = ''] = conversation;
            const draft = /^\/drafts\/([\w-]+)$/.exec(rest);
            if (method === 'GET' && draft && drafts[draft[1]]) {
              reads.push(draft[1]);
              if (draft[1] === saveDraft && failReads)
                return route.fulfill({ status: 503, json: { error: 'draft-unavailable' } });
              if (draft[1] === saveDraft) await new Promise(resolve => setTimeout(resolve, 300));
              return route.fulfill({ json: drafts[draft[1]] });
            }
            const decision = /^\/drafts\/([\w-]+)\/decision$/.exec(rest);
            if (method === 'PUT' && decision) {
              decisions.push({ id: decision[1], body: request.postDataJSON() });
              if (decision[1] === saveDraft && loseDecisionResponse) {
                loseDecisionResponse = false;
                return route.abort('failed');
              }
              const outcome =
                decision[1] === saveDraft ? savedOutcome : { ...savedOutcome, revision: decision[1], nextRunAt: null };
              drafts[decision[1]] = { ...drafts[decision[1]], status: 'saved', outcome };
              return route.fulfill({ json: outcome });
            }
            if (method !== 'GET') {
              sendRequests.push({ path, body: request.postDataJSON() });
              return route.fulfill({ status: 405, json: { error: 'unexpected-send' } });
            }
            if (method === 'GET' && rest === '/messages')
              return route.fulfill({ json: { messages: history, nextBefore: null, hasGitHubProposals: false } });
            if (method === 'GET' && !rest) return route.fulfill({ json: chat });
            if (method === 'GET') return route.fulfill({ json: [] });
          }
          throw new Error(`Unexpected API request ${method} ${path}`);
        });
        try {
          await page.goto(`${server.resolvedUrls.local[0]}${workspace.slug}/chat/${chatId}`);
          const cards = page.getByRole('region', { name: 'Review workflow draft' });
          const created = cards.nth(0),
            disabling = cards.nth(1),
            webhook = cards.nth(2),
            record = cards.nth(3),
            row = cards.nth(4),
            slack = cards.nth(5);
          await page.getByText('Could not load draft', { exact: true }).waitFor({ timeout: 60000 });
          failReads = false;
          await page.getByRole('button', { name: 'Retry loading draft' }).click();
          await created.getByText('Creates a new workflow and activates it', { exact: true }).waitFor();
          assert.equal(
            await page.locator('[data-slot="activity-viewport"] [aria-label="Review workflow draft"]').count(),
            0,
            'draft cards render outside the capped activity timeline',
          );
          await created
            .getByText('1 step. Next run Monday, October 12, 2026 at 9:00 AM EDT.', { exact: true })
            .waitFor();
          const canvas = page.getByRole('region', { name: 'Canvas', exact: true });
          const returnToChat = async () => {
            if (mobile && (await canvas.count()))
              await canvas.getByRole('button', { name: 'Back to chat', exact: true }).click();
          };
          const openDraft = async (card, name) => {
            await returnToChat();
            await card
              .getByRole('region', { name: 'Workflow: View workflow draft', exact: true })
              .getByRole('button', { name: 'View workflow', exact: true })
              .click();
            const viewer = canvas.getByRole('region', { name: `${name} workflow`, exact: true });
            await viewer.getByText('Awaiting your review', { exact: true }).waitFor();
            await viewer.getByRole('button', { name: 'Edit in chat', exact: true }).waitFor();
            return viewer;
          };
          const createdViewer = await openDraft(created, definition.name);
          await canvas.getByRole('button', { name: 'A draft needs your review. Back to chat', exact: true }).waitFor();
          if (shots) {
            await createdViewer.getByRole('figure').scrollIntoViewIfNeeded();
            await page.waitForFunction(() => {
              const transform = document.querySelector('.react-flow__viewport')?.style.transform;
              return transform && transform !== 'translate(0px, 0px) scale(1)';
            });
            const path = `${shots}/workflow-canvas-${mobile ? 'mobile-dark' : 'desktop-light'}.png`;
            if (cdpPort)
              execFileSync('agent-browser', ['--session', 'workflow-draft', '--cdp', cdpPort, 'screenshot', path], {
                stdio: 'inherit',
              });
            else await page.screenshot({ path });
          }
          const schedule = await assertConfiguration(createdViewer, 0, definition.trigger);
          await schedule.getByText('0 9 * * 1-5 / America/New_York', { exact: true }).first().waitFor();
          const human = await assertConfiguration(createdViewer, 1, definition.steps[0]);
          await human.getByText('Review open tickets.', { exact: true }).first().waitFor();
          assert.deepEqual(decisions, [], 'nothing is saved before the human chooses');
          await returnToChat();
          await disabling.getByText('Disables the workflow', { exact: true }).waitFor();
          await disabling.getByRole('button', { name: 'Disable workflow' }).waitFor();
          const disabledDefinition = drafts[disableDraft].proposal.input.definition;
          const disabledViewer = await openDraft(disabling, disabledDefinition.name);
          await assertConfiguration(disabledViewer, 1, disabledDefinition.steps[0]);
          const webhookViewer = await openDraft(webhook, webhookDefinition.name);
          const webhookTrigger = await assertConfiguration(webhookViewer, 0, webhookDefinition.trigger);
          await webhookTrigger.getByText('Raw JSON body and copied headers', { exact: true }).waitFor();
          await webhookTrigger.getByText('Body field data.id', { exact: true }).waitFor();
          await webhookTrigger.getByText('stripe-account, x-request-id', { exact: true }).waitFor();
          const transform = await assertConfiguration(webhookViewer, 1, webhookDefinition.steps[0]);
          await transform.getByText('run input body.amount', { exact: true }).waitFor();
          await transform.getByText('"usd"', { exact: true }).waitFor();
          const code = await assertConfiguration(webhookViewer, 2, webhookDefinition.steps[1]);
          await code.getByText('step shape payment output', { exact: true }).waitFor();
          assert.equal(JSON.parse(await code.locator('pre').last().textContent()).source, codeSource);
          await code.getByRole('button', { name: 'Prepare data', exact: true }).click();
          await webhookViewer
            .getByRole('region', { name: 'Step details', exact: true })
            .getByRole('heading', { name: 'Prepare data', exact: true })
            .waitFor();
          await returnToChat();
          await webhook.getByRole('button', { name: 'Save and activate' }).waitFor();
          const recordViewer = await openDraft(record, recordDefinition.name);
          const recordTrigger = await assertConfiguration(recordViewer, 0, recordDefinition.trigger);
          await recordTrigger.getByText('Tickets', { exact: true }).first().waitFor();
          await recordTrigger
            .getByText('1 day before Due date at 09:00 in America/New York', { exact: true })
            .waitFor();
          await recordTrigger.getByText('Stage is not Closed. Rows with no value also run.', { exact: true }).waitFor();
          tableFailure = 403;
          await page.evaluate(
            ({ workspaceId, userId, membershipId, tableId }) => {
              const channel = new BroadcastChannel('tulipfarm:query:v1');
              channel.postMessage({
                version: 1,
                id: crypto.randomUUID(),
                sessionId: 'other-tab',
                scope: { kind: 'workspace', workspaceId, userId, membershipId },
                kind: 'change',
                keys: [['tables', 'detail', tableId, 'definition']],
              });
              channel.close();
            },
            {
              workspaceId: workspace.id,
              userId: session.user.id,
              membershipId: membership.membershipId,
              tableId: recordDefinition.trigger.tableId,
            },
          );
          await recordTrigger.getByText('Table name unavailable', { exact: true }).first().waitFor();
          await recordTrigger.getByText(/Unavailable field is not Unavailable option/).waitFor();
          assert.equal(
            await recordTrigger.getByText(/Due date|Stage|Closed/).count(),
            0,
            'native table invalidation conceals denied field and option names, not just the table',
          );
          tableFailure = 503;
          await recordViewer.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
          await recordViewer.getByText(/Some names could not refresh/).waitFor();
          assert.equal(await recordTrigger.getByText('Tickets', { exact: true }).count(), 0);
          tableFailure = 0;
          await recordViewer.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
          await recordTrigger.getByText('Stage is not Closed. Rows with no value also run.', { exact: true }).waitFor();
          await returnToChat();
          await record.getByRole('button', { name: 'Save and activate' }).waitFor();
          const rowViewer = await openDraft(row, rowDefinition.name);
          const rowTrigger = await assertConfiguration(rowViewer, 0, rowDefinition.trigger);
          await rowTrigger.getByText('Orders / updated', { exact: true }).first().waitFor();
          await rowTrigger.getByText('Amount', { exact: true }).waitFor();
          await rowTrigger.getByText('Amount is at least 1000', { exact: true }).waitFor();
          const slackViewer = await openDraft(slack, slackDefinition.name);
          let slackStep = await assertConfiguration(slackViewer, 1, slackDefinition.steps[0]);
          await slackStep.getByText('run input values.title.value', { exact: true }).waitFor();
          await slackStep
            .getByText('The requester or sponsor approves each exact message before it is sent.', { exact: true })
            .waitFor();
          await returnToChat();
          await slack
            .getByText('Check this Slack destination before saving. The channel is not verified.', { exact: true })
            .waitFor();
          assert.equal(await slack.getByRole('button', { name: 'Save and activate' }).isDisabled(), true);
          await slack.getByRole('button', { name: 'Not now', exact: true }).and(slack.locator(':enabled')).waitFor();
          assert.doesNotMatch(
            await slack.innerText(),
            new RegExp(destinationId),
            'technical identifiers stay out of the compact review',
          );
          slackFailure = 0;
          await slack.getByRole('button', { name: 'Check Slack destination' }).click();
          if (mobile) await openDraft(slack, slackDefinition.name);
          await slackStep.getByText('#tech', { exact: true }).first().waitFor();
          await returnToChat();
          await slack.getByRole('button', { name: 'Save and activate' }).and(slack.locator(':enabled')).waitFor();

          if (!mobile) await canvas.getByRole('button', { name: 'Close canvas', exact: true }).click();
          const composer = page.getByRole('textbox', { name: 'Message', exact: true });
          await composer.pressSequentially('Keep ');
          await composer.press('ControlOrMeta+i');
          await composer.pressSequentially('typed');
          await composer.press('ControlOrMeta+i');
          await composer.pressSequentially(' details.');
          assert.equal(await composer.locator('em').textContent(), 'typed');
          await page.getByRole('button', { name: /^Show canvas/ }).click();
          await openDraft(webhook, webhookDefinition.name);
          await webhookViewer.getByRole('button', { name: 'Edit in chat', exact: true }).click();
          await composer
            .getByText(
              `Help me revise workflow draft ${webhookDraft} in this chat. Ask what I want to change, keep unrelated steps, and prepare a fresh draft for review.`,
              { exact: true },
            )
            .waitFor();
          assert.equal(new URL(page.url()).pathname, `/${workspace.slug}/chat/${chatId}`);
          assert.equal(
            await composer.locator('em').textContent(),
            'typed',
            'draft handoff preserves rich nodes already typed in this chat',
          );
          assert.match(await composer.innerText(), /Keep typed details\./);
          assert.doesNotMatch(await composer.innerText(), /saved revision/);
          assert.deepEqual(
            sendRequests,
            [],
            'Edit in chat stages a request without sending it or creating another chat',
          );
          if (mobile) {
            await canvas.waitFor({ state: 'hidden' });
            assert.equal(
              await composer.evaluate(
                element => element === document.activeElement || element.contains(document.activeElement),
              ),
              true,
            );
            await page.getByRole('button', { name: /^Show canvas/ }).click();
          }
          while (await canvas.getByRole('button', { name: 'Close Workflow draft', exact: true }).count())
            await canvas.getByRole('button', { name: 'Close Workflow draft', exact: true }).first().click();
          assert.equal(await canvas.locator('.workflow-viewer').count(), 0);
          await slack.getByRole('button', { name: 'Save and activate' }).and(slack.locator(':enabled')).waitFor();
          slackFailure = 403;
          await slack.getByRole('button', { name: 'Check Slack destination' }).click();
          await slack.getByText('Checking the exact Slack channel...', { exact: true }).waitFor();
          assert.equal(await slack.getByRole('button', { name: 'Save and activate' }).isDisabled(), true);
          await slack
            .getByText('Check this Slack destination before saving. The channel is not verified.', { exact: true })
            .waitFor();
          await openDraft(slack, slackDefinition.name);
          slackStep = await assertConfiguration(slackViewer, 1, slackDefinition.steps[0]);
          await slackStep.getByText('Destination unavailable', { exact: true }).first().waitFor();
          assert.equal(
            await slackViewer.getByText('#tech', { exact: true }).count(),
            0,
            'revoked Slack labels are concealed',
          );
          await canvas.getByRole('button', { name: 'Close Workflow draft', exact: true }).click();
          slackFailure = 0;
          await slack.getByRole('button', { name: 'Check Slack destination' }).click();
          await slack.getByRole('button', { name: 'Save and activate' }).and(slack.locator(':enabled')).waitFor();
          assert.equal(
            await canvas.locator('.workflow-viewer').count(),
            0,
            'readiness recovers without mounting a workflow diagram',
          );
          if (shots)
            await slack.screenshot({
              path: `${shots}/workflow-slack-review-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
            });
          if (shots)
            await page.screenshot({
              path: `${shots}/workflow-draft-cards-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
              fullPage: true,
            });
          if (shots)
            await webhook.screenshot({
              path: `${shots}/workflow-webhook-card-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
            });
          if (shots)
            await record.screenshot({
              path: `${shots}/workflow-record-card-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
            });
          await created.getByRole('button', { name: 'Save and activate' }).click();
          await created
            .getByText('The outcome is uncertain. Retry the exact decision without creating another save.', {
              exact: true,
            })
            .waitFor();
          assert.equal(await created.getByRole('button', { name: 'Save and activate' }).isDisabled(), true);
          await created.getByRole('button', { name: 'Retry same decision', exact: true }).click();
          await created
            .getByText('Workflow active. Next run Monday, October 12, 2026 at 9:00 AM EDT.', { exact: true })
            .waitFor();
          assert.equal(decisions.length, 2);
          assert.deepEqual(
            decisions[1],
            decisions[0],
            'uncertain transport retries exactly the same command and digest',
          );
          assert.equal(decisions[0].id, saveDraft);
          assert.deepEqual(Object.keys(decisions[0].body).sort(), ['commandId', 'decision', 'digest']);
          assert.deepEqual(
            { digest: decisions[0].body.digest, decision: decisions[0].body.decision },
            { digest: 'd'.repeat(64), decision: 'save' },
          );
          assert.equal(
            await created.getByRole('button', { name: 'Save and activate' }).count(),
            0,
            'a settled card offers no second approval',
          );
          await slack.getByRole('button', { name: 'Save and activate' }).click();
          await slack.getByText(/Workflow active/).waitFor();
          assert.equal(decisions[2].id, slackDraft);
          assert.deepEqual(
            { digest: decisions[2].body.digest, decision: decisions[2].body.decision },
            { digest: 'c'.repeat(64), decision: 'save' },
          );
          assert.deepEqual(definitionReads, [], 'draft viewing never substitutes a saved-definition read');
          await created.getByRole('button', { name: definition.name, exact: true }).click();
          // Cloud 51d9a255 (#1053) names the result card region and gives it a plain View workflow action (workflow-canvas.tsx:48).
          await created
            .getByRole('region', { name: 'Workflow: View saved workflow', exact: true })
            .getByRole('button', { name: 'View workflow', exact: true })
            .click();
          await createdViewer.getByText('Saved and active revision', { exact: true }).waitFor();
          await assertConfiguration(createdViewer, 0, definition.trigger);
          assert.ok(definitionReads.length > 0);
          assert.deepEqual([...new Set(definitionReads)], [saveDraft]);
          assert.deepEqual(sendRequests, []);
          assert.ok(reads.includes(disableDraft));
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          assert.deepEqual(errors, []);
        } catch (error) {
          await page.screenshot({ path: `/tmp/workflow-draft-failure-${mobile ? 'mobile' : 'desktop'}.png` });
          console.error(await page.locator('body').ariaSnapshot());
          throw error;
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
