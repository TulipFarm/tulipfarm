import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { apiCallDecisionSchema, apiCallViewSchema } from '@tulipfarm/api-calls/contracts';
import { toolPresentation } from '@tulipfarm/conversations/tool-activity';
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
