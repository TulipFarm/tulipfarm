import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

test(
  'web activity shows queries, titled chips, page reads, and safe favicon fallbacks',
  { timeout: 120000 },
  async () => {
    const origin = process.env.WEB_ACTIVITY_ORIGIN ?? 'http://127.0.0.1:5869';
    const server = process.env.WEB_ACTIVITY_ORIGIN
      ? null
      : spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5869', '--strictPort'], {
          cwd: new URL('..', import.meta.url),
          stdio: 'ignore',
        });
    const screenshots = process.env.WEB_ACTIVITY_SCREENSHOTS;
    let browser;
    let page;
    const releaseIcon = Promise.withResolvers();
    try {
      for (
        let attempt = 0;
        !(await fetch(origin).then(
          response => response.ok,
          () => false,
        ));
        attempt++
      ) {
        assert.ok(attempt < 150 && (!server || server.exitCode === null), 'Vite starts');
        await delay(100);
      }
      browser = await chromium.launch();
      page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
        colorScheme: 'light',
        reducedMotion: 'reduce',
      });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://icon.horse/**', async route => {
        const headers = await route.request().allHeaders();
        assert.equal(headers.referer, undefined);
        assert.equal(headers.cookie, undefined);
        if (route.request().url().endsWith('example.com')) return route.abort();
        if (route.request().url().endsWith('github.com')) await releaseIcon.promise;
        return route.fulfill({
          contentType: 'image/svg+xml',
          headers: { 'access-control-allow-origin': '*' },
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#146c2f"/></svg>',
        });
      });
      await page.goto(`${origin}/canvas-mock/chat/11111111-1111-4111-8111-111111111111?scenario=web`);
      // Cloud 856d6a73 #1026 keeps tool progress in the transcript; its activity list opens from the progress line
      // (features/chat/private-conversations.tsx:397, cloud ui tool-activity.tsx:155-166).
      const canvas = page.getByRole('region', { name: 'Conversation', exact: true });
      await canvas.getByRole('button', { name: /^Working… Searching the web/ }).click();
      const step = index =>
        canvas.locator(`[data-tool-id="99999999-9999-4999-8999-${String(index).padStart(12, '0')}"]`);
      await step(6).getByText('Searching the web', { exact: true }).waitFor();
      await step(5).getByText('Reading a web page', { exact: true }).waitFor();
      assert.equal(
        await step(6).locator('[data-slot="web-search-query"]').innerText(),
        'keyboard navigation testing checklist',
      );
      assert.equal(
        await step(1).locator('[data-slot="web-search-query"]').innerText(),
        'web accessibility testing guides',
      );
      assert.equal(await step(1).locator('[data-slot="source-chip"]').count(), 4);
      await step(1).getByRole('link', { name: 'Accessibility | MDN', exact: true }).scrollIntoViewIfNeeded();
      assert.equal(
        await step(1)
          .getByRole('link', { name: 'Playwright on GitHub' })
          .locator('[data-slot="source-favicon"]')
          .getAttribute('data-status'),
        'loading',
      );
      releaseIcon.resolve();
      await step(1).locator('[data-slot="source-favicon"][data-status="loaded"]').first().waitFor();
      await step(4).locator('[data-slot="source-favicon"][data-status="failed"]').waitFor();
      assert.equal(await step(4).locator('[data-slot="source-favicon"] img').count(), 0);
      assert.equal(await step(4).locator('[data-slot="source-favicon"]').innerText(), 'E');
      await step(3).getByText('No usable results. Try a different search.', { exact: true }).waitFor();
      await step(4).getByText('Page read failed', { exact: true }).waitFor();
      assert.equal(
        await step(5).locator('[data-slot="source-chip"]').innerText(),
        'w3.org/WAI/standards-guidelines/wcag/',
      );
      const more = step(1).getByRole('button', { name: '2 more', exact: true });
      await more.focus();
      await page.keyboard.press('Enter');
      assert.equal(await step(1).locator('[data-slot="source-chip"]').count(), 6);
      const fallback = step(1).locator('[data-slot="source-chip"]').last();
      assert.ok((await fallback.getAttribute('href')).includes('?reference=web-search-example'));
      assert.ok(
        await fallback
          .locator('span')
          .last()
          .evaluate(element => element.scrollWidth > element.clientWidth),
        'long URL is visually truncated',
      );
      await step(1).getByRole('button', { name: 'Show fewer sources', exact: true }).click();
      await page.getByRole('button', { name: 'Complete read', exact: true }).click();
      await step(5).getByText('Read a web page', { exact: true }).waitFor();
      await step(5).getByRole('link', { name: 'Web Content Accessibility Guidelines', exact: true }).waitFor();
      await step(6).getByText('Searched the web', { exact: true }).waitFor();
      assert.equal(await canvas.getByText('Searching the web', { exact: true }).count(), 0);
      for (const width of [1440, 768, 414, 375, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const colorScheme of ['light', 'dark']) {
          await page.emulateMedia({ colorScheme });
          await canvas.waitFor();
          await step(1).getByRole('link', { name: 'Accessibility | MDN', exact: true }).scrollIntoViewIfNeeded();
          assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            `${width}/${colorScheme}: no horizontal page overflow`,
          );
          assert.ok(
            await canvas.evaluate(element => element.scrollWidth <= element.clientWidth),
            `${width}/${colorScheme}: no Canvas overflow`,
          );
          const chips = await canvas.locator('[data-slot="source-chip"]').evaluateAll(elements =>
            elements.map(element => {
              const label = element.querySelector('span:nth-child(2)');
              const icon = element.querySelector('[data-slot="source-favicon"] img');
              const style = getComputedStyle(label);
              return {
                labelHeight: label.clientHeight,
                lineHeight: parseFloat(style.lineHeight),
                overflow: style.textOverflow,
                iconWidth: icon?.clientWidth,
              };
            }),
          );
          assert.ok(chips.every(chip => chip.labelHeight <= chip.lineHeight && chip.overflow === 'ellipsis'));
          assert.ok(chips.filter(chip => chip.iconWidth).every(chip => chip.iconWidth === 14));
          if (screenshots) {
            await mkdir(screenshots, { recursive: true });
            await page.screenshot({ path: `${screenshots}/web-${width}-${colorScheme}.png` });
          }
        }
      }
      assert.deepEqual(errors, []);
    } catch (error) {
      if (page) {
        await page.screenshot({ path: '/tmp/web-activity-failure.png' });
        console.error(await page.locator('body').innerText());
        console.error(
          await page.locator('[data-tool-id]').evaluateAll(elements =>
            elements.map(element => ({
              id: element.dataset.toolId,
              hidden: element.closest('[aria-hidden="true"], [inert]')?.outerHTML.slice(0, 300),
            })),
          ),
        );
        console.error('Canvas regions', await page.getByRole('region', { name: 'Canvas', exact: true }).count());
      }
      throw error;
    } finally {
      releaseIcon.resolve();
      await browser?.close();
      server?.kill('SIGTERM');
    }
  },
);
