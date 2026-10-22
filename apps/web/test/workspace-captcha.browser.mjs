import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { installTurnstileFixture } from './turnstile-fixture.mjs';

test(
  'workspace creation requires verification and safely retries rejected and uncertain submissions',
  { timeout: 90000 },
  async () => {
    const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
    await server.listen();
    const origin = server.resolvedUrls.local[0];
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
      await installTurnstileFixture(context);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let optionsFailure = true;
      let outcome = 'rejected';
      const sends = [];
      const workspace = {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'CAPTCHA workspace',
        slug: 'captcha-workspace',
        status: 'provisioning',
        createdAt: '2026-10-03T00:00:00.000Z',
      };
      await context.route('**/v1/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
        if (path === '/v1/auth/get-session')
          return route.fulfill({
            json: {
              session: { id: 'session', expiresAt: '2099-01-01T00:00:00.000Z' },
              user: {
                id: '22222222-2222-4222-8222-222222222222',
                name: 'Workspace user',
                email: 'captcha@example.com',
              },
            },
          });
        if (path === '/v1/auth/options')
          return route.fulfill({
            status: optionsFailure ? 503 : 200,
            json: optionsFailure ? {} : { turnstileSiteKey: 'fixture-site', google: true, magicLink: true },
          });
        if (path === '/v1/workspaces' && route.request().method() === 'POST') {
          sends.push(route.request().postDataJSON());
          await new Promise(resolve => setTimeout(resolve, 150));
          if (outcome === 'lost') return route.abort('connectionreset');
          if (outcome === 'rejected')
            return route.fulfill({
              status: 403,
              json: { error: 'Verification failed. Please complete a new challenge.' },
            });
          if (outcome === 'limited') return route.fulfill({ status: 429, json: { error: 'rate-limit-exceeded' } });
          if (outcome === 'signed-out')
            return route.fulfill({ status: 401, json: { error: 'Sign in to create a workspace' } });
          return route.fulfill({ status: 202, json: workspace });
        }
        if (path === '/v1/workspaces') return route.fulfill({ json: [] });
        if (path === `/v1/workspace-setups/${workspace.id}`)
          return route.fulfill({ json: { id: workspace.id, stage: 'reserved', error: null } });
        throw new Error(`Unexpected API request ${path}`);
      });
      await page.goto(`${origin}create-workspace`);
      await page
        .getByLabel('Workspace name', { exact: true })
        .fill(workspace.name)
        .catch(async error => {
          throw new Error(
            `${error.message}\nURL: ${page.url()}\n${await page.locator('body').innerText()}\n${errors.join('\n')}`,
          );
        });
      await page.getByRole('alert').waitFor();
      const submit = page.locator('button[type=submit]');
      assert.equal(await submit.isDisabled(), true);
      await page.locator('form').evaluate(form => form.requestSubmit());
      assert.equal(sends.length, 0, 'Keyboard submission cannot bypass missing verification');
      await page.getByRole('button', { name: 'Retry verification' }).click();
      await page.getByRole('alert').waitFor();
      optionsFailure = false;
      await page.getByRole('button', { name: 'Retry verification' }).click();
      await page.getByText('Test verification widget').waitFor();
      assert.equal(await page.evaluate(() => window.challengeAction), 'create_workspace');
      assert.equal(await submit.isDisabled(), true);
      for (const callback of ['expire', 'fail', 'timeout']) {
        await page.evaluate(() => window.challenge.solve());
        await page.getByText('Verification complete.', { exact: true }).waitFor();
        await page.evaluate(callback => window.challenge[callback](), callback);
        await page.getByRole('button', { name: 'Retry verification' }).waitFor();
        assert.equal(await submit.isDisabled(), true);
        await page.getByRole('button', { name: 'Retry verification' }).click();
      }
      await page.evaluate(() => window.challenge.solve());
      await submit.click();
      await page.getByText('Verification failed. Please complete a new challenge.').waitFor();
      assert.equal(await submit.isDisabled(), true);
      assert.equal(await page.getByLabel('Workspace name', { exact: true }).inputValue(), workspace.name);
      assert.equal(await page.getByLabel('Workspace URL', { exact: true }).inputValue(), workspace.slug);
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      outcome = 'limited';
      await page.evaluate(() => window.challenge.solve());
      await submit.click();
      await page.getByText('Too many workspace creation attempts. Please wait before trying again.').waitFor();
      outcome = 'lost';
      await page.evaluate(() => window.challenge.solve());
      await submit.click();
      await page
        .getByText('We couldn’t confirm creation. Your details are still here. Check your connection and try again.')
        .waitFor();
      assert.equal(await submit.isDisabled(), true);
      outcome = 'success';
      await page.evaluate(() => window.challenge.solve());
      await submit.dblclick();
      await page.waitForURL(`**/workspace-setups/${workspace.id}`);
      assert.equal(sends.length, 4, 'Double-click creates one request');
      assert.equal(
        new Set(sends.map(input => input.requestId)).size,
        1,
        'Rejection and lost responses preserve the request ID',
      );
      assert.equal(new Set(sends.map(input => input.challengeToken)).size, 4, 'Each UI retry supplies a fresh token');
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${origin}create-workspace`);
      await page.getByText('Test verification widget').waitFor();
      await page.getByLabel('Workspace name', { exact: true }).fill('Signed out');
      outcome = 'signed-out';
      await page.evaluate(() => window.challenge.solve());
      await submit.click();
      await page.waitForURL('**/login?redirect=%2Fcreate-workspace');
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
