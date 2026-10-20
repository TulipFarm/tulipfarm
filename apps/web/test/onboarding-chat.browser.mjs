import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { installTurnstileFixture } from './turnstile-fixture.mjs';

test('website chat resumes in Cloud and preserves history through setup recovery', { timeout: 90000 }, async () => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  const cdp = process.env.ONBOARDING_CHAT_CDP_PORT;
  const browser = await chromium.launch({ headless: true, args: cdp ? [`--remote-debugging-port=${cdp}`] : [] });
  try {
    const id = '11111111-1111-4111-8111-111111111111';
    const token = 'a'.repeat(64);
    const path = `/onboarding/chat#token=${token}`;
    const session = {
      session: { id: 'session', expiresAt: '2099-01-01T00:00:00.000Z' },
      user: { id: '22222222-2222-4222-8222-222222222222', name: 'Sample user', email: 'sample@example.test' },
    };
    const messages = [
      { role: 'user', content: 'I want to organize my studio in TulipFarm.' },
      { role: 'assistant', content: 'We can start with a workspace for your studio.' },
      {
        role: 'user',
        content:
          '<img src="https://external.example/tracker" onerror="window.injected=true"> [link](javascript:alert(1))',
      },
    ];
    const draft = {
      id,
      details: { accountType: 'business', name: 'Cedar Studio', slug: 'cedar-studio', messages },
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const workspace = {
      id,
      name: draft.details.name,
      slug: draft.details.slug,
      status: 'provisioning',
      createdAt: '2026-10-11T00:00:00.000Z',
    };
    const drafts = new Map([[token, draft]]);
    const completions = [],
      saves = [],
      resumes = [],
      errors = [];
    let completionMode = 'uncertain',
      statusMode = 'reserved',
      expired = false,
      resumeFailure = false,
      saveFailure = true,
      statusReads = 0;
    async function context(authenticated) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, reducedMotion: 'reduce' });
      await installTurnstileFixture(context);
      await context.route('**/v1/**', async route => {
        const request = route.request(),
          pathname = new URL(request.url()).pathname;
        if (pathname === '/v1/auth/get-session')
          return route.fulfill({ json: authenticated && statusMode !== 'unauthorized' ? session : null });
        if (pathname === '/v1/auth/options') return route.fulfill({ json: { turnstileSiteKey: 'fixture-site' } });
        if (pathname === '/v1/workspaces') return route.fulfill({ json: [] });
        if (pathname === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
        if (pathname === '/v1/dev/sign-in-link') return route.fulfill({ status: 404, json: {} });
        if (pathname === '/v1/onboarding/resume') {
          resumes.push(request.postDataJSON());
          if (expired)
            return route.fulfill({
              status: 404,
              json: { error: 'This onboarding draft has expired or is unavailable. Start again.' },
            });
          if (resumeFailure) return route.fulfill({ status: 503, json: { error: 'Could not load saved details.' } });
          return route.fulfill({ json: drafts.get(request.postDataJSON().token) });
        }
        if (pathname === '/v1/onboarding/complete') {
          completions.push(request.postDataJSON());
          if (completionMode === 'conflict')
            return route.fulfill({ status: 409, json: { error: 'This workspace URL is already taken.' } });
          if (completionMode === 'uncertain') return route.abort('connectionreset');
          return route.fulfill({ status: 202, json: workspace });
        }
        if (pathname === `/v1/workspace-setups/${id}`) {
          statusReads++;
          if (statusMode === 'error')
            return route.fulfill({ status: 503, json: { error: 'Status temporarily unavailable.' } });
          if (statusMode === 'unauthorized') return route.fulfill({ status: 401, json: { error: 'Sign in again.' } });
          return route.fulfill({ json: { id, stage: statusMode, error: null } });
        }
        if (pathname === '/v1/onboarding/drafts') {
          const body = request.postDataJSON();
          saves.push(body);
          drafts.set(body.token, { ...draft, details: body.details });
          if (saveFailure) return route.abort('connectionreset');
          return route.fulfill({ json: drafts.get(body.token) });
        }
        throw new Error(`Unexpected API request ${pathname}`);
      });
      return context;
    }
    const anonymous = await context(false);
    const anonymousPage = await anonymous.newPage();
    await anonymousPage.goto(`${origin}${path}`);
    await anonymousPage.waitForURL('**/login?*');
    assert.equal(new URL(anonymousPage.url()).searchParams.get('redirect'), path);
    assert.equal(resumes.length + completions.length, 0, 'Do not restore or create before account authentication');
    await anonymous.close();

    const signedIn = await context(true);
    const page = await signedIn.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    resumeFailure = true;
    await page.goto(`${origin}${path}`);
    await page.getByText('Could not load saved details.', { exact: true }).waitFor();
    resumeFailure = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    const history = page.getByRole('region', { name: 'Your saved onboarding chat' });
    await history.getByText(messages[0].content, { exact: true }).waitFor();
    assert.equal(await history.getByText(messages[2].content, { exact: true }).count(), 1);
    assert.equal(
      await history.locator('img, a, script').count(),
      0,
      'Untrusted saved history is plain text, not executable or linked content',
    );
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(completions.length, 0);
    await page.getByText('Test verification widget').waitFor();
    await page.evaluate(() => window.challenge.solve());
    await page.getByText('We could not confirm creation. Your saved details are safe. Try again.').waitFor();
    assert.equal(await history.getByText(messages[0].content, { exact: true }).count(), 1);
    completionMode = 'normal';
    await page.getByText('Test verification widget').waitFor();
    await page.evaluate(() => window.challenge.solve());
    await page.getByRole('button', { name: 'Try again', exact: true }).dblclick();
    await page.getByRole('heading', { name: 'Setting up your workspace', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/onboarding/chat', 'Provisioning stays in this chat');
    assert.equal(completions.length, 2);
    assert.ok(completions.every(body => body.token === token));
    statusMode = 'error';
    await page.getByRole('button', { name: 'Check status again' }).waitFor();
    statusMode = 'ready';
    await page.getByRole('button', { name: 'Check status again' }).click();
    await page.getByRole('button', { name: 'Open workspace' }).waitFor();
    assert.equal(completions.length, 2, 'Status recovery must never create the workspace again');
    assert.ok(statusReads >= 3);
    if (process.env.ONBOARDING_CHAT_SCREENSHOTS) {
      assert.ok(cdp, 'Visual proof includes agent-browser inspection');
      await mkdir(process.env.ONBOARDING_CHAT_SCREENSHOTS, { recursive: true });
      execFileSync('agent-browser', ['--session', 'chat-auth-proof', '--cdp', cdp, 'snapshot', '--json'], {
        timeout: 20000,
        stdio: 'pipe',
      });
      for (const colorScheme of ['light', 'dark'])
        for (const width of [375, 1280]) {
          await page.setViewportSize({ width, height: 1100 });
          await page.emulateMedia({ colorScheme });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.screenshot({
            path: `${process.env.ONBOARDING_CHAT_SCREENSHOTS}/onboarding-chat-${colorScheme}-${width}.png`,
            fullPage: true,
          });
        }
    }
    completionMode = 'conflict';
    await page.reload();
    await page.getByText('Test verification widget').waitFor();
    await page.evaluate(() => window.challenge.solve());
    await page.getByLabel('Workspace URL', { exact: true }).fill('cedar-studio-new');
    await page.getByRole('button', { name: 'Save new URL', exact: true }).click();
    await page.getByText('We could not confirm the new URL was saved. Your chat is kept. Try again.').waitFor();
    assert.equal(await page.getByLabel('Workspace URL', { exact: true }).inputValue(), 'cedar-studio-new');
    saveFailure = false;
    await page.getByRole('button', { name: 'Save new URL', exact: true }).click();
    await page.waitForURL(`**/onboarding/chat#token=${saves[0].token}`);
    await history.getByText(messages[0].content, { exact: true }).waitFor();
    assert.equal(saves.length, 2);
    assert.deepEqual(saves[0], saves[1], 'An uncertain replacement save reuses its token and complete transcript');
    assert.notEqual(saves[0].token, token, 'Changed workspace details use a new immutable draft');
    assert.deepEqual(saves[0].details.messages, messages);
    const before = completions.length;
    await page.getByText('Test verification widget').waitFor();
    assert.equal(completions.length, before, 'Replacing the draft clears the old challenge');
    completionMode = 'normal';
    statusMode = 'ready';
    await page.evaluate(() => window.challenge.solve());
    await page.getByRole('button', { name: 'Open workspace' }).waitFor();
    assert.equal(completions.at(-1).token, saves[0].token);

    statusMode = 'unavailable';
    await page.reload();
    await page.getByText('Test verification widget').waitFor();
    await page.evaluate(() => window.challenge.solve());
    await page.getByRole('heading', { name: 'Workspace setup is unavailable' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Back to your workspaces' }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Open workspace' }).count(), 0);

    statusMode = 'reserved';
    await page.reload();
    await page.getByText('Test verification widget').waitFor();
    await page.evaluate(() => window.challenge.solve());
    await page.getByRole('heading', { name: 'Setting up your workspace', exact: true }).waitFor();
    statusMode = 'unauthorized';
    await page.waitForURL('**/login?*');
    assert.equal(new URL(page.url()).searchParams.get('redirect'), `/onboarding/chat#token=${saves[0].token}`);

    statusMode = 'ready';
    drafts.set(token, { ...draft, details: { ...draft.details, messages: [] } });
    await page.goto(`${origin}${path}`);
    await page
      .getByText(`You are signed in. Let's finish setting up ${draft.details.name}.`, { exact: true })
      .waitFor();
    assert.equal(await history.getByText(messages[0].content).count(), 0);
    expired = true;
    await page.reload();
    await page.getByRole('heading', { name: 'Start onboarding again' }).waitFor();
    assert.equal(await history.count(), 0, 'Unavailable drafts do not display stale history');
    assert.deepEqual(errors, []);
    await signedIn.close();
  } finally {
    await browser.close();
    await server.close();
  }
});
