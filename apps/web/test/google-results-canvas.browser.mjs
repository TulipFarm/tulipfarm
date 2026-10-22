import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test(
  'Google presentation results keep the exact draft, approval and saved state together in Canvas',
  { timeout: 240000 },
  async () => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const browser = await chromium.launch({ headless: process.env.CHAT_BROWSER_HEADED !== '1' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(15000);
    const errors = [];
    const writes = [];
    const external = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://*.google.com/**', route => {
      external.push(route.request().url());
      return route.abort();
    });
    await page.addInitScript(() => {
      window.demoGoogleWrites = [];
      const original = window.fetch.bind(window);
      Object.defineProperty(window, 'fetch', {
        configurable: true,
        get() {
          return this.demoFetch ?? original;
        },
        set(value) {
          this.demoFetch = async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
            const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
            if (method === 'POST' && /\/operations\/proposals\/[^/]+\/(decision|execute)$/.test(url.pathname))
              window.demoGoogleWrites.push(url.pathname.split('/').at(-1));
            return value(input, init);
          };
        },
      });
    });
    const origin = server.resolvedUrls.local[0];
    const canvas = page.getByRole('region', { name: 'Canvas', exact: true });
    const card = page.getByRole('region', { name: 'Google action card', exact: true });
    const open = async (scenario = 'slides') => {
      await page.goto(`${origin}bud-mock/chat/23232323-2323-4323-8323-232323232323?start=${scenario}`);
      await page.getByRole('form', { name: 'Message composer' }).waitFor();
    };
    const review = async () => {
      await card.getByRole('button', { name: /^(Review|Open) in Canvas$/ }).click();
      await canvas.getByRole('heading', { name: 'TulipFarm — investor pitch draft', exact: true }).waitFor();
    };
    try {
      for (const colorScheme of ['light', 'dark']) {
        for (const width of [320, 375, 414, 768, 1440]) {
          await page.emulateMedia({ colorScheme });
          await page.setViewportSize({ width, height: 1000 });
          await open();
          await card.getByRole('button', { name: /^(Review|Open) in Canvas$/ }).waitFor();
          assert.equal(await canvas.count(), 0, 'passive result arrival does not open Canvas');
          assert.doesNotMatch(await card.innerText(), /Mime Type|application\/|digest|payload/);
          await page
            .getByRole('region', { name: 'Plan: Understand the pitch and prepare a draft' })
            .getByText('Plan complete', { exact: true })
            .waitFor();
          await review();
          await page
            .frameLocator('iframe')
            .getByText('Your business operations, in one conversation.', { exact: false })
            .waitFor();
          assert.doesNotMatch(
            await page.frameLocator('iframe').locator('body').innerText(),
            /Reading view\./,
            'the real PPTX slide renderer works, not just the fallback',
          );
          assert.doesNotMatch(await canvas.innerText(), /application\/|Approval digest|Exact payload/);
          assert.equal(
            await canvas.getByRole('button', { name: /Approve/ }).isDisabled(),
            true,
            'approval starts unchecked',
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
            `${colorScheme} ${width}: no page overflow`,
          );
          assert.equal(
            await canvas.getByRole('button', { name: /needs your review.*Back to chat/ }).count(),
            0,
            'review is already in Canvas',
          );
          if (width < 768) {
            await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
            await card.getByRole('button', { name: /^(Review|Open) in Canvas$/ }).click();
            await canvas.getByRole('heading', { name: 'TulipFarm — investor pitch draft', exact: true }).waitFor();
          }
        }
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await open();
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this draft while I review.');
      await review();
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        canvas.getByRole('link', { name: /Download/ }).click(),
      ]);
      assert.equal(download.suggestedFilename(), 'TulipFarm — investor pitch draft.pptx');
      const archive = await JSZip.loadAsync(await readFile(await download.path()));
      assert.match(
        await archive.file('ppt/slides/slide1.xml').async('string'),
        /Your business operations, in one conversation\./,
      );
      await canvas.getByRole('button', { name: 'Details', exact: true }).click();
      await canvas.getByText('Approval digest', { exact: true }).waitFor();
      await canvas.getByRole('button', { name: 'Details', exact: true }).click();
      await canvas.getByRole('checkbox').check();
      await canvas.getByRole('button', { name: /Approve/ }).click();
      await canvas.getByRole('button', { name: 'Save approved action to Google', exact: true }).waitFor();
      assert.equal(
        await canvas.getByRole('link', { name: 'Open in Google Slides', exact: true }).count(),
        0,
        'approval alone does not claim a saved file',
      );
      await canvas.getByRole('button', { name: 'Save approved action to Google', exact: true }).click();
      await canvas.getByText('Saved in Google Slides', { exact: true }).waitFor();
      await card.getByText('Saved in Google Slides', { exact: true }).waitFor();
      const saved = canvas.getByRole('link', { name: 'Open in Google Slides', exact: true });
      assert.equal(await saved.getAttribute('href'), 'https://docs.google.com/presentation/d/local-demo-pitch/edit');
      assert.equal(
        await canvas.getByRole('button', { name: /Approve|Execute|Save approved/ }).count(),
        0,
        'success offers no repeat write',
      );
      writes.push(...(await page.evaluate(() => window.demoGoogleWrites)));
      assert.deepEqual(writes, ['decision', 'execute'], 'one decision and one execution');
      assert.equal(
        await page.getByRole('textbox', { name: 'Message', exact: true }).innerText(),
        'Keep this draft while I review.',
      );

      for (const scenario of ['slides-expired', 'slides-unknown', 'slides-failed', 'slides-saving']) {
        await open(scenario);
        await review();
        assert.equal(
          await canvas.getByRole('button', { name: /Approve|Execute|Save approved/ }).count(),
          0,
          `${scenario}: no replay`,
        );
        assert.equal(
          await canvas.getByRole('link', { name: 'Open in Google Slides', exact: true }).count(),
          0,
          `${scenario}: no claimed saved file`,
        );
        if (scenario === 'slides-unknown') assert.match(await canvas.innerText(), /not confirmed|unknown/i);
        if (scenario === 'slides-expired') assert.match(await canvas.innerText(), /expired/i);
        await canvas.getByRole('button', { name: /Check .*status/ }).click();
        assert.deepEqual(await page.evaluate(() => window.demoGoogleWrites), [], 'status recovery never writes');
      }
      await open('slides-send-error');
      await review();
      await canvas.getByRole('checkbox').check();
      await canvas.getByRole('button', { name: /Approve/ }).click();
      await canvas.getByRole('button', { name: 'Save approved action to Google', exact: true }).click();
      await canvas
        .getByText(/Outcome unknown|Save not confirmed/)
        .first()
        .waitFor();
      assert.match(await card.innerText(), /not confirmed|unknown/i, 'chat and Canvas agree on a lost response');
      await canvas.getByRole('button', { name: /Check .*status/ }).click();
      assert.deepEqual(
        await page.evaluate(() => window.demoGoogleWrites),
        ['decision', 'execute'],
        'uncertain recovery never resends',
      );
      await open('slides-denied');
      await card.getByRole('heading', { name: 'Google action unavailable', exact: true }).waitFor();
      assert.equal(
        await card.getByRole('button', { name: /Review|Open in Canvas/ }).count(),
        0,
        'denied data cannot be opened',
      );
      await open('slides-error');
      await card.getByRole('button', { name: 'Reload Google action', exact: true }).click();
      await card.getByRole('button', { name: 'Review in Canvas', exact: true }).waitFor();
      await open('slides-files');
      await page.getByText('Saved in Files', { exact: true }).first().waitFor();
      await page
        .getByRole('region', { name: 'File: Pitch notes.md', exact: true })
        .getByRole('button', { name: 'View file', exact: true })
        .click();
      await canvas.getByRole('heading', { name: 'Pitch notes', exact: true }).waitFor();
      await page.getByText('Pitch source.pptx', { exact: true }).click();
      await canvas.getByRole('heading', { name: 'Pitch source.pptx', exact: true }).waitFor();
      await page
        .frameLocator('iframe')
        .getByText('Your business operations, in one conversation.', { exact: false })
        .waitFor();
      assert.equal(page.context().pages().length, 1, 'both file types open in Canvas, not another tab');
      await open('slides-empty');
      assert.equal(await card.count(), 0);
      assert.equal(await canvas.count(), 0);
      assert.deepEqual(external, [], 'the seeded demo makes no live Google calls');
      assert.deepEqual(errors, []);
    } catch (error) {
      console.error(
        'Google result failure',
        { url: page.url(), viewport: page.viewportSize(), errors },
        await page.locator('body').innerText(),
      );
      console.error(
        'Frame text',
        await Promise.all(
          page
            .frames()
            .slice(1)
            .map(frame =>
              frame
                .locator('body')
                .innerText()
                .catch(() => 'Frame unavailable'),
            ),
        ),
      );
      await page.screenshot({ path: '/tmp/google-results-canvas-failure.png' });
      throw error;
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
