import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { installTurnstileFixture } from './turnstile-fixture.mjs';

test(
  'workspace registration shows its permanent address and keeps the primary action in view',
  { timeout: 90000 },
  async () => {
    const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    try {
      await installTurnstileFixture(context);
      await context.route('**/v1/auth/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname.endsWith('/get-session')) return route.fulfill({ json: null });
        if (pathname.endsWith('/options'))
          return route.fulfill({ json: { turnstileSiteKey: 'fixture-site-key', google: true, magicLink: true } });
        throw new Error(`Unexpected auth request: ${pathname}`);
      });
      await page.goto(`${origin}/register?redirect=%2F`);
      await page.getByLabel('Workspace name', { exact: true }).fill('Acme Partners');
      await page.getByText(`${origin}/acme-partners`, { exact: true }).waitFor();
      await page.getByLabel('Workspace URL', { exact: true }).fill('acme-team');
      await page.getByText(`${origin}/acme-team`, { exact: true }).waitFor();
      await page.getByText('It cannot be changed after creation.', { exact: true }).waitFor();
      const name = await page.getByLabel('Workspace name', { exact: true }).boundingBox();
      const url = await page.getByLabel('Workspace URL', { exact: true }).boundingBox();
      const submit = await page.getByRole('button', { name: 'Create workspace with email' }).boundingBox();
      assert.equal(name?.y, url?.y);
      assert.ok(
        submit && submit.y + submit.height <= 720,
        `Primary action ends at ${submit ? submit.y + submit.height : 'an unknown position'}px`,
      );
      assert.equal(await page.getByRole('link', { name: 'log in' }).getAttribute('href'), '/login?redirect=%2F');
      const demo = page.locator('aside[aria-hidden="true"]');
      const before = (await demo.boundingBox())?.height ?? 0;
      await demo.evaluate(async aside => {
        document.documentElement.dataset.analyticsConsent = 'open';
        void getComputedStyle(aside).paddingBottom;
        await Promise.all(aside.getAnimations().map(animation => animation.finished));
      });
      const after = (await demo.locator(':scope > *').boundingBox())?.height ?? 0;
      assert.ok(before - after >= 256, `Demo keeps ${after}px of ${before}px beside the consent notice`);
    } finally {
      await context.close();
      await browser.close();
      await server.close();
    }
  },
);

