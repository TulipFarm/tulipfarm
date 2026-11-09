import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';
import { randomUUID } from 'node:crypto';
import { agentBuilderFixture } from './agent-builder.fixture.mjs';
import {
  startBuiltApp,
  builderBrowserOptions,
  captureBuilderScreenshot,
  captureBrowserFailure,
} from './built-app.fixture.mjs';

const chatId = '12121212-1212-4212-8212-121212121212';
const existingAgent = '33333333-3333-4333-8333-333333333333';
const team = '55555555-5555-4555-8555-555555555555';
const createDraft = '14141414-1414-4414-8414-141414141414';
const updateDraft = '15151515-1515-4515-8515-151515151515';
const tool = id => ({
  id,
  tool: 'agents.draft',
  status: 'completed',
  activity: null,
  presentation: { label: 'Preparing agent instructions for review', brand: null },
  web: null,
});
const view = (id, targetId, expectedSavedRevision, name, agentChange) => ({
  id,
  digest: 'd'.repeat(64),
  status: 'pending',
  outcome: null,
  agentChange,
  proposal: {
    kind: 'agent',
    targetId,
    input: {
      expectedSoulRevision: 'a'.repeat(40),
      expectedSavedRevision,
      owningTeamId: team,
      definition: { name, instructions: `${name} instructions.`, tools: ['rows.list', 'rows.update'] },
    },
  },
});
const drafts = {
  [createDraft]: view(createDraft, '66666666-6666-4666-8666-666666666666', null, 'qa-second-chat-helper', {
    kind: 'create',
  }),
  [updateDraft]: view(updateDraft, existingAgent, 'b'.repeat(40), 'qa-chat-created-helper', {
    kind: 'update',
    agentId: existingAgent,
    current: { name: 'qa-chat-created-helper', changedFields: ['instructions', 'tools'] },
  }),
};

