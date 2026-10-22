import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { installTurnstileFixture } from './turnstile-fixture.mjs';

test(
  'workspace-first signup resumes on another device and recovers without duplicate creation',
  { timeout: 90000 },
  async () => {
    const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
    await server.listen();
    const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
    const cdp = process.env.ONBOARDING_CDP_PORT;
    const browser = await chromium.launch({ headless: true, args: cdp ? [`--remote-debugging-port=${cdp}`] : [] });
    try {
      const errors = [],
        saves = [],
        emails = [],
        socials = [],
        completions = [];
      const id = '11111111-1111-4111-8111-111111111111';
      const session = {
        session: { id: 'session', expiresAt: '2099-01-01T00:00:00.000Z' },
        user: { id: '22222222-2222-4222-8222-222222222222', name: 'Sample user', email: 'sample@example.test' },
      };
      let saved,
        saveFailure = true,
        completionFailure = true,
        resumeFailure = false,
        expired = false,
        conflict = false;
      const workspace = {
        id,
        name: 'Sample studio',
        slug: 'sample-studio',
        status: 'provisioning',
        createdAt: '2026-10-11T00:00:00.000Z',
      };
      async function context(authenticated) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, reducedMotion: 'reduce' });
        await installTurnstileFixture(context);
        await context.route('**/v1/**', async route => {
          const path = new URL(route.request().url()).pathname;
          if (path === '/v1/auth/get-session') return route.fulfill({ json: authenticated ? session : null });
          if (path === '/v1/auth/options')
            return route.fulfill({ json: { turnstileSiteKey: 'fixture-site', google: true, magicLink: true } });
          if (path === '/v1/dev/sign-in-link') return route.fulfill({ status: 404, json: {} });
          if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
          if (path === '/v1/workspaces') return route.fulfill({ json: [] });
          if (path === `/v1/workspace-setups/${id}`)
            return route.fulfill({ json: { id, stage: 'reserved', error: null } });
          if (path === '/v1/onboarding/drafts') {
            const body = route.request().postDataJSON();
            saves.push(body);
            if (saveFailure)
              return route.fulfill({ status: 503, json: { error: 'Could not save the draft. Try again.' } });
            saved = { id, details: body.details, expiresAt: '2099-01-01T00:00:00.000Z' };
            return route.fulfill({ json: saved });
          }
          if (path === '/v1/auth/sign-in/magic-link') {
            emails.push(route.request().postDataJSON());
            return route.fulfill({ json: { status: true } });
          }
          if (path === '/v1/auth/sign-in/social') {
            socials.push(route.request().postDataJSON());
            return route.fulfill({ status: 503, json: { message: 'Provider unavailable' } });
          }
          if (path === '/v1/onboarding/resume') {
            if (expired)
              return route.fulfill({
                status: 404,
                json: { error: 'This onboarding draft has expired or is unavailable. Start again.' },
              });
            if (resumeFailure) return route.fulfill({ status: 503, json: { error: 'Could not load saved details.' } });
            await new Promise(resolve => setTimeout(resolve, 120));
            return route.fulfill({ json: saved });
          }
          if (path === '/v1/onboarding/complete') {
            completions.push(route.request().postDataJSON());
            await new Promise(resolve => setTimeout(resolve, 150));
            if (conflict)
              return route.fulfill({ status: 409, json: { error: 'This workspace URL is already taken.' } });
            if (completionFailure) return route.abort('connectionreset');
            return route.fulfill({ status: 202, json: workspace });
          }
          throw new Error(`Unexpected API request ${path}`);
        });
        return context;
      }
      const anonymous = await context(false);
      const page = await anonymous.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      const screenshot = async name => {
        if (!process.env.ONBOARDING_SCREENSHOTS) return;
        assert.ok(cdp, 'Screenshots use agent-browser over CDP');
        await new Promise(resolve => setTimeout(resolve, 800));
        await mkdir(process.env.ONBOARDING_SCREENSHOTS, { recursive: true });
        await promisify(execFile)('agent-browser', [
          '--cdp',
          cdp,
          'screenshot',
          `${process.env.ONBOARDING_SCREENSHOTS}/${name}.png`,
          '--full',
        ]);
      };
      await page.goto(`${origin}/register`);
      await page.getByLabel('Workspace name', { exact: true }).fill(workspace.name);
      assert.equal(await page.getByLabel('Workspace URL', { exact: true }).inputValue(), workspace.slug);
      await screenshot('signup-workspace-desktop');
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('heading', { name: 'Create your account' }).waitFor();
      await page.getByLabel('Name', { exact: true }).fill('Sample user');
      await page.getByLabel('Email', { exact: true }).fill('sample@example.test');
      await page.getByText('Test verification widget').waitFor();
      await page.evaluate(() => window.challenge.solve());
      await page.getByText('Verification complete.', { exact: true }).waitFor();
      await screenshot('signup-desktop');
      for (const width of [320, 375]) {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
        await screenshot(`signup-${width}-dark`);
        const overflow = await page.evaluate(() =>
          [...document.querySelectorAll('body *')]
            .filter(element => element.getBoundingClientRect().right > innerWidth + 1)
            .map(element => `${element.tagName}.${element.className}`)
            .slice(-10),
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          overflow.join('\n'),
        );
      }
      await screenshot('signup-mobile-dark');
      await page.setViewportSize({ width: 1280, height: 1100 });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.getByRole('button', { name: 'Create workspace with email' }).click();
      await page.getByText('Could not save the draft. Try again.').waitFor();
      assert.equal(emails.length, 0, 'Do not start auth before the draft is durable');
      await page
        .getByRole('main')
        .getByText(`${new URL(origin).host}/${workspace.slug}`, { exact: true })
        .waitFor();
      saveFailure = false;
      await page.getByText('Test verification widget').waitFor();
      await page.evaluate(() => window.challenge.solve());
      await page.getByRole('button', { name: 'Create workspace with email' }).click();
      await page.getByText('Check your email', { exact: true }).waitFor();
      assert.equal(saves[0].token, saves[1].token, 'An uncertain save reuses its token');
      const callback = emails[0].callbackURL;
      assert.equal(emails[0].newUserCallbackURL, callback);
      assert.equal(new URL(callback).hash, `#token=${saves[1].token}`);
      await page.getByRole('button', { name: 'Use a different email' }).click();
      await page.getByRole('button', { name: 'Continue with Google' }).click();
      await page.getByText('Google sign-in is unavailable. Please use an email link or try again later.').waitFor();
      assert.equal(socials[0].callbackURL, callback);
      assert.equal(socials[0].newUserCallbackURL, callback);
      assert.equal(saves.length, 2, 'Auth retries reuse a saved draft, including after another browser claims it');
      await anonymous.close();

      const signedIn = await context(true);
      const resumed = await signedIn.newPage();
      resumed.setDefaultTimeout(10000);
      resumed.on('pageerror', error => errors.push(error.message));
      resumeFailure = true;
      await resumed.goto(callback);
      await resumed.getByText('Could not load saved details.').waitFor();
      resumeFailure = false;
      await resumed.getByRole('button', { name: 'Try again', exact: true }).click();
      await resumed.getByText('Test verification widget').waitFor();
      await resumed.evaluate(() => window.challenge.solve());
      await resumed.getByText('We could not confirm creation. Your saved details are safe. Try again.').waitFor();
      await screenshot('resume-recovery');
      completionFailure = false;
      await resumed.getByText('Test verification widget').waitFor();
      await resumed.evaluate(() => window.challenge.solve());
      await resumed.getByRole('button', { name: 'Try again', exact: true }).dblclick();
      await resumed.waitForURL(`**/workspace-setups/${id}`);
      assert.equal(completions.length, 2);
      assert.ok(completions.every(body => body.token === saves[0].token));
      await resumed.goto(callback);
      await resumed.getByText('Test verification widget').waitFor();
      await resumed.evaluate(() => window.challenge.solve());
      await resumed.waitForURL(`**/workspace-setups/${id}`);
      assert.equal(completions.length, 3, 'Reload uses the same server-side creation identity');
      conflict = true;
      await resumed.goto(callback);
      await resumed.getByText('Test verification widget').waitFor();
      await resumed.evaluate(() => window.challenge.solve());
      await resumed.getByRole('link', { name: 'Choose a different workspace URL' }).click();
      await resumed.waitForURL('**/create-workspace#*');
      await resumed.getByLabel('Workspace name', { exact: true }).filter({ visible: true }).waitFor();
      await resumed.waitForFunction(
        () => document.querySelector('input[name=workspace-name]')?.value === 'Sample studio',
      );
      assert.equal(await resumed.getByLabel('Workspace URL', { exact: true }).inputValue(), workspace.slug);
      expired = true;
      await resumed.goto(callback);
      await resumed.getByRole('heading', { name: 'Start onboarding again' }).waitFor();
      assert.equal(await resumed.getByRole('link', { name: 'Create a workspace', exact: true }).count(), 1);
      assert.deepEqual(errors, []);
      await signedIn.close();
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
