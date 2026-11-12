import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startBudDemo } from './bud-demo.mjs';

test(
  'Bud in the real chat shows its monster through completion, cancellation, and mobile',
  { timeout: 120000 },
  async () => {
    let finish;
    const socket = createServer().listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    let callbacks;
    const demo = await startBudDemo({
      port,
      respond: async (_messages, controls) => {
        callbacks = controls;
        return new Promise(resolve => {
          finish = resolve;
        });
      },
    });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
      page.setDefaultTimeout(30000);
      // The Bud launcher sits bottom-right over Send on mobile; move it as a user would by dragging.
      await page.addInitScript(() => localStorage.setItem('tulipfarm:bud-corner', 'bottom-left'));
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${demo.origin}/bud-demo`);
      const monsters = page.locator('[data-slot="monster-avatar"]');
      const launcher = page.getByRole('button', { name: /Open quick chat$/ }).locator('[data-slot="monster-avatar"]');
      const portrait = monsters.and(page.locator(':not(button) > span > [data-slot="monster-avatar"]'));
      await page.getByRole('heading', { level: 2 }).waitFor();
      assert.equal(await monsters.count(), 2, 'the welcome Bud and the launcher Bud');
      assert.equal(await launcher.count(), 1);
      assert.equal((await portrait.boundingBox()).width, 64);
      assert.equal(await page.locator('canvas').count(), 0, 'Bud draws no canvas');
      const assertHeaderAlignment = async () => {
        const box = await portrait.boundingBox();
        const title = await page.getByRole('heading', { level: 1 }).boundingBox();
        assert.ok(
          Math.abs(box.y + box.height / 2 - title.y - title.height / 2) < 1,
          'avatar and title are vertically centered',
        );
      };

      await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Solve 18 times 24');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.getByRole('button', { name: 'Stop reply', exact: true }).waitFor();
      callbacks.answerText({ step: 1, text: '18 times 24 is 432.' });
      await page.getByText('18 times 24 is 432.', { exact: true }).waitFor();
      finish({ text: '18 times 24 is 432.' });
      await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
      assert.equal(await page.getByText('18 times 24 is 432.', { exact: true }).count(), 1);
      assert.equal((await portrait.boundingBox()).width, 40);
      await assertHeaderAlignment();
      if (process.env.BUD_SCREENSHOT) await page.screenshot({ path: process.env.BUD_SCREENSHOT });

      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 375, height: 812 });
      await assertHeaderAlignment();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Read this');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.getByRole('button', { name: 'Stop reply', exact: true }).click();
      await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
      finish({ text: 'Late answer must be ignored.' });
      await page.waitForTimeout(200);
      assert.equal(await page.getByText('Late answer must be ignored.', { exact: true }).count(), 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await demo.close();
    }
  },
);