test(
  'login and registration require fresh verification and recover without losing input',
  { timeout: 90000 },
  async () => {
    const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const browser = await chromium.launch({ headless: true });
    try {
      for (const path of ['/login', '/register']) {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          colorScheme: path === '/login' ? 'light' : 'dark',
          reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        await page.clock.install();
        let optionsFailure = true;
        let sendFailure = true;
        let rateLimited = false;
        const sends = [];
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await installTurnstileFixture(context);
        await context.route('**/v1/auth/**', async route => {
          const pathname = new URL(route.request().url()).pathname;
          if (pathname.endsWith('/get-session')) return route.fulfill({ json: null });
          if (pathname.endsWith('/options'))
            return route.fulfill({
              status: optionsFailure ? 503 : 200,
              json: optionsFailure ? {} : { turnstileSiteKey: 'fixture-site-key', google: true, magicLink: true },
            });
          if (pathname.endsWith('/sign-in/magic-link')) {
            sends.push({
              body: route.request().postDataJSON(),
              token: route.request().headers()['x-captcha-response'],
            });
            await new Promise(resolve => setTimeout(resolve, 150));
            return route.fulfill({
              status: rateLimited ? 429 : sendFailure ? 403 : 200,
              json: rateLimited
                ? { code: 'TOO_MANY_REQUESTS', message: 'Wait' }
                : sendFailure
                  ? { code: 'CHALLENGE_FAILED', message: 'Rejected' }
                  : { status: true },
            });
          }
          throw new Error(`Unexpected auth request: ${pathname}`);
        });
        await page.goto(origin + path + '?redirect=%2Facme');
        const submit = page.getByRole('button', {
          name: path === '/login' ? 'Email me a sign-in link' : 'Email me a sign-up link',
        });
        await page.getByLabel('Email', { exact: true }).fill('person@example.com');
        if (path === '/register') await page.getByLabel('Name', { exact: true }).fill('Ada');
        await page.getByRole('alert').waitFor();
        assert.equal(await submit.isDisabled(), true);
        await page.getByRole('button', { name: 'Retry verification' }).click();
        await page.getByRole('alert').waitFor();
        optionsFailure = false;
        await page.getByRole('button', { name: 'Retry verification' }).click();
        await page.getByText('Test verification widget').waitFor();
        assert.equal(await page.evaluate(() => window.challengeAppearance), 'interaction-only');
        assert.equal(await submit.isDisabled(), true);
        await page.evaluate(() => window.challenge.solve());
        await page.getByText('Verification complete.', { exact: true }).waitFor();
        await page.evaluate(() => window.challenge.expire());
        await page.getByText('Verification expired. Please verify again.').waitFor();
        assert.equal(await submit.isDisabled(), true);
        await page.getByRole('button', { name: 'Retry verification' }).click();
        await page.evaluate(() => window.challenge.fail());
        await page.getByRole('alert').waitFor();
        await page.getByRole('button', { name: 'Retry verification' }).click();
        await page.evaluate(() => window.challenge.interact());
        await page.getByText('Complete the verification above to continue.').waitFor();
        await page.evaluate(() => window.challenge.timeout());
        await page.getByRole('button', { name: 'Retry verification' }).click();
        await page.evaluate(() => window.challenge.solve());
        await submit.click();
        await page.getByText('Verification failed. Complete the new challenge and try again.').waitFor();
        await page.getByText('Test verification widget').waitFor();
        assert.equal(await page.getByLabel('Email', { exact: true }).inputValue(), 'person@example.com');
        if (path === '/register') assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Ada');
        assert.equal(await submit.isDisabled(), true);
        sendFailure = false;
        await page.evaluate(() => window.challenge.solve());
        await submit.dblclick();
        await page.getByText('Check your email', { exact: true }).waitFor();
        assert.equal(sends.length, 2, 'Double-click sends only one request');
        assert.notEqual(sends[0].token, sends[1].token);
        assert.equal(sends[1].body.callbackURL, origin + '/acme');
        assert.equal(sends[1].body.name, path === '/register' ? 'Ada' : undefined);
        await page.getByText('Test verification widget').waitFor();
        assert.equal(await page.getByRole('button', { name: /Resend link in/ }).isDisabled(), true);
        await page.clock.runFor(61000);
        assert.equal(await page.getByRole('button', { name: 'Resend sign-in link' }).isDisabled(), true);
        await page.evaluate(() => window.challenge.solve());
        rateLimited = true;
        await page.getByRole('button', { name: 'Resend sign-in link' }).click();
        await page.getByText('Too many attempts. Please wait a minute and try again.').waitFor();
        await page.getByText('person@example.com', { exact: true }).waitFor();
        await page.getByText('Test verification widget').waitFor();
        await page.clock.runFor(61000);
        await page.evaluate(() => window.challenge.solve());
        rateLimited = false;
        await page.getByRole('button', { name: 'Resend sign-in link' }).dblclick();
        await page.getByRole('button', { name: /Resend link in/ }).waitFor();
        assert.equal(sends.length, 4);
        assert.deepEqual(sends[3].body, sends[1].body);
        assert.notEqual(sends[3].token, sends[2].token);
        await page.getByRole('button', { name: 'Use a different email' }).click();
        await page.getByText('Test verification widget').waitFor();
        assert.equal(await submit.isDisabled(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        assert.deepEqual(errors, []);
        await context.close();
      }
      const context = await browser.newContext();
      const page = await context.newPage();
      await context.route('**/v1/auth/get-session', route => route.fulfill({ json: null }));
      await context.route('**/v1/auth/options', route =>
        route.fulfill({ json: { turnstileSiteKey: 'fixture-site-key', google: true, magicLink: true } }),
      );
      await context.route('https://challenges.cloudflare.com/**', route => route.abort());
      await page.goto(origin + '/login');
      await page.getByText('Could not load verification. Check your connection and reload this page.').waitFor();
      assert.equal(await page.getByRole('button', { name: 'Email me a sign-in link' }).isDisabled(), true);
      await page.getByRole('button', { name: 'Reload page' }).click();
      await page.getByText('Could not load verification. Check your connection and reload this page.').waitFor();
      await context.close();
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
