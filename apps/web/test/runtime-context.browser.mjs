import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { modelOption } from './browser-controls.mjs';

const port = Number(process.env.RUNTIME_CONTEXT_BROWSER_PORT ?? 5373);
const origin = `http://127.0.0.1:${port}`;
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {
      if (attempt === 100) throw new Error('Vite did not start');
    }
    await setTimeout(100);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ timezoneId: 'America/Los_Angeles' });
  const workspace = {
    id: randomUUID(),
    slug: 'acme',
    name: 'Acme',
    status: 'ready',
    createdAt: '2026-10-02T00:00:00Z',
    soulCommit: 'a'.repeat(40),
  };
  const chat = {
    id: randomUUID(),
    title: 'Calendar QA',
    titleRevision: 0,
    archived: false,
    activityAt: workspace.createdAt,
    createdAt: workspace.createdAt,
  };
  const messages = [];
  const sends = [];
  const retries = [];
  let drop = true;
  await page.route('**/v1/**', async route => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    let json = {},
      status = 200;
    if (path === '/v1/auth/get-session')
      json = { session: { id: 'qa', userId: 'ada' }, user: { id: 'ada', name: 'Ada', email: 'ada@example.com' } };
    else if (path === '/v1/auth/update-user') json = { status: true };
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === '/v1/workspaces/acme') json = workspace;
    // The workspace route reads the caller's membership and treats a 404 as not found (cloud router.tsx:402-409).
    else if (path.endsWith('/governance/me'))
      json = {
        membershipId: randomUUID(),
        role: 'member',
        teams: [],
        capabilities: { manageGovernance: false, canLeave: true },
      };
    else if (path.endsWith('/model-catalog')) json = chatCatalog;
    else if (path.endsWith(`/conversations/${chat.id}`)) json = chat;
    else if (path.endsWith(`/conversations/${chat.id}/messages`)) json = { messages, nextBefore: null };
    else if (request.method() === 'PUT' && path.includes('/messages/')) {
      const body = request.postDataJSON();
      sends.push(body);
      if (!messages.length)
        messages.push({
          id: path.split('/').at(-1),
          sequence: 1,
          author: 'human',
          createdAt: workspace.createdAt,
          parts: body.parts,
          turn: { id: randomUUID(), generation: 5, status: 'failed', errorCode: 'model-invalid-decision' },
          tools: [],
        });
      if (drop) {
        drop = false;
        await route.abort('failed');
        return;
      }
      json = { messageId: messages[0].id, turnId: messages[0].turn.id, sequence: 1 };
    } else if (path.endsWith('/retry')) {
      retries.push(request.postDataJSON());
      messages[0].turn = { ...messages[0].turn, generation: 6, status: 'queued', errorCode: null };
      json = { turnId: messages[0].turn.id, generation: 6, status: 'queued' };
    } else if (path.endsWith('/cancel')) {
      messages[0].turn = { ...messages[0].turn, generation: 7, status: 'cancelled', errorCode: null };
      json = { turnId: messages[0].turn.id, generation: 7, status: 'cancelled' };
    } else status = 404;
    await route.fulfill({
      status,
      json,
      headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
    });
  });
  await page.goto(`${origin}/acme/chat/${chat.id}`);
  await page.getByRole('combobox', { name: /^Model:/ }).click();
  await modelOption(page, 'DeepSeek Flash').click();
  await page.getByLabel('Message', { exact: true }).fill('Show my events for today.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Retry same operation' }).click();
  await page.getByRole('button', { name: 'Retry reply', exact: true }).waitFor();
  assert.equal(sends[0].timeZone, 'America/Los_Angeles');
  assert.deepEqual(sends[1], sends[0]);
  const error =
    'The model could not produce a valid answer or tool request. Retry uses the original model. To use another model, select it and send a new message.';
  assert.equal(await page.getByRole('alert').filter({ hasText: error }).count(), 1);
  await page.getByRole('combobox', { name: /^Model:/ }).click();
  // Chat composer model options show only the family label, without credit rates (cloud 9725b0ba features/chat/composer.tsx:296).
  await modelOption(page, 'Kimi').click();
  await page.getByRole('button', { name: 'Retry reply', exact: true }).click();
  await page.getByRole('button', { name: 'Stop reply', exact: true }).waitFor();
  assert.equal(sends[0].model, 'deepseek-flash');
  assert.deepEqual(Object.keys(retries[0]).sort(), ['commandId', 'expectedGeneration']);
  assert.equal(retries[0].expectedGeneration, 5);
  assert.equal(await page.getByText(error, { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Stop reply', exact: true }).click();
  await page.getByText('Reply cancelled', { exact: true }).waitFor();
  await page.getByLabel('Message', { exact: true }).fill('Use the newly selected model.');
  await Promise.all([
    page.waitForResponse(
      response =>
        response.request().method() === 'GET' && response.url().endsWith(`/conversations/${chat.id}/messages`),
    ),
    page.getByRole('button', { name: 'Send message', exact: true }).click(),
  ]);
  assert.equal(sends[2].model, 'kimi');
  for (const [code, reason] of [
    [
      'model-output-limit',
      'The model reached its response limit. Send a new message with a smaller request or select another model before sending.',
    ],
    [
      'model-quota',
      'The model provider has no available quota. Select another model and send a new message, or contact your workspace administrator.',
    ],
    [
      'model-provider-error',
      'The model provider could not complete the reply. Retry uses the original model. To use another model, select it and send a new message. Check any tool activity before requesting another action.',
    ],
  ]) {
    messages[0].turn = { ...messages[0].turn, status: 'failed', errorCode: code };
    await page.reload();
    await page.getByRole('alert').filter({ hasText: reason }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Retry reply', exact: true }).count(), 1);
  }
  console.log(
    'Verified timezone and uncertain-send replay, failure recovery copy, unchanged retry command after model selection, new-message model selection, and cancellation.',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