test(
  'agent draft cards say whether Save creates a new agent or updates a named existing agent',
  { timeout: 120000 },
  async () => {
    const { workspace, session } = createWorkspaceFixture();
    const server = await startBuiltApp();
    const browser = await chromium.launch(builderBrowserOptions());
    const shots = process.env.AGENT_DRAFT_SCREENSHOTS;
    try {
      for (const mobile of [false, true]) {
        const context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
          hasTouch: mobile,
          isMobile: mobile,
          colorScheme: mobile ? 'dark' : 'light',
          reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const chat = {
          id: chatId,
          title: 'Agent drafts',
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
            parts: [{ kind: 'text', text: 'Draft a separate new agent, then change the first one.' }],
            turn: { id: '88888888-8888-4888-8888-888888888888', status: 'completed', generation: 0 },
            tools: [tool(createDraft), tool(updateDraft)],
            calendarResults: [],
          },
          {
            id: '17171717-1717-4717-8717-171717171717',
            sequence: 2,
            author: 'assistant',
            createdAt: '2026-10-08T10:00:02.000Z',
            parts: [{ kind: 'text', text: 'Review both drafts.' }],
            turn: null,
            tools: [],
            calendarResults: [],
          },
        ];
        await page.route('**/v1/**', async route => {
          const request = route.request();
          const path = new URL(request.url()).pathname;
          const method = request.method();
          if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
          if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
          if (path.endsWith('/last-used')) return route.fulfill({ json: {} });
          if (
            ['/slack/status', '/github/accounts', '/atlassian/accounts', '/bud', '/recommendations/events'].some(
              suffix => path.endsWith(suffix),
            )
          )
            return route.fulfill({ status: 404, json: { error: 'not-configured' } });
          if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
          if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
          if (path.endsWith('/governance/me')) return route.fulfill({ json: membership });
          if (path.endsWith('/credits')) return route.fulfill({ json: credits });
          if (path.endsWith('/model-catalog')) return route.fulfill({ json: chatCatalog });
          if (path.endsWith('/agents/authoring-context'))
            return route.fulfill({
              json: { currentSoulRevision: 'a'.repeat(40), teams: [{ id: team, name: 'Support' }], admin: false },
            });
          if (path.endsWith('/google-workspace/availability')) return route.fulfill({ json: { configured: false } });
          if (path.endsWith('/google-workspace')) return route.fulfill({ json: { status: 'disconnected' } });
          if (path.endsWith('/projects')) return route.fulfill({ json: [] });
          if (path.endsWith('/google-workspace/operations/proposals'))
            return route.fulfill({ json: { proposals: [], nextCursor: null } });
          if (path.endsWith('/workspace-mcp/capabilities'))
            return route.fulfill({ status: 404, json: { error: 'not-found' } });
          if (path.endsWith('/candidates')) return route.fulfill({ json: [] });
          if (path.endsWith('/conversations') && method === 'GET')
            return route.fulfill({ json: { chats: [chat], nextCursor: null } });
          const conversation = /\/conversations\/([\w-]+)(\/.*)?$/.exec(path);
          if (conversation) {
            const [, , rest = ''] = conversation;
            const draft = /^\/drafts\/([\w-]+)$/.exec(rest);
            if (method === 'GET' && draft && drafts[draft[1]]) return route.fulfill({ json: drafts[draft[1]] });
            if (method === 'GET' && rest === '/messages')
              return route.fulfill({ json: { messages: history, nextBefore: null, hasGitHubProposals: false } });
            if (method === 'GET' && !rest) return route.fulfill({ json: chat });
            if (method === 'GET') return route.fulfill({ json: [] });
          }
          if (path === '/v1/feature-flags') return route.fulfill({ json: {} });
          if (path.endsWith('/integrations')) return route.fulfill({ json: { integrations: [] } });
          if (path.endsWith('/github/accounts')) return route.fulfill({ json: { configured: true, accounts: [] } });
          if (path.endsWith(`/github/chats/${chatId}/selection`))
            return route.fulfill({ json: { accountId: null, generation: null, version: 0 } });
          if (path.endsWith(`/github/chats/${chatId}/batches`)) return route.fulfill({ json: { batches: [] } });
          if (path.endsWith('/system-package-installations'))
            return route.fulfill({ json: { installations: [], nextCursor: null } });
          if (path.endsWith('/governance')) return route.fulfill({ status: 404, json: { error: 'not-found' } });
          throw new Error(`Unexpected API request ${method} ${path}`);
        });

        try {
          await page.goto(`${server.origin}/${workspace.slug}/chat/${chatId}`);
          assert.equal(await page.getByRole('region', { name: 'Canvas', exact: true }).count(), 0);
          const links = page.getByRole('button', { name: 'Review agent', exact: true });
          await links.nth(1).waitFor();
          assert.equal(
            await page.getByRole('region', { name: 'Review agent draft' }).count(),
            0,
            'chat links to agent drafts instead of showing the full review',
          );
          await page.getByText('Draft · Waiting for your review', { exact: true }).nth(1).waitFor();
          const review = page.getByRole('region', { name: 'Review agent draft' });
          await links.nth(0).click();
          const created = review.filter({ hasText: 'qa-second-chat-helper' });
          await created.getByText('Creates a new agent', { exact: true }).waitFor();
          assert.equal(await review.count(), 1, 'the canvas shows only the opened draft');
          assert.equal(
            await created.getByText(/Updates existing agent|Existing agent/).count(),
            0,
            'a create card never names an existing agent',
          );
          await created
            .getByText(
              'Saving does not activate this agent. An agent manager must turn on execution and activate its exact saved revision separately.',
              { exact: true },
            )
            .waitFor();
          await created.getByText('Support', { exact: true }).waitFor();
          assert.deepEqual(
            await created
              .getByRole('list', { name: 'Actions this agent may take' })
              .getByRole('listitem')
              .allTextContents(),
            ['Find rows', 'Update rows'],
          );
          await created.getByText('1 action changes data.', { exact: true }).waitFor();
          assert.equal(
            await created.getByText(team, { exact: true }).isVisible(),
            false,
            'raw team IDs stay inside technical details',
          );
          assert.equal(
            await created.getByText('Agent ID', { exact: true }).count(),
            0,
            'a create card has no existing agent ID',
          );
          assert.equal(await page.getByText('A draft needs your review').count(), 0, 'the review is already in view');
          if (mobile) await page.getByRole('button', { name: 'Back to chat' }).first().click();
          await links.nth(1).click();
          const updated = review.filter({ hasText: 'qa-chat-created-helper instructions.' });
          await updated.getByText('Updates existing agent “qa-chat-created-helper”', { exact: true }).waitFor();
          await updated.getByText('Instructions, Tools', { exact: true }).waitFor();
          await updated
            .getByText(
              'Saving does not activate these changes. An agent manager must activate the exact saved revision separately.',
              { exact: true },
            )
            .waitFor();
          assert.equal(
            await updated.getByText(/turn on execution/).count(),
            0,
            'an update never claims the agent starts off',
          );
          await updated.getByRole('button', { name: 'Technical details' }).click();
          const technical = updated.getByRole('definition').filter({ hasText: existingAgent });
          await technical.waitFor();
          await updated.getByText('rows.list, rows.update', { exact: true }).waitFor();
          assert.equal(
            await updated.getByText('Creates a new agent').count(),
            0,
            'an update card never claims to create an agent',
          );
          if (shots)
            await page.screenshot({
              path: `${shots}/agent-draft-cards-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
              fullPage: true,
            });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          assert.deepEqual(errors, []);
        } catch (error) {
          await captureBrowserFailure(page, 'agent-draft-legacy');
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

test(
  'a chat setup draft opens the agent builder in the canvas, and saving there continues the draft in the builder',
  { timeout: 120000 },
  async () => {
    const fixture = agentBuilderFixture();
    const { workspace } = fixture;
    const server = await startBuiltApp();
    const browser = await chromium.launch(builderBrowserOptions());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    try {
      const targetId = randomUUID(),
        draftId = randomUUID(),
        triggerId = randomUUID();
      const decisions = [],
        errors = [];
      let deny = false,
        continued = false;
      page.on('pageerror', error => errors.push(error.message));
      const setup = {
        policy: { grants: [{ teamId: fixture.team.id, permissions: ['read', 'invoke'] }], personGrants: [] },
        enrollment: [fixture.team.id],
        scope: [],
        limits: [],
        taskLimits: { toolCalls: 25, activeMilliseconds: 60000, credits: 20 },
        slackSender: 'app',
        slackChannels: [{ channel: 'CPEOPLE', expectedVersion: 3, replaceAgentId: targetId, detach: true }],
        prompt: 'Prepare a weekly policy update.',
        runLimits: { toolCalls: 10, activeMilliseconds: 60000, credits: 10 },
        triggers: [
          { id: triggerId, trigger: { kind: 'cron', expression: '0 9 * * 1', timezone: 'Asia/Kolkata' } },
          { id: randomUUID(), trigger: { kind: 'event', name: 'policy_question' } },
        ],
      };
      const view = {
        id: draftId,
        digest: 'd'.repeat(64),
        status: 'pending',
        outcome: null,
        proposal: {
          kind: 'agent',
          targetId,
          input: {
            expectedSoulRevision: 'a'.repeat(40),
            expectedSavedRevision: null,
            expectedPolicyVersion: 0,
            expectedActivationIds: [],
            expectedWorkflowRevision: null,
            expectedWorkflowGeneration: null,
            owningTeamId: fixture.team.id,
            definition: {
              name: 'People Ops chat helper',
              instructions: 'Answer policy questions without inventing policies.',
              tools: [],
              responseRule: 'tag',
            },
            setup,
          },
        },
      };
      const chat = {
        id: chatId,
        title: 'People Ops setup',
        titleRevision: 1,
        titleManual: false,
        archived: false,
        activityAt: '2026-10-12T10:00:00Z',
        createdAt: '2026-10-12T10:00:00Z',
        projectId: null,
      };
      await page.route('**/v1/**', async route => {
        const request = route.request(),
          url = request.url(),
          path = new URL(url).pathname,
          method = request.method(),
          body = request.postDataJSON();
        if (path.endsWith(`/drafts/${draftId}`))
          return route.fulfill(
            deny
              ? { status: 403, json: { error: 'access-denied' } }
              : {
                  json: continued
                    ? { ...view, status: 'continued', outcome: { kind: 'builder', agentId: targetId } }
                    : view,
                },
          );
        if (path.endsWith(`/drafts/${draftId}/decision`)) {
          decisions.push(body);
          if (body.decision !== 'continue')
            return route.fulfill({ status: 409, json: { error: 'unexpected-chat-decision' } });
          continued = true;
          return route.fulfill({ json: { kind: 'builder', agentId: targetId } });
        }
        if (path.endsWith(`/conversations/${chatId}/messages`))
          return route.fulfill({
            json: {
              messages: [
                {
                  id: randomUUID(),
                  sequence: 1,
                  author: 'human',
                  createdAt: '2026-10-12T10:00:00Z',
                  parts: [{ kind: 'text', text: 'Create my People Ops helper.' }],
                  turn: { id: randomUUID(), status: 'completed', generation: 0 },
                  tools: [tool(draftId)],
                },
              ],
              nextBefore: null,
              hasGitHubProposals: false,
            },
          });
        if (path.endsWith(`/conversations/${chatId}`)) return route.fulfill({ json: chat });
        if (path.endsWith('/conversations')) return route.fulfill({ json: { chats: [chat], nextCursor: null } });
        return route.fulfill(fixture.respond(method, url, body));
      });
      await page.goto(`${server.origin}/${workspace.slug}/chat/${chatId}`);
      await page.getByRole('button', { name: 'Review agent', exact: true }).click();
      const canvas = page.getByRole('region', { name: 'Canvas', exact: true });
      const form = canvas.getByRole('form', { name: 'Agent setup', exact: true });
      await form.getByLabel('Agent name', { exact: true }).waitFor();
      assert.equal(
        await form.getByRole('textbox', { name: 'Instructions', exact: true }).inputValue(),
        view.proposal.input.definition.instructions,
      );
      assert.equal(await canvas.getByRole('region', { name: 'Review agent draft' }).count(), 0);
      assert.equal(
        await canvas.getByRole('tablist', { name: 'Agent setup sections' }).getByRole('tab').count(),
        5,
        'the canvas shows every setup step as a tab',
      );
      assert.equal(await canvas.getByRole('button', { name: 'View agent', exact: true }).count(), 0);
      await canvas.getByRole('tab', { name: /Triggers/ }).click();
      await canvas.getByText('Every Monday at 09:00 in Asia/Kolkata', { exact: true }).first().waitFor();
      await captureBuilderScreenshot(page, 'agent-builder-chat-canvas');
      await form.getByRole('button', { name: 'Save draft', exact: true }).click();
      await form
        .getByText('Draft saved. Slack channels and workflow triggers are not started.', { exact: true })
        .waitFor();
      assert.equal(new URL(page.url()).pathname, `/${workspace.slug}/chat/${chatId}`, 'saving keeps you in chat');
      const saved = fixture.setups.get(targetId).setup;
      assert.deepEqual(saved.policy, setup.policy);
      assert.deepEqual(saved.enrollment, setup.enrollment);
      assert.equal(saved.slackSender, 'app');
      assert.deepEqual(saved.slackChannels, setup.slackChannels);
      assert.deepEqual(saved.triggers, setup.triggers);
      assert.equal(saved.prompt, setup.prompt);
      assert.deepEqual(
        decisions.map(decision => decision.decision),
        ['continue'],
        'saving in the builder continues the chat draft instead of approving it',
      );
      await page.reload();
      await page.getByText('Continued in the agent builder', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Edit agent', exact: true }).click();
      await canvas
        .getByRole('form', { name: 'Agent setup', exact: true })
        .getByLabel('Agent name', { exact: true })
        .waitFor();
      assert.equal(
        await canvas.getByRole('textbox', { name: 'Instructions', exact: true }).inputValue(),
        view.proposal.input.definition.instructions,
        'reopening resumes the setup saved in the builder',
      );
      assert.equal(decisions.length, 1, 'reopening does not decide the chat draft again');
      deny = true;
      await page.goto(
        `${server.origin}/${workspace.slug}/agents/new?setupAgentId=${targetId}&chatId=${chatId}&draftId=${draftId}`,
      );
      await page.getByRole('heading', { name: /unavailable/i }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: 'Instructions', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } catch (error) {
      await captureBrowserFailure(page, 'agent-builder-chat');
      throw error;
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
