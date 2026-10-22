import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { chatStatusSchema, retryModelSchema } from '@tulipfarm/agents/chat-contracts';
import { membership, credits } from './chat-query.fixture.mjs';

test(
  'saved-agent model attribution and retry in Chromium with controlled API responses',
  { timeout: 120000 },
  async t => {
    const port = Number(process.env.MODEL_RETRY_BROWSER_PORT ?? 5299);
    const origin = `http://127.0.0.1:${port}`;
    const vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: new URL('..', import.meta.url),
      stdio: 'ignore',
    });
    let browser;
    try {
      for (let i = 0; ; i++) {
        if (
          await fetch(origin).then(
            response => response.ok,
            () => false,
          )
        )
          break;
        assert.ok(i < 150 && vite.exitCode === null, 'Vite must start');
        await delay(100);
      }
      browser = await chromium.launch();
      async function scenario(name, run, options = {}) {
        await t.test(name, async () => {
          const context = await browser.newContext(options);
          const page = await context.newPage();
          page.setDefaultTimeout(10000);
          page.setDefaultNavigationTimeout(60000);
          const errors = [];
          page.on('pageerror', error => errors.push(String(error)));
          const workspace = {
            id: randomUUID(),
            slug: 'model-proof',
            name: 'Model proof',
            status: 'ready',
            createdAt: '2026-09-29T00:00:00.000Z',
            soulCommit: 'a'.repeat(40),
          };
          const agentId = randomUUID(),
            turnId = randomUUID(),
            teamId = randomUUID(),
            activationId = randomUUID();
          const preferred = {
            familyId: 'claude-opus',
            modelId: 'opus-before',
            route: { id: 'primary-route', provider: 'anthropic' },
          };
          const attempt = {
            id: randomUUID(),
            ordinal: 1,
            role: 'primary',
            status: 'abandoned',
            resolution: preferred,
            usage: { kind: 'unknown', reason: 'abandoned' },
            cost: { kind: 'unknown' },
            outcome: { kind: 'failure', reason: 'abandoned', actualModel: null },
          };
          const state = {
            turn: {
              id: turnId,
              revision: 'b'.repeat(64),
              status: 'failed',
              text: null,
              call: null,
              execution: null,
              model: {
                generation: 0,
                status: 'failed',
                failure: 'attempts-exhausted',
                deadline: '2026-09-29T01:00:00.000Z',
                winner: null,
                bundleId: 'before',
                activationRevision: 1,
                preferred,
                attempts: [attempt],
              },
            },
            writes: [],
            reads: 0,
            mode: 'success',
            readStatus: 200,
            gate: null,
          };
          const url = `${origin}/${workspace.slug}/agents/${agentId}#agent-turn=${turnId}`;
          function answer() {
            const winner = {
              ...attempt,
              id: randomUUID(),
              status: 'succeeded',
              outcome: { kind: 'success', actualModel: 'reported-opus' },
              usage: { kind: 'unknown', reason: 'missing' },
            };
            state.turn = {
              ...state.turn,
              status: 'answered',
              text: 'Recovered answer.',
              model: {
                ...state.turn.model,
                generation: 1,
                status: 'committed',
                failure: null,
                winner: winner.id,
                attempts: [winner],
              },
            };
          }
          await page.route('**/v1/**', async route => {
            const request = route.request(),
              path = new URL(request.url()).pathname;
            let json,
              status = 200;
            if (request.method() === 'OPTIONS') {
              await route.fulfill({ status: 204 });
              return;
            }
            if (path === '/v1/auth/get-session')
              json = {
                session: { id: 'session', userId: 'editor' },
                user: { id: 'editor', name: 'Editor', email: 'editor@example.com' },
              };
            else if (path === '/v1/workspaces') json = [workspace];
            else if (path === '/v1/workspaces/model-proof') json = workspace;
            else if (path.endsWith('/governance/me')) json = membership;
            else if (path.endsWith('/credits')) json = credits;
            else if (path.endsWith('/agents/authoring-context'))
              json = { currentSoulRevision: workspace.soulCommit, teams: [{ id: teamId, name: 'Team' }], admin: false };
            else if (path.endsWith(`/agents/${agentId}`))
              json = {
                id: agentId,
                name: 'Assistant',
                owningTeamId: teamId,
                savedRevision: workspace.soulCommit,
                definitionRevision: 'b'.repeat(64),
                definition: { name: 'Assistant', instructions: 'Answer.', tools: [], modelFamilyId: 'claude-opus' },
                capabilities: ['read', 'invoke'],
                admin: false,
                activations: [{ id: activationId, revision: 'b'.repeat(64), scope: [] }],
              };
            else if (path.endsWith('/chat')) json = { configured: true };
            else if (path.endsWith(`/chat/${turnId}/retry`)) {
              const command = retryModelSchema.parse(request.postDataJSON());
              state.writes.push(command);
              await state.gate?.promise;
              if (state.mode === 'deny') {
                status = 404;
                json = { error: 'not-found' };
              } else if (state.mode === 'conflict') {
                status = 409;
                json = { error: 'model-retry-conflict' };
              } else {
                if (state.mode !== 'lose-uncommitted') answer();
                if (state.mode.startsWith('lose-')) {
                  await route.abort('failed');
                  return;
                }
                json = { requestId: command.requestId, runId: turnId, generation: 1 };
              }
            } else if (path.endsWith(`/chat/${turnId}`)) {
              state.reads++;
              status = state.readStatus;
              json = status === 200 ? chatStatusSchema.parse(state.turn) : { error: 'not-found' };
            } else {
              status = 404;
              json = { error: 'unavailable' };
            }
            await route.fulfill({ status, json });
          });
          try {
            await page.goto(url);
            await page.getByRole('button', { name: 'Single-step request', exact: true }).click();
            await page.getByRole('button', { name: 'Retry model step', exact: true }).waitFor();
            await run({ page, state, answer, url });
            assert.deepEqual(errors, []);
          } finally {
            await context.close();
          }
        });
      }
      await scenario(
        'agent tool activity distinguishes running, waiting and completed calls',
        async ({ page, state }) => {
          state.turn.call = { tool: 'google.read', operation: { kind: 'gmail.messages.list' } };
          state.turn.presentation = { label: 'Searching Gmail messages', brand: 'gmail' };
          state.turn.status = 'tool';
          state.turn.execution = { status: 'waiting', result: null };
          state.turn.activityStatus = 'running';
          await page.getByRole('button', { name: 'Check request status', exact: true }).click();
          const activity = page.locator('[data-slot="tool-activity"]');
          await activity.getByText('Searching Gmail messages', { exact: true }).waitFor();
          // Sprout ToolActivity shows one spinner on its collapsed trigger while working (tool-activity.js), as on cloud.
          assert.equal(await activity.locator('[data-slot="spinner"]').count(), 1);
          state.turn.activityStatus = 'waiting';
          // Cloud cd207363 (#983) states each row's status as screen-reader text and counts waiting tools in the trigger (tool-activity.tsx:154,170).
          await activity.getByRole('button', { name: '1 tool waiting', exact: true }).waitFor();
          await activity
            .getByRole('listitem')
            .filter({ hasText: 'Searching Gmail messages' })
            .getByText('Waiting', { exact: true })
            .waitFor();
          assert.equal(await activity.locator('[data-slot="spinner"]').count(), 0);
          state.turn.execution = { status: 'completed', result: null };
          state.turn.activityStatus = 'completed';
          await activity.getByRole('button', { name: 'Used 1 tool', exact: true }).waitFor();
          assert.equal(await activity.getByRole('button').getAttribute('aria-expanded'), 'false');
        },
      );
      await scenario(
        'interrupted attempt, unknown usage, repeated click and successful retry',
        async ({ page, state }) => {
          await page
            .getByText('Preferred family claude-opus. Version opus-before. Provider anthropic.', { exact: true })
            .waitFor();
          await page.getByText('Usage unknown (abandoned). This does not mean zero usage.', { exact: true }).waitFor();
          state.gate = Promise.withResolvers();
          await page.getByRole('button', { name: 'Retry model step', exact: true }).evaluate(button => {
            button.click();
            button.click();
          });
          await page.getByRole('button', { name: 'Retrying model step…', exact: true }).waitFor();
          assert.equal(state.writes.length, 1);
          assert.equal(state.writes[0].expectedGeneration, 0);
          state.gate.resolve();
          await page.getByText('Recovered answer.', { exact: true }).waitFor();
          await page
            .getByText(
              'Actual family claude-opus. Version opus-before. Provider anthropic. Reported model reported-opus.',
              { exact: true },
            )
            .waitFor();
          assert.equal(await page.getByRole('button', { name: 'Retry model step', exact: true }).count(), 0);
        },
      );
      await scenario(
        'lost uncommitted response survives reload and repeats the exact command',
        async ({ page, state }) => {
          state.mode = 'lose-uncommitted';
          await page.getByRole('button', { name: 'Retry model step', exact: true }).click();
          await page.getByRole('button', { name: 'Repeat same retry' }).waitFor();
          const command = state.writes[0];
          await page.reload();
          await page.getByRole('button', { name: 'Single-step request', exact: true }).click();
          await page.getByRole('button', { name: 'Repeat same retry' }).waitFor();
          await page.getByRole('button', { name: 'Check request status' }).click();
          await delay(250);
          assert.equal(state.writes.length, 1);
          state.mode = 'success';
          await page.getByRole('button', { name: 'Repeat same retry' }).click();
          await page.getByText('Recovered answer.', { exact: true }).waitFor();
          assert.deepEqual(state.writes, [command, command]);
        },
      );
      await scenario(
        'lost committed response reconciles by GET without repeating the write',
        async ({ page, state }) => {
          state.mode = 'lose-committed';
          await page.getByRole('button', { name: 'Retry model step', exact: true }).click();
          await page.getByRole('button', { name: 'Repeat same retry' }).waitFor();
          await page.getByRole('button', { name: 'Check request status' }).click();
          await page.getByText('Recovered answer.', { exact: true }).waitFor();
          await page.getByRole('button', { name: 'Reload request status' }).click();
          assert.equal(state.writes.length, 1);
        },
      );
      await scenario('stale generation requires deliberate reload', async ({ page, state, answer }) => {
        state.mode = 'conflict';
        await page.getByRole('button', { name: 'Retry model step', exact: true }).click();
        await page.getByRole('button', { name: 'Reload request status' }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Retry model step', exact: true }).count(), 0);
        answer();
        await page.getByRole('button', { name: 'Reload request status' }).click();
        await page.getByText('Recovered answer.', { exact: true }).waitFor();
        assert.equal(state.writes.length, 1);
      });
      await scenario('stale failed generation reload permits a deliberate new retry only', async ({ page, state }) => {
        state.mode = 'conflict';
        await page.getByRole('button', { name: 'Retry model step', exact: true }).click();
        await page.getByRole('button', { name: 'Reload request status' }).waitFor();
        const original = state.writes[0];
        state.turn.model.generation = 1;
        await page.getByRole('button', { name: 'Reload request status' }).click();
        await page.getByText('Generation 1. Provider usage is not a billing settlement.', { exact: true }).waitFor();
        assert.equal(state.writes.length, 1);
        await page.getByRole('button', { name: 'Retry model step', exact: true }).click();
        await page.getByRole('button', { name: 'Reload request status' }).waitFor();
        assert.equal(state.writes.length, 2);
        assert.equal(state.writes[1].expectedGeneration, 1);
        assert.notEqual(state.writes[1].requestId, original.requestId);
      });
      await scenario(
        'revoked retry permission hides all previously rendered model details',
        async ({ page, state }) => {
          state.mode = 'deny';
          await page.getByRole('button', { name: 'Retry model step', exact: true }).click();
          await page.getByText('Request unavailable', { exact: true }).waitFor();
          assert.equal(await page.getByRole('region', { name: 'Model attribution' }).count(), 0);
          state.readStatus = 404;
          await page.getByRole('button', { name: 'Reload and check access' }).click();
          await page.getByRole('button', { name: 'Single-step request', exact: true }).click();
          await page.getByText('Agent unavailable', { exact: true }).waitFor();
          assert.equal(state.writes.length, 1);
        },
      );
      await scenario('status refresh revocation clears cached receipt without a write', async ({ page, state }) => {
        state.readStatus = 404;
        await page.getByRole('button', { name: 'Check request status' }).click();
        await page.getByText('Agent unavailable', { exact: true }).waitFor();
        assert.equal(await page.getByRole('region', { name: 'Model attribution' }).count(), 0);
        assert.equal(state.writes.length, 0);
      });
      await scenario(
        'failed refresh retains attribution but disables retry until recovery',
        async ({ page, state }) => {
          state.readStatus = 503;
          await page.getByRole('button', { name: 'Check request status' }).click();
          await page.getByRole('alert').filter({ hasText: 'could not be completed' }).waitFor();
          assert.equal(await page.getByRole('button', { name: 'Retry model step', exact: true }).isDisabled(), true);
          await page
            .getByText('Preferred family claude-opus. Version opus-before. Provider anthropic.', { exact: true })
            .waitFor();
          state.readStatus = 200;
          await page.getByRole('button', { name: 'Check request status' }).click();
          await page.getByRole('alert').filter({ hasText: 'could not be completed' }).waitFor({ state: 'hidden' });
          await page.waitForFunction(() =>
            [...document.querySelectorAll('button')].some(
              button => button.textContent === 'Retry model step' && !button.disabled,
            ),
          );
          assert.equal(await page.getByRole('button', { name: 'Retry model step', exact: true }).isEnabled(), true);
          assert.equal(state.writes.length, 0);
        },
      );
      await scenario('no dispatched attempt still shows the historical preference', async ({ page, state }) => {
        state.turn.model.attempts = [];
        state.turn.model.failure = 'policy-revoked';
        await page.getByRole('button', { name: 'Check request status' }).click();
        await page.getByText('No provider attempt recorded. Usage unknown.', { exact: true }).waitFor();
        await page
          .getByText('Preferred family claude-opus. Version opus-before. Provider anthropic.', { exact: true })
          .waitFor();
        assert.equal(state.writes.length, 0);
      });
      await scenario(
        'fallback attribution and narrow dark reduced-motion layout',
        async ({ page, state, answer }) => {
          const primary = state.turn.model.attempts[0];
          answer();
          const fallback = {
            ...state.turn.model.attempts[0],
            ordinal: 3,
            role: 'fallback',
            resolution: {
              familyId: 'gpt-astra',
              modelId: 'astra-before',
              route: { id: 'fallback', provider: 'azure' },
            },
            outcome: { kind: 'success', actualModel: 'reported-astra' },
          };
          state.turn.model.attempts = [primary, fallback];
          await page.getByRole('button', { name: 'Check request status' }).click();
          await page
            .getByText(
              'Actual family gpt-astra. Version astra-before. Provider azure. Reported model reported-astra.',
              { exact: true },
            )
            .waitFor();
          await page.getByText(/Fallback reason. Primary attempts/).waitFor();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        },
        { viewport: { width: 390, height: 844 }, colorScheme: 'dark', reducedMotion: 'reduce' },
      );
    } finally {
      await browser?.close();
      vite.kill('SIGTERM');
    }
  },
);
