import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { catalogFixture } from '../src/features/models/catalog-fixture.ts';
import { membership, credits } from './chat-query.fixture.mjs';

const port = Number(process.env.AGENT_EVALS_BROWSER_PORT ?? 5291);
const origin = `http://127.0.0.1:${port}`;
const id = '33333333-3333-4333-8333-333333333333';
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Acme',
  slug: 'acme',
  status: 'ready',
  createdAt: '2026-10-12T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
const definition = { name: 'Support triage', instructions: 'Label each message.', tools: [], responseRule: 'tag' };
const detail = {
  id,
  name: definition.name,
  definition,
  owningTeamId: null,
  savedRevision: 'a'.repeat(40),
  definitionRevision: 'b'.repeat(64),
  capabilities: ['read', 'edit', 'invoke', 'manage'],
  activations: [{ id: randomUUID(), revision: 'b'.repeat(64), scope: [] }],
  replacedActivations: [],
};
const policy = {
  version: 1,
  owningTeamId: null,
  grants: [],
  personGrants: [],
  enrollment: [],
  enabled: true,
  limits: [],
  taskLimits: { toolCalls: 25, activeMilliseconds: 60000, credits: 20 },
  slackSender: 'user',
};
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
const usage = (picoUsd = 0) => ({ requests: 1, inputTokens: 100, outputTokens: 20, picoUsd });

function finishedRun(run, cases) {
  const results = run.models.flatMap(model =>
    cases.map(item => {
      const pass = model === 'claude-sonnet';
      return {
        caseId: item.id,
        caseName: item.name,
        model,
        repeat: 0,
        pass,
        verdicts: item.checks.map(check => ({ check, pass, reason: pass ? 'Says billing.' : 'Says question.' })),
        transcript: { text: pass ? 'Billing: charged twice.' : 'Question: a refund.', status: 'completed', calls: [] },
        error: null,
        agentUsage: usage(),
        judgeUsage: usage(),
        durationMs: 1000,
      };
    }),
  );
  return {
    ...run,
    status: 'completed',
    agentCredits: 0.4,
    judgeCredits: 0.2,
    summary: run.models.map(model => ({
      model,
      passed: results.filter(result => result.model === model && result.pass).length,
      total: cases.length,
      picoUsd: 0,
      durationMs: 1000,
      credits: 0.2,
    })),
    finishedAt: '2026-11-20T10:00:09Z',
    results,
  };
}

