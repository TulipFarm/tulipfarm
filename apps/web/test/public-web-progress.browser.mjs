import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createConversationExecutor } from '../../../packages/conversations/src/runtime.ts';
import { createChatTools, isExternalTool } from '../../../packages/agents/src/tools.ts';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { credits } from './chat-query.fixture.mjs';

const port = Number(process.env.PUBLIC_WEB_PROGRESS_PORT ?? 5497);
const origin = `http://127.0.0.1:${port}`;
const url = 'https://www.cloudflare.com/products/artifacts/';
const report = new URL('../../../reports/public-web/progress/', import.meta.url);
await mkdir(report, { recursive: true });
const providerStarted = Promise.withResolvers();
const releaseProvider = Promise.withResolvers();
const selectTool = Promise.withResolvers();
const releaseAnswer = Promise.withResolvers();
const selectFailure = Promise.withResolvers();
const releaseFailure = Promise.withResolvers();
const releaseIcon = Promise.withResolvers();
const provider = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  assert.equal(JSON.parse(Buffer.concat(chunks)).url, url);
  providerStarted.resolve();
  await releaseProvider.promise;
  response.setHeader('content-type', 'application/json');
  response.end(
    JSON.stringify({ success: true, data: { markdown: 'Artifacts page content.', metadata: { title: 'Artifacts' } } }),
  );
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const previousEndpoint = process.env.FIRECRAWL_ENDPOINT;
process.env.FIRECRAWL_ENDPOINT = `http://127.0.0.1:${provider.address().port}/`;
const f = await conversationFixture();
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
let browser;
let pending;
try {
  for (
    let i = 0;
    !(await fetch(origin).then(
      r => r.ok,
      () => false,
    ));
    i++
  ) {
    assert.ok(i < 100, 'Vite starts');
    await delay(100);
  }
  browser = await chromium.launch({ args: ['--disable-features=ThirdPartyCookiesDeprecation,TrackingProtection3pcd'] });
  const desktop = process.env.PUBLIC_WEB_PROGRESS_DESKTOP === '1';
  const page = await browser.newPage({
    viewport: desktop ? { width: 1440, height: 1000 } : { width: 390, height: 844 },
    colorScheme: desktop ? 'light' : 'dark',
    reducedMotion: 'reduce',
  });
  // Bud's labelled launcher sits bottom-right over the composer's Send button; move it as a user would by dragging.
  await page.addInitScript(() => localStorage.setItem('tulipfarm:bud-corner', 'bottom-left'));
  await page.context().addCookies(
    ['.google.com', '.icon.horse'].map(domain => ({
      name: 'favicon_test',
      value: 'synthetic',
      domain,
      path: '/',
      secure: true,
      sameSite: 'None',
    })),
  );
  let iconFails = false;
  const liveIcon = process.env.PUBLIC_WEB_LIVE_ICON === '1';
  const iconRequests = [];
  const iconHeaders = [];
  await page.context().route('https://icon.horse/icon/www.cloudflare.com', async route => {
    iconRequests.push(route.request().url());
    iconHeaders.push(await route.request().allHeaders());
    if (iconFails) return route.abort();
    if (liveIcon) return route.continue();
    await releaseIcon.promise;
    return route.fulfill({
      contentType: 'image/svg+xml',
      headers: { 'access-control-allow-origin': '*' },
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#f38020"/></svg>',
    });
  });
  const chatId = randomUUID();
  await f.store.create(f.workspace.id, f.workspace.userId, { chatId, commandId: randomUUID() });
  const earlier = await f.store.send(f.workspace.id, f.workspace.userId, chatId, {
    commandId: randomUUID(),
    messageId: randomUUID(),
    parts: [{ kind: 'text', text: 'Earlier question' }],
  });
  await createConversationExecutor(f.runtime, async () => ({
    text: 'Earlier answer.\n\n'.repeat(35),
    sources: [],
  })).process({ workspaceId: f.workspace.id, conversationId: chatId, turnId: earlier.turnId, generation: 0 });
  const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
    await selectTool.promise;
    const call = { tool: 'web.fetch', url };
    const output = await executeTool(
      call.tool,
      isExternalTool(call.tool),
      context => createChatTools(context.runtime).invokeWithSources(context, call),
      [],
      call,
    );
    assert.equal(output.result.status, 'success');
    await selectFailure.promise;
    await executeTool(
      'web.fetch',
      true,
      async () => {
        await releaseFailure.promise;
        throw new Error('private provider error');
      },
      [],
      { tool: 'web.fetch', url: `${url}?retry=1` },
    );
    await releaseAnswer.promise;
    return { text: 'Artifacts page summary.', sources: output.sources };
  });
  const workspace = {
    id: f.workspace.id,
    slug: 'web-progress',
    name: 'Web progress',
    status: 'ready',
    createdAt: new Date().toISOString(),
    soulCommit: 'a'.repeat(40),
  };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let json;
    if (path === '/v1/auth/get-session')
      json = {
        session: { id: 'test-session', userId: f.workspace.userId },
        user: { id: f.workspace.userId, name: 'Test user', email: 'test@example.com' },
      };
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === '/v1/workspaces/web-progress') json = workspace;
    else if (path.endsWith('/governance/me'))
      json = {
        membershipId: f.workspace.membershipId,
        role: 'admin',
        teams: [],
        capabilities: { manageGovernance: true, canLeave: true },
      };
    else if (path.endsWith('/credits')) json = credits;
    else if (path.endsWith('/model-catalog')) json = chatCatalog;
    else if (path.endsWith(`/conversations/${chatId}/messages`))
      json = await f.store.history(f.workspace.id, f.workspace.userId, chatId);
    else if (path.includes(`/conversations/${chatId}/messages/`) && request.method() === 'PUT') {
      json = await f.store.send(f.workspace.id, f.workspace.userId, chatId, {
        ...request.postDataJSON(),
        messageId: path.split('/').at(-1),
      });
      pending = executor.process({
        workspaceId: f.workspace.id,
        conversationId: chatId,
        turnId: json.turnId,
        generation: 0,
      });
    } else if (path.endsWith(`/conversations/${chatId}`))
      json = await f.store.read(f.workspace.id, f.workspace.userId, chatId);
    else if (path.endsWith('/conversations')) json = await f.store.list(f.workspace.id, f.workspace.userId);
    else return route.fulfill({ status: 404, json: { error: 'not-found' } });
    await route.fulfill({ json });
  });
  await page.goto(`${origin}/${workspace.slug}/chat/${chatId}`);
  const credentialProbe = Promise.withResolvers();
  await page.context().route('https://icon.horse/credential-probe', async route => {
    credentialProbe.resolve(await route.request().allHeaders());
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    });
  });
  await page.evaluate(() => {
    const image = new Image();
    image.src = 'https://icon.horse/credential-probe';
  });
  assert.equal(
    (await credentialProbe.promise).cookie,
    'favicon_test=synthetic',
    'Browser permits the seeded third-party cookie for a non-anonymous request',
  );
  await page.getByLabel('Message', { exact: true }).fill(`summarize - ${url}`);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  // Cloud 856d6a73 (#1026) shows a pending reply as transcript ToolActivity progress (tool-activity.tsx:141-142).
  await page.locator('[data-slot="reply-progress"]').filter({ hasText: 'Thinking' }).waitFor();
  await delay(700);
  assert.equal(await page.locator('[data-slot="tool-activity"]').count(), 0, 'No invented tool before selection');
  const timeline = page.getByRole('region', { name: 'Conversation', exact: true });
  const gap = () => timeline.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
  assert.ok((await gap()) < 2, 'Following latest before selection');
  const start = performance.now();
  selectTool.resolve();
  await providerStarted.promise;
  const activity = page.getByRole('list', { name: 'Tool activity', exact: true });
  // Transcript activity starts collapsed and keeps the reader's choice (cloud 856d6a73 #1026, tool-activity.tsx:138-140).
  await page
    .locator('[data-slot="tool-activity"]')
    .getByRole('button', { name: /^Working… / })
    .click();
  await activity.locator(`a[href="${url}"]`).waitFor();
  const running = await f.store.history(f.workspace.id, f.workspace.userId, chatId);
  assert.deepEqual(running.messages.at(-1).tools[0].web, {
    status: 'running',
    urls: [url],
    failedUrls: [],
    widened: false,
  });
  console.log(
    `Running receipt rendered ${Math.round(performance.now() - start)}ms after selection while provider is still blocked.`,
  );
  const favicon = activity.locator('[data-slot="source-favicon"]').first();
  if (!liveIcon) assert.equal(await favicon.getAttribute('data-status'), 'loading');
  // Cloud 856d6a73 (#1026) shows execution as one spinner on the activity trigger; rows use status marks (tool-activity.tsx:81,156).
  assert.equal(
    await page.locator('[data-slot="tool-activity"] [data-slot="spinner"]').count(),
    1,
    'Execution status stays separate from favicon',
  );
  assert.equal(
    await favicon.locator('[data-slot="spinner"]').count(),
    0,
    'Execution status stays separate from favicon',
  );
  releaseIcon.resolve();
  await page.waitForFunction(
    () => document.querySelector('[data-slot="source-favicon"]')?.getAttribute('data-status') === 'loaded',
  );
  assert.ok(await favicon.locator('img').evaluate(image => image.naturalWidth > 0), 'Favicon really decodes');
  assert.deepEqual(iconRequests, ['https://icon.horse/icon/www.cloudflare.com']);
  for (const headers of iconHeaders) {
    assert.equal(headers.cookie, undefined, 'Favicon omits existing provider cookies');
    assert.ok(!headers.referer, 'Favicon omits page referrer');
  }
  await page.screenshot({ path: new URL(desktop ? 'desktop-running.png' : 'mobile-running.png', report).pathname });
  assert.ok((await gap()) < 2, `New tool activity remains visible at latest. Bottom gap ${await gap()}px`);
  releaseProvider.resolve();
  await page
    .locator('[data-slot="tool-activity"]')
    .getByRole('button', { name: 'Working… Planning next step', exact: true })
    .waitFor();
  await timeline.evaluate(element => {
    element.scrollTop = 0;
  });
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).waitFor();
  selectFailure.resolve();
  await activity.locator(`a[href="${url}?retry=1"]`).waitFor();
  assert.equal(
    await timeline.evaluate(element => element.scrollTop),
    0,
    'Tool updates preserve reading older messages',
  );
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  releaseFailure.resolve();
  await activity.getByText('Public web retrieval failed. Retry or paste the text.', { exact: true }).waitFor();
  releaseAnswer.resolve();
  assert.equal(await pending, 'completed');
  await page.getByText('Artifacts page summary.', { exact: true }).waitFor();
  iconFails = true;
  await page.reload();
  const toggle = page.getByRole('button', { name: 'Tool activity · 2 tools · Some work failed', exact: true });
  await toggle.waitFor();
  await timeline.evaluate(element => {
    element.scrollTop = element.scrollHeight;
  });
  await delay(100);
  const beforeToggle = await toggle.evaluate(element => element.getBoundingClientRect().top);
  assert.ok((await gap()) < 2, 'Pinned to bottom before opening completed receipt');
  await toggle.click();
  await activity.getByRole('link', { name: 'Artifacts', exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelector('[data-slot="source-favicon"]')?.getAttribute('data-status') === 'failed',
  );
  assert.equal(await favicon.locator('img').count(), 0);
  assert.equal(await favicon.locator('svg').count(), 1, 'Failed icon keeps the globe');
  assert.equal(await activity.locator('[data-slot="spinner"]').count(), 0);
  await delay(100);
  const afterToggle = await toggle.evaluate(element => element.getBoundingClientRect().top);
  assert.ok(
    Math.abs(afterToggle - beforeToggle) < 2,
    `Receipt toggle stays in place. Before ${beforeToggle}px, after ${afterToggle}px`,
  );
  console.log(`Receipt toggle preserved at ${beforeToggle}px, then ${afterToggle}px.`);
  await toggle.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('[data-slot="tool-activity"] button')?.getAttribute('aria-expanded') === 'false',
  );
  await timeline.evaluate(element => {
    element.scrollTop = element.scrollHeight;
  });
  await delay(100);
  const beforeKeyboard = await toggle.evaluate(element => element.getBoundingClientRect().top);
  await toggle.focus();
  await page.keyboard.press('Enter');
  await activity.waitFor();
  await delay(100);
  const afterKeyboard = await toggle.evaluate(element => element.getBoundingClientRect().top);
  assert.ok(
    Math.abs(afterKeyboard - beforeKeyboard) < 2,
    `Keyboard expansion preserves viewport. Before ${beforeKeyboard}px, after ${afterKeyboard}px`,
  );
  for (const headers of iconHeaders) {
    assert.equal(headers.cookie, undefined, 'All favicon requests omit seeded cookies');
    assert.equal(headers.authorization, undefined);
    assert.ok(!headers.referer);
  }
  console.log(`PASS ${liveIcon ? 'live' : 'fixture'} favicon decoded without seeded provider cookies or referrer.`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await activity.scrollIntoViewIfNeeded();
  await page.screenshot({ path: new URL(desktop ? 'desktop-reloaded.png' : 'mobile-reloaded.png', report).pathname });
  assert.deepEqual(errors, []);
  console.log('PASS running receipt, completion, and reload through database-backed chat.');
} finally {
  selectTool.resolve();
  releaseProvider.resolve();
  releaseAnswer.resolve();
  selectFailure.resolve();
  releaseFailure.resolve();
  releaseIcon.resolve();
  await pending;
  await browser?.close();
  server.kill('SIGTERM');
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  if (previousEndpoint === undefined) delete process.env.FIRECRAWL_ENDPOINT;
  else process.env.FIRECRAWL_ENDPOINT = previousEndpoint;
  await f.close();
}
