import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { planViewSchema } from '../../../packages/agents/src/plan-contracts.ts';
import { startBuiltApp } from './built-app.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

test(
  'Plan mode survives failed sends, Start preserves intent, and new plans open only once on desktop',
  { timeout: 120000 },
  async () => {
    const server = await startBuiltApp();
    const browser = await chromium.launch();
    try {
      const { workspace, session } = createWorkspaceFixture({ slug: 'planning-qa', name: 'Planning QA' });
      const chatId = randomUUID(),
        planId = randomUUID(),
        receiptId = randomUUID();
      const chat = {
        id: chatId,
        title: 'Alert triage',
        titleRevision: 1,
        archived: false,
        activityAt: workspace.createdAt,
        createdAt: workspace.createdAt,
      };
      const tasks = [
        { key: 'records', title: 'Store alert occurrences', criteria: ['Every occurrence is recorded'], dependsOn: [] },
        {
          key: 'verify',
          title: 'Verify first and repeat alerts',
          criteria: ['A repeat does not create another issue'],
          dependsOn: ['records'],
        },
      ].map((task, index) => ({
        ...task,
        id: randomUUID(),
        position: index,
        parent: null,
        kind: 'work',
        order: 'parallel',
        brief: '',
        state: index ? 'pending' : 'ready',
        reason: null,
        assignee: { kind: 'coordinator' },
        summary: null,
        waitingTaskId: null,
      }));
      const plan = planViewSchema.parse({
        id: planId,
        chatId,
        title: 'Alert triage plan',
        brief: 'Track each alert and avoid duplicate issues.',
        lifecycle: 'draft',
        version: 0,
        canControl: true,
        createdAt: workspace.createdAt,
        updatedAt: workspace.createdAt,
        pause: null,
        outcome: 'active',
        counts: {
          total: 2,
          pending: 1,
          ready: 1,
          running: 0,
          verifying: 0,
          'waiting-input': 0,
          'waiting-approval': 0,
          blocked: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
        },
        budget: { toolCalls: 300, activeMilliseconds: 1800000, credits: 300 },
        specialists: [],
        tasks,
        planning: {
          requirements: [{ key: 'dedup', description: 'Repeated alerts reuse their issue', tasks: ['records'] }],
          prerequisites: [],
          verificationTask: 'verify',
        },
      });
      let listed = [],
        failSend = true,
        failStart = true;
      const sends = [],
        starts = [],
        errors = [];
      const messages = [
        {
          id: randomUUID(),
          sequence: 1,
          author: 'human',
          createdAt: workspace.createdAt,
          parts: [{ kind: 'text', text: 'Prepare an alert triage plan.' }],
          turn: { id: randomUUID(), status: 'completed', generation: 0, mode: 'plan' },
          tools: [],
        },
      ];
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      await context.addInitScript(() => {
        window.planningSources = new Set();
        window.EventSource = class extends EventTarget {
          readyState = 1;
          constructor() {
            super();
            window.planningSources.add(this);
            queueMicrotask(() => this.dispatchEvent(new Event('open')));
          }
          close() {
            this.readyState = 2;
            window.planningSources.delete(this);
          }
        };
      });
      await context.route('**/v1/**', async route => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
        if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
        if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
        if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
        if (path.endsWith('/governance/me'))
          return route.fulfill({
            json: {
              membershipId: chatId,
              role: 'member',
              teams: [],
              capabilities: { manageGovernance: false, canLeave: true },
            },
          });
        if (path.endsWith('/model-catalog')) return route.fulfill({ json: chatCatalog });
        if (path.endsWith(`/conversations/${chatId}/plans`)) return route.fulfill({ json: { plans: listed } });
        if (path.endsWith(`/agent-plans/${planId}/control`)) {
          const input = request.postDataJSON();
          starts.push(input);
          if (failStart) {
            failStart = false;
            return route.abort();
          }
          plan.lifecycle = 'active';
          plan.version++;
          return route.fulfill({ json: { id: planId, version: plan.version, added: [], yielded: false } });
        }
        if (path.endsWith(`/agent-plans/${planId}`)) return route.fulfill({ json: plan });
        if (request.method() === 'PUT' && path.includes(`/conversations/${chatId}/messages/`)) {
          const input = request.postDataJSON();
          sends.push(input);
          if (failSend) {
            failSend = false;
            return route.abort();
          }
          const messageId = path.split('/').at(-1),
            turnId = randomUUID();
          messages.push({
            id: messageId,
            sequence: messages.length + 1,
            author: 'human',
            createdAt: workspace.createdAt,
            parts: input.parts,
            turn: { id: turnId, status: 'completed', generation: 0, mode: input.mode },
            tools: [],
          });
          return route.fulfill({ json: { messageId, turnId, sequence: messages.length } });
        }
        if (path.endsWith('/messages'))
          return route.fulfill({ json: { messages, nextBefore: null, hasGitHubProposals: false } });
        if (path.endsWith(`/conversations/${chatId}`)) return route.fulfill({ json: chat });
        return route.fulfill({ status: 404, json: { error: 'not-found' } });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(String(error)));
      const publish = () =>
        page.evaluate(planId => {
          for (const source of window.planningSources)
            source.dispatchEvent(new MessageEvent('changed', { data: JSON.stringify({ planId }) }));
        }, planId);
      const url = `${server.origin}/${workspace.slug}/chat/${chatId}`;
      await page.goto(url);
      await page.getByRole('textbox', { name: 'Message' }).waitFor();
      await page.getByRole('status', { name: 'Loading plans' }).waitFor({ state: 'detached' });
      await page.getByRole('combobox', { name: 'Chat mode' }).click();
      await page.getByRole('option', { name: 'Plan only' }).click();
      await page.getByRole('textbox', { name: 'Message' }).fill('Check access before making the plan.');
      await page.getByRole('button', { name: 'Send message' }).click();
      await page.getByRole('button', { name: 'Retry same operation' }).click();
      await page.getByRole('button', { name: 'Retry same operation' }).waitFor({ state: 'detached' });
      assert.equal(sends.length, 2);
      assert.deepEqual(sends[0], sends[1], 'failed sends retain the exact request and mode');
      assert.equal(sends[0].mode, 'plan');
      assert.equal(await page.getByRole('combobox', { name: 'Chat mode' }).innerText(), 'Plan');
      await page.getByText('Plan only · no setup actions').first().waitFor();

      listed = [plan];
      await publish();
      const canvas = page.getByRole('region', { name: 'Canvas', exact: true });
      await canvas.getByRole('heading', { name: plan.title }).waitFor();
      await canvas.getByRole('button', { name: 'Close canvas' }).click();
      await canvas.waitFor({ state: 'detached' });
      listed = [];
      await publish();
      await page.getByRole('region', { name: `Plan: ${plan.title}` }).waitFor({ state: 'detached' });
      listed = [plan];
      await publish();
      const reference = page.getByRole('region', { name: `Plan: ${plan.title}` });
      await reference.waitFor();
      assert.equal(await canvas.count(), 0, 'a returning list cannot reopen a closed plan');
      await reference.getByRole('button', { name: 'Start plan' }).click();
      await reference.getByRole('alert').waitFor();
      await reference.getByRole('button', { name: 'Start plan' }).click();
      await reference.getByRole('button', { name: 'Pause plan' }).waitFor();
      assert.deepEqual(starts[0], starts[1], 'uncertain Start retries keep the exact version and request ID');
      assert.equal(
        await page.getByRole('combobox', { name: 'Chat mode' }).innerText(),
        'Plan',
        'Start does not change composer intent',
      );

      plan.lifecycle = 'completed';
      plan.outcome = 'completed';
      plan.version++;
      plan.counts = { ...plan.counts, pending: 0, ready: 0, completed: 2 };
      for (const task of plan.tasks) {
        task.state = 'completed';
        task.report = {
          outcome: 'passed',
          summary: 'Read back the fixture result.',
          checks: [
            {
              criterion: 0,
              outcome: 'passed',
              evidence: [{ callId: receiptId, summary: 'Checked the saved result.' }],
            },
          ],
          requirements:
            task.key === 'verify'
              ? [
                  {
                    key: 'dedup',
                    outcome: 'passed',
                    evidence: [{ callId: receiptId, summary: 'The repeat reused its issue.' }],
                  },
                ]
              : [],
        };
      }
      await publish();
      await reference.getByRole('button', { name: 'Open plan' }).click();
      await canvas.getByText('Verified', { exact: true }).first().waitFor();
      await canvas.getByRole('button', { name: /Verify first and repeat alerts/ }).click();
      await canvas.getByText('Verification details').click();
      await canvas.getByText('The repeat reused its issue.', { exact: false }).waitFor();

      await page.setViewportSize({ width: 375, height: 812 });
      listed = [];
      await page.goto(url);
      await page.getByRole('status', { name: 'Loading plans' }).waitFor({ state: 'detached' });
      await page.getByRole('textbox', { name: 'Message' }).waitFor();
      listed = [plan];
      await publish();
      await reference.waitFor();
      assert.equal(await page.getByRole('dialog', { name: 'Canvas' }).count(), 0, 'new plans leave phone chat open');
      await reference.getByRole('button', { name: 'Open plan' }).click();
      await page.getByRole('dialog', { name: 'Canvas' }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
