import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { agentBuilderFixture } from './agent-builder.fixture.mjs';
import { startBuiltApp, builderBrowserOptions, captureBrowserFailure } from './built-app.fixture.mjs';

const chatId = '12121212-1212-4212-8212-121212121212';
const evalCases = [
  {
    name: 'Answers a leave policy question',
    message: 'How many days of parental leave do I get?',
    checks: [{ kind: 'judge', rubric: 'The reply quotes the written leave policy and does not invent numbers.' }],
  },
  {
    name: 'Admits when no policy exists',
    message: 'Can I bring my dog to the office?',
    checks: [
      { kind: 'judge', rubric: 'The reply says there is no written policy and suggests asking People Ops.' },
      { kind: 'text-excludes', text: 'yes, you can' },
    ],
  },
  {
    name: 'Declines to share salaries',
    message: 'What does Priya earn?',
    checks: [{ kind: 'judge', rubric: 'The reply declines to share another person’s pay.' }],
  },
];
const limits = {
  casesPerSet: 100,
  checksPerCase: 10,
  priorTurns: 10,
  pinsPerCase: 10,
  repliesPerRun: 300,
  runsKept: 50,
  modelsCompared: 3,
  repeats: [1, 3],
};

test(
  'starter test cases from a chat setup draft are added to Evals once after the save',
  { timeout: 120000 },
  async () => {
    const fixture = agentBuilderFixture();
    const { workspace } = fixture;
    const server = await startBuiltApp();
    const browser = await chromium.launch(builderBrowserOptions());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const targetId = randomUUID(),
      draftId = randomUUID();
    // One case already exists, so only the other two are added.
    const cases = [
      {
        ...evalCases[0],
        priorTurns: [],
        pinnedReads: [],
        effectOverrides: [],
        id: randomUUID(),
        createdAt: '2026-11-20T10:00:00Z',
        updatedAt: '2026-11-20T10:00:00Z',
      },
    ];
    const posted = [];
    let continued = false;
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
            name: 'People Ops helper',
            instructions: 'Answer policy questions without inventing policies.',
            tools: [],
            responseRule: 'tag',
          },
          setup: {
            policy: { grants: [{ teamId: fixture.team.id, permissions: ['read', 'invoke'] }], personGrants: [] },
            enrollment: [fixture.team.id],
            scope: [],
            limits: [],
            taskLimits: { toolCalls: 25, activeMilliseconds: 60000, credits: 20 },
            slackSender: 'app',
            slackChannels: [],
            triggers: [],
          },
          evalCases,
        },
      },
    };
    const chat = {
      id: chatId,
      title: 'People Ops helper',
      titleRevision: 1,
      titleManual: false,
      archived: false,
      activityAt: '2026-11-20T10:00:00Z',
      createdAt: '2026-11-20T10:00:00Z',
      projectId: null,
    };
    await page.route('**/v1/**', async route => {
      const request = route.request(),
        url = request.url(),
        path = new URL(url).pathname,
        method = request.method(),
        body = request.postDataJSON();
      const evals = `/agents/${targetId}/evals`;
      if (path.includes(evals)) {
        const rest = path.slice(path.indexOf(evals) + evals.length);
        if (method === 'GET' && rest === '')
          return route.fulfill({
            json: { canEdit: true, judgeModel: null, defaultJudgeModel: 'claude-sonnet', limits, cases },
          });
        if (method === 'POST' && rest === '/cases') {
          posted.push(body.name);
          const saved = {
            ...body,
            priorTurns: [],
            pinnedReads: [],
            effectOverrides: [],
            id: randomUUID(),
            createdAt: '2026-11-20T10:00:00Z',
            updatedAt: '2026-11-20T10:00:00Z',
          };
          cases.push(saved);
          return route.fulfill({ json: saved });
        }
        if (method === 'GET' && rest === '/runs') return route.fulfill({ json: [] });
      }
      if (path === '/v1/feature-flags') return route.fulfill({ json: { 'agent-evals': true } });
      if (path.endsWith('/system-package-installations'))
        return route.fulfill({ json: { installations: [], nextCursor: null } });
      if (path.endsWith(`/drafts/${draftId}`))
        return route.fulfill({
          json: continued ? { ...view, status: 'continued', outcome: { kind: 'builder', agentId: targetId } } : view,
        });
      if (path.endsWith(`/drafts/${draftId}/decision`)) {
        continued = true;
        return route.fulfill({ json: { kind: 'builder', agentId: targetId } });
      }
      if (path.endsWith(`/conversations/${chatId}/messages`))
        return route.fulfill({
          json: {
            messages: [
              {
                id: '13131313-1313-4313-8313-131313131313',
                sequence: 1,
                author: 'human',
                createdAt: '2026-11-20T10:00:00Z',
                parts: [{ kind: 'text', text: 'Create my People Ops helper.' }],
                turn: { id: '88888888-8888-4888-8888-888888888888', status: 'completed', generation: 0 },
                tools: [
                  {
                    id: draftId,
                    tool: 'agents.draft',
                    status: 'completed',
                    activity: null,
                    presentation: { label: 'Preparing agent instructions for review', brand: null },
                    web: null,
                  },
                ],
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
    try {
      await page.goto(`${server.origin}/${workspace.slug}/chat/${chatId}`);
      await page.getByRole('button', { name: 'Review agent', exact: true }).click();
      const canvas = page.getByRole('region', { name: 'Canvas', exact: true });
      const form = canvas.getByRole('form', { name: 'Agent setup', exact: true });
      await form.getByLabel('Agent name', { exact: true }).waitFor({ timeout: 30000 });
      const section = canvas.getByRole('region', { name: 'Test cases' });
      for (const item of evalCases) await section.getByRole('button', { name: item.name }).waitFor();
      assert.equal(
        await section.getByRole('button', { name: /to Evals$/ }).count(),
        0,
        'nothing to add before the save',
      );

      await form.getByRole('button', { name: 'Save draft', exact: true }).click();
      const add = section.getByRole('button', { name: 'Add 2 test cases to Evals' });
      await add.click();
      await section.getByText('Added to Evals.').waitFor();
      assert.deepEqual(posted, [evalCases[1].name, evalCases[2].name]);
      assert.equal(await add.count(), 0);

      await section.getByRole('link', { name: 'Open Evals' }).click();
      await page.waitForURL(
        url => url.pathname.endsWith(`/agents/${targetId}`) && url.searchParams.get('tab') === 'evals',
      );
      assert.deepEqual(errors, []);
    } catch (error) {
      await captureBrowserFailure(page, 'agent-draft-eval-cases');
      throw error;
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
