import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';
import { openChatList } from './browser-controls.mjs';

const port = Number(process.env.INTERACTION_BROWSER_PORT ?? 5297);
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
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const workspace = {
    id: randomUUID(),
    slug: 'acme',
    name: 'Acme',
    status: 'ready',
    createdAt: new Date().toISOString(),
    soulCommit: 'a'.repeat(40),
  };
  const other = { ...workspace, id: randomUUID(), slug: 'other' };
  const chat = {
    id: randomUUID(),
    title: 'Human decisions',
    titleRevision: 1,
    archived: false,
    activityAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  const turnId = randomUUID();
  let item,
    reference,
    readStatus = 503,
    writeStatus = 200,
    delay = 0,
    lost = false,
    userId = 'owner';
  let reads = 0;
  const writes = [],
    messages = [],
    receipts = new Map();
  function information(definition = { kind: 'text' }) {
    item = {
      id: randomUUID(),
      turnId,
      revision: 1,
      prompt: 'When should we follow up?',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      status: 'pending',
      response: null,
      answerSchema: definition,
    };
    reference = { kind: 'request', requestId: item.id };
  }
  function approval() {
    item = {
      id: randomUUID(),
      turnId,
      revision: 1,
      prompt: 'Remove the old field?',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      resolution: null,
      action: {
        kind: 'table-migration',
        migrationId: randomUUID(),
        tableId: randomUUID(),
        planDigest: 'a'.repeat(64),
        expectedAppliedRevision: 'b'.repeat(40),
        effect: {
          kind: 'drop-field',
          tableId: randomUUID(),
          fieldId: randomUUID(),
          rowCount: 4,
          fingerprint: 'c'.repeat(64),
          internalSecret: 'NEVER-RENDER-THIS',
        },
      },
    };
    reference = { kind: 'approval', approvalId: item.id };
  }
  information();
  await page.route('**/v1/**', async route => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    let status = 200,
      json;
    if (path.endsWith('/auth/get-session'))
      json = {
        session: { id: `session-${userId}`, userId },
        user: { id: userId, name: userId, email: `${userId}@example.com` },
      };
    else if (path === '/v1/workspaces') json = [workspace, other];
    else if (path === '/v1/workspaces/acme') json = workspace;
    else if (path === '/v1/workspaces/other') json = other;
    else if (path.endsWith('/governance/me')) json = membership;
    else if (path.endsWith('/credits')) json = credits;
    else if (path.endsWith('/model-catalog')) json = chatCatalog;
    else if (path.includes('/requests/') || path.includes('/approvals/')) {
      if (req.method() === 'GET') {
        reads++;
        status = readStatus;
        json = structuredClone(item);
        await setTimeout(delay);
      } else {
        const body = req.postDataJSON();
        writes.push({ path, body });
        status = writeStatus;
        if (lost) readStatus = 503;
        await setTimeout(200);
        if (status === 200) {
          json = receipts.get(body.commandId);
          if (!json) {
            assert.equal(body.expectedRevision, item.revision);
            if (reference.kind === 'request') {
              item.status = path.endsWith('/cancel') ? 'cancelled' : 'answered';
              if (item.status === 'answered')
                item.response = {
                  id: path.split('/').at(-1),
                  answer: body.answer,
                  createdAt: new Date().toISOString(),
                };
              json = {
                requestId: item.id,
                revision: item.revision,
                status: item.status,
                responseId: item.response?.id ?? null,
              };
            } else {
              item.resolution = {
                requestId: item.id,
                revision: item.revision,
                status: body.decision === 'approve' ? 'approved' : 'rejected',
                confirmationId: body.decision === 'approve' ? randomUUID() : null,
              };
              json = item.resolution;
            }
            receipts.set(body.commandId, json);
          }
          if (lost) {
            lost = false;
            readStatus = 503;
            await route.abort('failed');
            return;
          }
        }
      }
    } else if (path.endsWith('/conversations'))
      json = { chats: path.includes(other.id) || userId !== 'owner' ? [] : [chat], nextCursor: null };
    else if (path.endsWith('/messages'))
      json = {
        messages: [
          {
            id: turnId,
            sequence: 1,
            author: 'assistant',
            createdAt: chat.createdAt,
            parts: [{ kind: 'text', text: 'Tool waiting.' }, reference],
            turn: null,
          },
          ...messages,
        ],
        nextBefore: null,
      };
    else if (path.includes('/messages/') && req.method() === 'PUT') {
      const body = req.postDataJSON();
      messages.push({
        id: path.split('/').at(-1),
        sequence: messages.length + 2,
        author: 'human',
        parts: body.parts,
        createdAt: chat.createdAt,
        turn: null,
      });
      json = { messageId: messages.at(-1).id, turnId: randomUUID(), sequence: messages.at(-1).sequence };
    } else if (path.endsWith(chat.id)) json = chat;
    else status = 404;
    await route.fulfill({
      status,
      json: status === 200 ? json : { error: 'unavailable' },
      headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
    });
  });
  const open = async () => {
    if (page.url() === `${origin}/acme/chat/${chat.id}`) await page.reload();
    else await page.goto(`${origin}/acme/chat/${chat.id}`);
  };
  await open();
  await page.getByRole('heading', { name: 'Could not load request' }).waitFor();
  assert.equal(await page.getByText('Response needed', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Retry loading request' }).click();
  await page.getByRole('status', { name: 'Loading request' }).waitFor();
  await page.getByRole('heading', { name: 'Could not load request' }).waitFor();
  readStatus = 200;
  delay = 400;
  await page.getByRole('button', { name: 'Retry loading request' }).click();
  await page.getByRole('status', { name: 'Loading request' }).waitFor();
  await page.getByLabel('Your answer', { exact: true }).fill('  ');
  // The sprout Form keeps Continue enabled and validates on submit (cloud e1a348e8, #1042).
  assert.equal(await page.getByRole('button', { name: 'Continue' }).isDisabled(), false);
  assert.equal(await page.getByText('Enter a message.', { exact: true }).count(), 0);
  await page.getByLabel('Your answer', { exact: true }).press('Enter');
  assert.equal(writes.length, 0, 'Whitespace-only answers do not submit');
  await page.getByLabel('Your answer', { exact: true }).fill('Tuesday');
  delay = 0;
  await page.getByLabel('Message', { exact: true }).fill('This is not an answer');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('This is not an answer', { exact: true }).waitFor();
  assert.equal(item.status, 'pending');
  assert.equal(writes.length, 0);
  readStatus = 503;
  await page.getByRole('button', { name: 'Check request status' }).click();
  await page.getByText('Could not refresh this request.', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('Your answer').inputValue(), 'Tuesday');
  assert.equal(await page.getByRole('button', { name: 'Continue' }).isDisabled(), true);
  // A status check still retrying (src/lib/query/policy.ts:15) would recover by itself; let it fail before the manual check.
  await page.locator('button[aria-label="Check request status"][aria-busy="false"]').waitFor();
  readStatus = 200;
  await page.getByRole('button', { name: 'Check request status' }).click();
  lost = true;
  await page.getByRole('button', { name: 'Continue' }).dblclick();
  await page.getByRole('button', { name: 'Retry same response' }).waitFor();
  assert.equal(await page.getByLabel('Your answer').isDisabled(), true);
  const first = writes.at(-1);
  readStatus = 200;
  await page.getByRole('button', { name: 'Retry same response' }).click();
  await page.getByText('Your answer was recorded.', { exact: true }).waitFor();
  assert.deepEqual(writes.at(-1), first);
  assert.equal(receipts.size, 1);
  assert.equal(await page.getByText('Tuesday', { exact: true }).textContent(), 'Tuesday');
  await page.reload();
  await page.getByText('Your answer was recorded.', { exact: true }).waitFor();
  const settledReads = reads;
  await setTimeout(2200);
  assert.equal(reads, settledReads);
  for (const multiple of [false, true]) {
    information({
      kind: 'choices',
      multiple,
      choices: [
        { id: 'tue', label: 'Tuesday' },
        { id: 'wed', label: 'Wednesday' },
      ],
    });
    await open();
    await page.getByRole(multiple ? 'checkbox' : 'radio', { name: 'Tuesday' }).click();
    if (multiple) await page.getByRole('checkbox', { name: 'Wednesday' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('Your answer was recorded.', { exact: true }).waitFor();
    assert.deepEqual(item.response.answer, { kind: 'choices', choiceIds: multiple ? ['tue', 'wed'] : ['tue'] });
  }
  information();
  await open();
  await page.getByRole('button', { name: 'Skip' }).click();
  await page.getByText('This request was cancelled without an answer.').waitFor();
  information();
  await open();
  await page.getByLabel('Your answer').waitFor();
  item.status = 'expired';
  await page.getByText('This request expired without an answer.').waitFor();
  approval();
  await open();
  await page.getByRole('button', { name: 'Approve action' }).waitFor();
  assert.equal(await page.getByText('NEVER-RENDER-THIS').count(), 0);
  await page.getByRole('button', { name: 'Approve action' }).focus();
  lost = true;
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Retry same response' }).waitFor();
  const approvalWrite = writes.at(-1);
  readStatus = 200;
  await page.getByRole('button', { name: 'Retry same response' }).click();
  await page.getByText('Approval recorded. This does not confirm the action has completed.').waitFor();
  assert.deepEqual(writes.at(-1), approvalWrite);
  await page.reload();
  await page.getByText('Approval recorded. This does not confirm the action has completed.').waitFor();
  approval();
  await open();
  writeStatus = 409;
  await page.getByRole('button', { name: 'Decline', exact: true }).click();
  await page.getByText('This request or proposal changed.', { exact: false }).waitFor();
  item.revision = 2;
  writeStatus = 200;
  await page.getByRole('button', { name: 'Check request status' }).click();
  await page.getByRole('button', { name: 'Review retained response' }).click();
  await page.getByRole('button', { name: 'Decline', exact: true }).click();
  await page.getByText('The proposed action was declined.').waitFor();
  assert.equal(writes.at(-1).body.expectedRevision, 2);
  for (const status of ['expired', 'cancelled']) {
    approval();
    item.resolution = { requestId: item.id, revision: 1, status, confirmationId: null };
    await open();
    await page
      .getByText(`This approval was ${status}. No approval was granted.`.replace('was expired', 'expired'))
      .waitFor();
    assert.equal(await page.getByRole('button', { name: 'Approve action' }).count(), 0);
  }
  approval();
  await open();
  await page.getByRole('button', { name: 'Approve action' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  chat.title = 'W'.repeat(80);
  item.prompt = 'LongUnbrokenApprovalPrompt'.repeat(20);
  await page.reload();
  await page.getByRole('heading', { name: item.prompt, exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(
    await page
      .getByRole('heading', { name: item.prompt, exact: true })
      .evaluate(element => element.scrollWidth <= element.clientWidth),
    true,
    'The approval title must wrap on mobile',
  );
  assert.equal(
    await page.getByRole('heading', { name: chat.title, exact: true }).getAttribute('title'),
    chat.title,
    'The compact title retains its complete accessible text',
  );
  assert.equal(
    await page
      .locator('header[aria-label="Workspace header"]')
      .evaluate(element => element.getBoundingClientRect().height),
    44,
    'Chat navigation occupies one row on mobile',
  );
  assert.equal(
    await page.getByRole('complementary', { name: 'Chat history' }).count(),
    0,
    'Chat history sidebar is removed',
  );
  await openChatList(page);
  await page.getByRole('region', { name: 'Chat list', exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole('region', { name: 'Chat list', exact: true })
      .evaluate(element => element.scrollWidth <= element.clientWidth),
    true,
    'Long chat-list titles must not overflow their mobile region',
  );
  await page.getByRole('button', { name: chat.title, exact: true }).click();
  await page.getByRole('heading', { name: item.prompt, exact: true }).waitFor();
  if (process.env.CONVERSATION_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.CONVERSATION_SCREENSHOT_DIR}/approval-mobile-dark.png`,
      fullPage: true,
    });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });
  if (process.env.CONVERSATION_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.CONVERSATION_SCREENSHOT_DIR}/approval-desktop-light.png`,
      fullPage: true,
    });
  // A pending approval keeps its status check under Details since cloud e1a348e8 (#1042), interaction-card.tsx:68.
  await page.locator('[aria-label="Table approval"]').getByRole('button', { name: 'Details', exact: true }).click();
  await page.getByRole('button', { name: 'Check request status' }).scrollIntoViewIfNeeded();
  readStatus = 404;
  await page.getByRole('button', { name: 'Check request status' }).click();
  await page.getByRole('heading', { name: 'Request unavailable' }).waitFor();
  assert.equal(await page.getByText('Remove the old field?', { exact: true }).count(), 0);
  const stoppedReads = reads;
  await setTimeout(2200);
  assert.equal(reads, stoppedReads);
  await page.goto(`${origin}/other`);
  await page.getByRole('region', { name: 'Conversation' }).getByRole('heading', { level: 2 }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve action' }).count(), 0);
  userId = 'other';
  await page.goto(`${origin}/acme`);
  await page.getByRole('region', { name: 'Conversation' }).getByRole('heading', { level: 2 }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'PASS mocked interaction contracts: loading/retry, retained input, exact lost-ack replay, ordinary-send isolation, text/single/multiple choices, cancel/expiry, approve/reject/revision conflict, safe effect projection, reload, stopped polling, permission clearing, workspace/session isolation, mobile dark/reduced motion. No real-backend proof claimed.',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
