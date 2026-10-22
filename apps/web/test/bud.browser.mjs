import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startBudDemo } from './bud-demo.mjs';

test(
  'Bud in the real chat follows model events, completion, cancellation, and mobile reduced motion',
  { timeout: 120000 },
  async () => {
    let callbacks, finish;
    const socket = createServer().listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const demo = await startBudDemo({
      port,
      respond: async (_messages, controls) => {
        callbacks = controls;
        controls.avatar.update({ step: 0, avatar: { name: 'Bud', state: 'Thinking' } });
        return new Promise(resolve => {
          finish = resolve;
        });
      },
    });
    const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
      page.setDefaultTimeout(30000);
      // The Bud launcher sits bottom-right over Send on mobile; move it as a user would by dragging.
      await page.addInitScript(() => localStorage.setItem('tulipfarm:bud-corner', 'bottom-left'));
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/src/components/tulip-avatar/runtime.ts*', async route => {
        await new Promise(resolve => setTimeout(resolve, 3500));
        await route.continue();
      });
      await page.goto(`${demo.origin}/bud-demo`);
      // Cloud bud-provider.tsx:228 (5c797036 #982) adds a second Bud avatar to the Bud launcher. The chat portrait sits beside the
      // welcome heading, then beside the chat title once messages exist (cloud private-conversations.tsx:380,394, 920f8d83 #1024).
      const avatar = page.locator('[data-bud-state] [data-slot="tulip-avatar"]');
      const assertPlainAvatar = async () => {
        await page.waitForFunction(() => {
          const element = document.querySelector('[data-bud-state] [data-slot="tulip-avatar"]');
          return (
            element?.getAttribute('data-status') === 'ready' &&
            getComputedStyle(element).backgroundColor === 'rgba(0, 0, 0, 0)'
          );
        });
        assert.equal(await page.locator('[data-bud-state]').innerText(), '', 'no visible name or state caption');
        assert.equal(
          await avatar.locator('canvas').evaluate(canvas => canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3]),
          0,
          'rendered canvas has no background',
        );
      };
      const assertHeaderAlignment = async () => {
        const portrait = await avatar.boundingBox();
        const title = await page.getByRole('heading', { level: 1 }).boundingBox();
        assert.ok(
          Math.abs(portrait.y + portrait.height / 2 - title.y - title.height / 2) < 1,
          'avatar and title are vertically centered',
        );
        assert.equal(title.x - portrait.x - portrait.width, 8, 'avatar sits directly beside the title');
      };
      await avatar.locator('canvas[aria-busy="false"]').waitFor();
      assert.equal(
        await avatar.getAttribute('data-state'),
        'Waving',
        'the greeting waits for graphics to load before counting down',
      );
      assert.equal(
        await page.locator('div:has(> div > h2) > [data-bud-state] [data-slot="tulip-avatar"]').count(),
        1,
        'Bud sits beside the welcome, not in the top bar',
      );
      assert.equal(await avatar.count(), 1);
      assert.equal(await page.locator('[data-slot="tulip-avatar"]').count(), 2);
      assert.equal(
        await page.getByRole('button', { name: 'Open Bud', exact: true }).locator('[data-slot="tulip-avatar"]').count(),
        1,
        'the only other Bud is the launcher',
      );
      await assertPlainAvatar();
      assert.equal((await avatar.boundingBox()).width, 64);
      await page.locator('[data-bud-state="Idle"]').waitFor();
      assert.equal(await avatar.getAttribute('data-character'), 'Bud');
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Solve 18 times 24');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.locator('[data-bud-state="Thinking"]').waitFor();
      await page.getByRole('button', { name: 'Stop reply', exact: true }).waitFor();
      callbacks.avatar.update({ step: 0, avatar: { name: 'Bud', state: 'Solving' } });
      await page.locator('[data-bud-state="Solving"]').waitFor();
      callbacks.answerText({ step: 1, text: '18 times 24 is 432.' });
      await page.getByText('18 times 24 is 432.', { exact: true }).waitFor();
      callbacks.avatar.update({ step: 1, avatar: { name: 'Bud', state: 'Celebrating' } });
      finish({ text: '18 times 24 is 432.', avatar: { name: 'Bud', state: 'Celebrating' } });
      await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
      await page.locator('[data-bud-state="Celebrating"]').waitFor();
      assert.equal(await page.getByText('18 times 24 is 432.', { exact: true }).count(), 1);
      assert.equal(await avatar.getAttribute('data-status'), 'ready');
      await assertPlainAvatar();
      await assertHeaderAlignment();
      if (process.env.BUD_SCREENSHOT) await page.screenshot({ path: process.env.BUD_SCREENSHOT });

      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 375, height: 812 });
      await assertPlainAvatar();
      await assertHeaderAlignment();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Read this');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.locator('[data-bud-state="Thinking"]').waitFor();
      await page.getByRole('button', { name: 'Stop reply', exact: true }).waitFor();
      callbacks.avatar.update({ step: 0, avatar: { name: 'Bud', state: 'Reading' } });
      await page.locator('[data-bud-state="Reading"]').waitFor();
      const image = () => avatar.locator('canvas').evaluate(canvas => canvas.toDataURL());
      await page.waitForTimeout(200);
      const still = await image();
      await page.waitForTimeout(250);
      assert.equal(await image(), still, 'reduced motion holds a static pose');
      await page.getByRole('button', { name: 'Stop reply', exact: true }).click();
      await page.locator('[data-bud-state="Idle"]').waitFor();
      callbacks.avatar.update({ step: 1, avatar: { name: 'Bud', state: 'Celebrating' } });
      finish({ text: 'Late answer must be ignored.' });
      await page.waitForTimeout(200);
      assert.equal(await avatar.getAttribute('data-state'), 'Idle');
      assert.equal(await page.getByText('Late answer must be ignored.', { exact: true }).count(), 0);
      await page.reload();
      await page.locator('[data-bud-state="Idle"]').waitFor();
      await page.goto(`${demo.origin}/bud-demo`);
      await avatar.locator('canvas[aria-busy="false"]').waitFor();
      assert.equal(await avatar.getAttribute('data-state'), 'Waving');
      const welcomeStill = await image();
      await page.waitForTimeout(250);
      assert.equal(await image(), welcomeStill, 'reduced-motion welcome does not animate');
      await page.locator('[data-bud-state="Idle"]').waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await demo.close();
    }
  },
);