test('agent evals in the real app', { timeout: 240_000 }, async t => {
  const vite = spawn(
    process.execPath,
    [
      new URL('../node_modules/vite/bin/vite.js', import.meta.url).pathname,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: new URL('..', import.meta.url), stdio: 'ignore' },
  );
  let browser;
  try {
    for (let attempt = 0; ; attempt++) {
      if (vite.exitCode !== null) throw new Error('Vite exited before it became ready');
      try {
        if ((await fetch(origin)).ok) break;
      } catch {}
      if (attempt === 100) throw new Error('Vite did not start');
      await delay(100);
    }
    browser = await chromium.launch();
    let activeContext;
    async function open({ tab }) {
      await activeContext?.close();
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      activeContext = context;
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      const state = { cases: [], runs: [], writes: [] };
      const evals = `/agents/${id}/evals`;
      await page.route('**/v1/**', async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const method = request.method();
        let json;
        let status = 200;
        if (path.includes(evals)) {
          const rest = path.slice(path.indexOf(evals) + evals.length);
          if (method === 'GET' && rest === '')
            json = { canEdit: true, judgeModel: null, defaultJudgeModel: 'claude-sonnet', limits, cases: state.cases };
          else if (method === 'POST' && rest === '/cases') {
            const input = request.postDataJSON();
            state.writes.push({ kind: 'case', input });
            const saved = {
              ...input,
              priorTurns: input.priorTurns ?? [],
              pinnedReads: input.pinnedReads ?? [],
              effectOverrides: input.effectOverrides ?? [],
              id: randomUUID(),
              createdAt: '2026-11-20T10:00:00Z',
              updatedAt: '2026-11-20T10:00:00Z',
            };
            state.cases.push(saved);
            json = saved;
          } else if (method === 'POST' && rest === '/estimate') {
            const input = request.postDataJSON();
            const models = input.models ?? ['claude-sonnet'];
            json = { replies: models.length * state.cases.length, models, judgeModel: 'claude-sonnet', credits: 1.5 };
          } else if (method === 'POST' && rest === '/runs') {
            const input = request.postDataJSON();
            state.writes.push({ kind: 'run', input });
            const run = {
              id: randomUUID(),
              startedBy: membership.membershipId,
              status: 'queued',
              stopReason: null,
              models: input.models ?? ['claude-sonnet'],
              judgeModel: 'claude-sonnet',
              repeats: input.repeats ?? 1,
              caseCount: state.cases.length,
              estimateCredits: 1.5,
              agentCredits: 0,
              judgeCredits: 0,
              summary: [],
              agentChanged: false,
              createdAt: '2026-11-20T10:00:00Z',
              finishedAt: null,
            };
            state.runs.unshift(finishedRun(run, state.cases));
            json = run;
          } else if (method === 'GET' && rest === '/runs')
            json = state.runs.map(({ results: _results, ...run }) => run);
          else if (method === 'GET' && rest.startsWith('/runs/'))
            json = state.runs.find(run => run.id === rest.split('/')[2]);
          else {
            status = 404;
            json = { error: 'not-found' };
          }
        } else if (path.endsWith('/auth/get-session'))
          json = {
            session: { id: 'demo', userId: 'owner' },
            user: { id: 'owner', name: 'Demo author', email: 'owner@example.test' },
          };
        else if (path === '/v1/workspaces') json = [workspace];
        else if (path === '/v1/workspaces/acme') json = workspace;
        else if (path.endsWith('/governance/me')) json = membership;
        else if (path.endsWith('/authoring-context'))
          json = { currentSoulRevision: detail.savedRevision, teams: [], builtinSkills: [] };
        else if (path.endsWith(`/agents/${id}`)) json = detail;
        else if (path.endsWith(`/agents/${id}/policy`)) json = policy;
        else if (path.endsWith('/model-catalog')) json = catalogFixture();
        else if (path.endsWith('/skills')) json = { workspace: [], nextCursor: null };
        else if (path.endsWith('/agents')) json = { agents: [detail], nextCursor: null };
        else if (path.endsWith('/tables')) json = { tables: [], nextCursor: null };
        else if (path.endsWith('/sharing-candidates'))
          json = { membershipId: membership.membershipId, people: [], teams: [] };
        else if (path.endsWith('/workspace-mcp/capabilities')) json = { enabled: false };
        else if (path.endsWith('/credits')) json = credits;
        else if (path.endsWith('/feature-flags')) json = {};
        else if (path.endsWith('/bud'))
          json = {
            conversationId: null,
            onboarding: 'ineligible',
            bubblesEnabled: false,
            snoozedUntil: null,
            nudge: null,
            preferences: [],
          };
        else {
          status = 404;
          json = { error: 'unavailable' };
        }
        await route.fulfill({ status, json });
      });
      await page.goto(`${origin}/acme/agents/${id}?tab=${tab}`);
      await page.getByRole('tab', { name: 'Overview', exact: true }).waitFor();
      return { page, errors, state };
    }

    await t.test('add a case, compare two models, then use the cheaper one', async () => {
      const { page, errors, state } = await open({ tab: 'evals' });
      const cases = page.getByRole('region', { name: 'Eval cases' });
      await cases.getByRole('button', { name: 'Add case', exact: true }).click();
      const editor = page.getByRole('dialog', { name: 'New eval case' });
      await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Refund request is billing');
      await editor.getByRole('textbox', { name: 'Message', exact: true }).fill('I was charged twice in March.');
      await editor.getByRole('textbox', { name: 'Rubric', exact: true }).fill('The reply labels it billing.');
      await editor.getByRole('button', { name: 'Save case', exact: true }).click();
      await cases.getByText('Refund request is billing', { exact: true }).waitFor();
      assert.deepEqual(state.writes[0].input.checks, [{ kind: 'judge', rubric: 'The reply labels it billing.' }]);
      assert.equal(state.writes[0].input.message, 'I was charged twice in March.');

      await cases.getByRole('button', { name: 'Run evals', exact: true }).click();
      const run = page.getByRole('dialog', { name: 'Run evals' });
      await run.getByRole('checkbox', { name: 'Claude Sonnet 5', exact: true }).check();
      await run.getByRole('checkbox', { name: 'Claude Haiku 4.5', exact: true }).check();
      await run.getByRole('button', { name: /^Run for about/ }).click();
      const results = page.getByRole('dialog', { name: 'Eval results' });
      await results.getByText('1/1 passed', { exact: true }).waitFor();
      assert.deepEqual(state.writes[1].input.models, ['claude-sonnet', 'claude-haiku']);
      await results.getByText('0/1 passed', { exact: true }).first().waitFor();

      await results.getByRole('button', { name: 'Use this model' }).nth(1).click();
      await page.waitForURL(/tab=instructions/);
      await page.getByRole('region', { name: 'Agent editor' }).getByText('Claude Haiku 4.5').first().waitFor();
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser?.close();
    vite.kill();
  }
});
