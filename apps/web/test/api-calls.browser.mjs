import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { apiCallDecisionSchema, apiCallViewSchema } from '@tulipfarm/api-calls/contracts';
import { toolPresentation } from '@tulipfarm/conversations/tool-activity';
import { declineRequestSchema, submitRequestSchema } from '@tulipfarm/secrets';
import { secretRequestViewSchema } from '../src/features/secrets/contracts.ts';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';

test('a waiting change shows what will be sent and records Send and Don’t send', { timeout: 120000 }, async () => {
  const port = 5767;
  const origin = `http://127.0.0.1:${port}`;
  const { workspace, session } = createWorkspaceFixture({ slug: 'api-qa', name: 'API QA' });
  const membershipId = randomUUID(),
    chatId = randomUUID(),
    turnId = randomUUID();
  const body = JSON.stringify({
    title: 'Checkout fails for EUR orders',
    description: `Orders paid in euros fail at the final step with an empty currency. ${'x'.repeat(160)}`,
  });
  const view = (method, url, extra = {}) =>
    apiCallViewSchema.parse({
      id: randomUUID(),
      status: 'awaiting-approval',
      method,
      url,
      host: new URL(url).host,
      headers: { 'Content-Type': 'application/json' },
      body: null,
      secrets: [{ name: 'LINEAR_API_KEY', placement: { kind: 'bearer' } }],
      purpose: null,
      digest: 'a'.repeat(64),
      expiresAt: '2099-10-11T00:00:00Z',
      responseStatus: null,
      errorCode: null,
      origin: { kind: 'chat', conversationId: chatId },
      ...extra,
    });
  const calls = [
    view('POST', 'https://api.linear.app/v1/issues', {
      body: { contentType: 'application/json', preview: body, bytes: body.length, truncated: false },
    }),
    view('DELETE', 'https://api.linear.app/v1/issues/ENG-301', { digest: 'b'.repeat(64) }),
  ];
  const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
  });
  let browser;
  try {
    for (
      let attempt = 0;
      !(await fetch(origin).then(
        response => response.ok,
        () => false,
      ));
      attempt++
    ) {
      assert.ok(attempt < 150 && server.exitCode === null, 'Vite starts');
      await delay(100);
    }
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const errors = [],
      decisions = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/v1/**', async route => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      let json;
      const call = calls.find(item => path.includes(`/api-calls/${item.id}`));
      if (path === '/v1/auth/get-session') json = session;
      else if (path === '/v1/user/visit') json = { firstSession: false };
      else if (path === '/v1/workspaces') json = [workspace];
      else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
      else if (path.endsWith('/governance/me'))
        json = { membershipId, role: 'member', teams: [], capabilities: { manageGovernance: false, canLeave: true } };
      else if (path.endsWith('/model-catalog')) json = chatCatalog;
      else if (call && path.endsWith('/decision') && request.method() === 'POST') {
        const decision = apiCallDecisionSchema.parse(request.postDataJSON());
        decisions.push({ id: call.id, ...decision });
        if (decision.digest !== call.digest)
          return route.fulfill({ status: 409, json: { error: 'api-call-conflict' } });
        call.status = decision.decision === 'approve' ? 'sending' : 'rejected';
        json = call;
      } else if (call) {
        if (call.status === 'sending') Object.assign(call, { status: 'sent', responseStatus: 201 });
        json = call;
      } else if (path.endsWith('/messages'))
        json = {
          messages: [
            {
              id: turnId,
              sequence: 1,
              author: 'human',
              createdAt: workspace.createdAt,
              parts: [{ kind: 'text', text: 'File the EUR checkout bug and remove the old one.' }],
              turn: { id: turnId, status: 'waiting', generation: 0 },
              tools: calls.map(item => ({
                id: item.id,
                tool: 'api.request',
                status: 'running',
                activityStatus: 'waiting',
                presentation: toolPresentation('api.request', {
                  tool: 'api.request',
                  method: item.method,
                  url: item.url,
                }),
                api: { review: true },
              })),
            },
          ],
          nextBefore: null,
          hasGitHubProposals: false,
        };
      else if (path.endsWith(`/conversations/${chatId}`))
        json = {
          id: chatId,
          title: 'EUR checkout bug',
          titleRevision: 1,
          archived: false,
          activityAt: workspace.createdAt,
          createdAt: workspace.createdAt,
        };
      else return route.fulfill({ status: 404, json: { error: 'not-found' } });
      return route.fulfill({ json });
    });

    const card = name => page.getByRole('region', { name, exact: true });
    const create = card('POST api.linear.app/v1/issues'),
      remove = card('DELETE api.linear.app/v1/issues/ENG-301');
    await page.goto(`${origin}/${workspace.slug}/chat/${chatId}`);
    await create.getByRole('button', { name: 'Send request', exact: true }).waitFor();
    await remove.getByRole('button', { name: 'Don’t send', exact: true }).waitFor();

    await create.getByRole('button', { name: 'Details', exact: true }).click();
    await create.getByText('Authorization: Bearer ‹LINEAR_API_KEY›', { exact: true }).waitFor();
    await create.getByText('Checkout fails for EUR orders', { exact: false }).waitFor();

    // The body wraps at word boundaries, so no word is split unless it is longer than the line.
    const preview = create.locator('pre');
    assert.equal(await preview.evaluate(element => getComputedStyle(element).overflowWrap), 'anywhere');
    assert.equal(await preview.evaluate(element => getComputedStyle(element).wordBreak), 'normal');

    for (const width of [360, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await delay(100);
      const [scroll, client] = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]);
      assert.ok(scroll <= client, `no horizontal scroll at ${width}px (${scroll} > ${client})`);
      for (const region of [create, remove]) {
        const [inner, outer] = await region.evaluate(element => [element.scrollWidth, element.clientWidth]);
        assert.ok(inner <= outer, `the card fits at ${width}px`);
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    await create.getByRole('button', { name: 'Send request', exact: true }).click();
    await create.getByRole('status').filter({ hasText: 'Sent · 201' }).waitFor();
    await remove.getByRole('button', { name: 'Don’t send', exact: true }).click();
    await remove.getByRole('status').filter({ hasText: 'Not sent' }).waitFor();

    assert.deepEqual(
      decisions.map(({ id, decision, digest }) => ({ id, decision, digest })),
      [
        { id: calls[0].id, decision: 'approve', digest: 'a'.repeat(64) },
        { id: calls[1].id, decision: 'reject', digest: 'b'.repeat(64) },
      ],
    );
    assert.notEqual(decisions[0].commandId, decisions[1].commandId);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
});

test(
  'a task waiting on a secret shows the owner its form and records Provide and Decline',
  { timeout: 120000 },
  async () => {
    const port = 5768;
    const origin = `http://127.0.0.1:${port}`;
    const { workspace, session } = createWorkspaceFixture({ slug: 'task-secret-qa', name: 'Task secret QA' });
    const taskId = randomUUID(),
      membershipId = randomUUID();
    const form = (label, destinations) => ({
      id: randomUUID(),
      status: 'waiting',
      revision: 1,
      expiresAt: '2099-10-11T00:00:00.000Z',
      purpose: `The agent needs the ${label} to read last week’s invoices.`,
      destinations,
      fields: [{ id: 'token', label, kind: 'token', placement: { kind: 'bearer' }, options: [] }],
      declineReason: null,
    });
    const forms = [
      secretRequestViewSchema.parse(
        form('Billing service token', [
          { kind: 'endpoint', value: 'http://billing.internal:8080/api/invoices', plainHttp: true },
        ]),
      ),
      secretRequestViewSchema.parse(
        form('Stripe restricted key', [{ kind: 'host', value: 'api.stripe.com', plainHttp: false }]),
      ),
    ];
    let status = 'waiting-approval';
    const answers = [];
    const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: new URL('..', import.meta.url),
      stdio: 'ignore',
    });
    let browser;
    try {
      for (
        let attempt = 0;
        !(await fetch(origin).then(
          response => response.ok,
          () => false,
        ));
        attempt++
      ) {
        assert.ok(attempt < 150 && server.exitCode === null, 'Vite starts');
        await delay(100);
      }
      browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/v1/**', async route => {
        const request = route.request(),
          path = new URL(request.url()).pathname,
          tasks = `/v1/workspaces/${workspace.id}/agent-tasks/${taskId}`;
        const secret = forms.find(item => path.includes(`/secret-requests/${item.id}`));
        let json;
        if (path === '/v1/auth/get-session') json = session;
        else if (path === '/v1/user/visit') json = { firstSession: false };
        else if (path === '/v1/workspaces') json = [workspace];
        else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
        else if (path.endsWith('/governance/me'))
          json = { membershipId, role: 'member', teams: [], capabilities: { manageGovernance: false, canLeave: true } };
        else if (path.endsWith('/secrets/capabilities')) json = { enabled: true };
        else if (secret && request.method() === 'POST') {
          const decline = path.endsWith('/decline');
          const body = (decline ? declineRequestSchema : submitRequestSchema).parse(request.postDataJSON());
          answers.push({ id: secret.id, kind: decline ? 'decline' : 'submit', body });
          secret.status = decline ? 'declined' : 'provided';
          if (forms.every(item => item.status !== 'waiting')) status = 'pending';
          json = { status: secret.status };
        } else if (secret) json = secret;
        else if (path === `${tasks}/secret-requests`)
          json = {
            requests: forms.map(item => ({
              id: item.id,
              status: item.status,
              revision: item.status === 'waiting' ? 1 : 2,
              expiresAt: item.expiresAt,
              purpose: item.purpose,
              declineReason: null,
              references: [],
            })),
          };
        else if (path === `${tasks}/api-calls`) json = { calls: [] };
        else if (path === `${tasks}/history`) json = { messages: [], nextCursor: null };
        else if (path === `${tasks}/proposals`) json = { proposals: [], nextCursor: null };
        else if (path === tasks)
          json = {
            id: taskId,
            generation: 0,
            status,
            pauseReason: null,
            agentId: membershipId,
            activationId: membershipId,
            definitionRevision: 'a'.repeat(64),
            parentTaskId: null,
            delegationDepth: 0,
            skills: [],
            scope: [],
            limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
            flowId: taskId,
            activeMilliseconds: '1200',
            toolCalls: answers.length + 1,
            createdAt: workspace.createdAt,
            cost: { chargedCreditUnits: '0', heldCreditUnits: '0' },
            activity: [],
          };
        else return route.fulfill({ status: 404, json: { error: 'not-found' } });
        return route.fulfill({ json });
      });

      await page.goto(`${origin}/${workspace.slug}/agent-tasks/${taskId}`);
      await page.getByRole('status').filter({ hasText: 'Needs a secret' }).waitFor();
      await page.getByText('Provide or decline the secret request below.', { exact: true }).waitFor();
      const billing = page.getByRole('region', { name: 'The agent needs your Billing service token' }),
        stripe = page.getByRole('region', { name: 'The agent needs your Stripe restricted key' });
      await billing.getByText('Used only for this task run, deleted when the run ends', { exact: false }).waitFor();
      await billing.getByText('Sent without encryption', { exact: true }).waitFor();
      assert.equal(await stripe.getByText('Sent without encryption', { exact: true }).count(), 0);

      for (const width of [360, 320]) {
        await page.setViewportSize({ width, height: 800 });
        await delay(100);
        const [scroll, client] = await page.evaluate(() => [
          document.documentElement.scrollWidth,
          document.documentElement.clientWidth,
        ]);
        assert.ok(scroll <= client, `no horizontal scroll at ${width}px (${scroll} > ${client})`);
        for (const region of [billing, stripe]) {
          const [inner, outer] = await region.evaluate(element => [element.scrollWidth, element.clientWidth]);
          assert.ok(inner <= outer, `the form fits at ${width}px`);
        }
      }
      await page.setViewportSize({ width: 1280, height: 900 });

      await billing.getByRole('textbox', { name: 'Billing service token · Token' }).fill('billing-token-0123456789');
      await billing.getByRole('button', { name: 'Provide secret', exact: true }).click();
      await billing.waitFor({ state: 'detached' });
      await stripe.getByRole('button', { name: 'Decline', exact: true }).click();
      await stripe.getByLabel('Reason').fill('Use the staging key');
      await stripe.getByRole('button', { name: 'Decline request', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Working' }).waitFor();

      assert.deepEqual(
        answers.map(({ id, kind }) => ({ id, kind })),
        [
          { id: forms[0].id, kind: 'submit' },
          { id: forms[1].id, kind: 'decline' },
        ],
      );
      assert.deepEqual(answers[0].body.fields, [
        {
          fieldId: 'token',
          value: { value: 'billing-token-0123456789' },
          lifetime: 'conversation',
          expiresAt: answers[0].body.fields[0].expiresAt,
        },
      ]);
      assert.equal(answers[0].body.expectedRevision, 1);
      assert.equal(answers[1].body.reason, 'Use the staging key');
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      server.kill('SIGTERM');
    }
  },
);
