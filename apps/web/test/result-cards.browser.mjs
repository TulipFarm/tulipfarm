import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test(
  'result cards show one, two, and capped five-app stacks with shared Canvas actions',
  { timeout: 120000 },
  async () => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [];
    const remote = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['http:', 'https:'].includes(url.protocol) && url.hostname !== '127.0.0.1') {
        remote.push(url.hostname);
        return route.abort();
      }
      return route.continue();
    });
    const origin = server.resolvedUrls.local[0];
    const cards = page.locator(
      'section[aria-label^="File:"], section[aria-label^="Plan:"], section[aria-label^="Workflow:"]',
    );
    try {
      await page.goto(`${origin}bud-mock/chat/23232323-2323-4323-8323-232323232323?start=result-cards`);
      await page.locator('[data-result-overflow="3"]').waitFor();
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme });
        for (const width of [320, 375, 414, 768, 1440]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.locator('[data-result-overflow="3"]').waitFor();
          assert.equal(await cards.count(), 3);
          assert.equal(await cards.nth(0).locator('[data-result-app]').count(), 1);
          assert.equal(await cards.nth(1).locator('[data-result-app]').count(), 2);
          assert.equal(await cards.nth(2).locator('[data-result-app]').count(), 2);
          assert.deepEqual(
            await cards
              .nth(2)
              .locator('[data-result-app]')
              .evaluateAll(nodes => nodes.map(node => node.dataset.resultApp)),
            ['slack', 'google-sheets'],
          );
          assert.equal(await cards.nth(2).locator('[data-result-overflow]').innerText(), '+3');
          await cards.nth(2).getByRole('button', { name: '3 more apps', exact: true }).waitFor();
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
            `${colorScheme} ${width}: page fits`,
          );
          const stackWidths = await cards
            .getByRole('group', { name: 'Apps used', exact: true })
            .evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
          assert.deepEqual(stackWidths, [36, 66, 96], 'each stack fits its own apps, with equally sized tiles');
          for (const button of await cards
            .getByRole('group', { name: 'Apps used', exact: true })
            .getByRole('button')
            .all()) {
            const bounds = await button.boundingBox();
            assert.deepEqual([bounds.width, bounds.height], [36, 36], 'logos and overflow use the same tile size');
          }
          for (const card of await cards.all()) {
            assert.equal(
              await card.evaluate(node => node.scrollWidth <= node.clientWidth),
              true,
              `${colorScheme} ${width}: card fits`,
            );
            const logos = await card.getByRole('group', { name: 'Apps used', exact: true }).boundingBox();
            const title = await card.getByRole('heading').boundingBox();
            assert.ok(logos.x + logos.width <= title.x, 'logos stay left of the title');
            assert.equal(title.x - logos.x - logos.width, 12, 'text follows its own stack without a reserved column');
            assert.equal(
              await card.getByRole('button', { name: /^View / }).evaluate(node => {
                const range = document.createRange();
                range.selectNodeContents(node);
                return range.getBoundingClientRect().height <= Number.parseFloat(getComputedStyle(node).lineHeight) + 1;
              }),
              true,
              'action stays on one line',
            );
            assert.equal(
              await card.locator('[data-result-app]').evaluateAll(nodes =>
                nodes.every(tile => {
                  const mark = tile.querySelector('[data-brand]').getBoundingClientRect();
                  const next = tile.nextElementSibling?.getBoundingClientRect();
                  return !next || mark.right + 2 <= next.left;
                }),
              ),
              true,
              'stack overlap and rings never cover a logo',
            );
          }
          assert.equal(await page.getByRole('region', { name: 'Canvas', exact: true }).count(), 0);
          await page.screenshot({ path: `/tmp/result-cards-${colorScheme}-${width}.png` });
        }
      }
      assert.match(await cards.nth(1).innerText(), /Presentation saved and email sent/);
      assert.match(await cards.nth(2).innerText(), /Update posted and emailed/);
      for (const [index, app, action] of [
        [0, 'Google Slides', 'Created the investor pitch presentation'],
        [1, 'Google Slides', 'Added the two pitch slides'],
        [1, 'Gmail', 'Sent the investor update email'],
        [2, 'Slack', 'Posted the weekly update'],
        [2, 'Google Sheets', 'Read this week’s figures'],
      ]) {
        const trigger = cards.nth(index).getByRole('button', { name: `${app} actions`, exact: true });
        await trigger.hover();
        const detail = page.getByRole('dialog', { name: `${app} actions`, exact: true });
        await detail.getByText(action, { exact: true }).waitFor();
        await detail.hover();
        assert.equal(await detail.isVisible(), true, 'hover content stays open while reading it');
        await page.keyboard.press('Escape');
        await detail.waitFor({ state: 'hidden' });
      }
      const more = cards.nth(2).getByRole('button', { name: '3 more apps', exact: true });
      await more.hover();
      const moreDetail = page.getByRole('dialog', { name: '3 more apps', exact: true });
      await moreDetail.getByRole('heading', { name: 'GitHub', exact: true }).waitFor();
      await moreDetail.getByText('Saved the weekly update document', { exact: true }).waitFor();
      await moreDetail.getByText('Emailed the weekly summary', { exact: true }).waitFor();
      assert.equal(await moreDetail.getByRole('region').count(), 3);
      await page.keyboard.press('Escape');
      await moreDetail.waitFor({ state: 'hidden' });
      await page.mouse.move(0, 0);
      await more.focus();
      await more.press('Enter');
      await moreDetail.waitFor();
      await page.keyboard.press('Escape');
      await moreDetail.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '3 more apps');
      assert.equal(
        await more.evaluate(node => node === document.activeElement),
        true,
        'Escape returns focus to the app count',
      );
      const canvas = page.getByRole('region', { name: 'Canvas', exact: true });
      for (const [index, title, action, count] of [
        [0, 'Investor pitch', 'View slides', 1],
        [1, 'Prepare the investor update', 'View plan', 2],
        [2, 'Weekly team update', 'View result', 5],
      ]) {
        const button = cards.nth(index).getByRole('button', { name: action, exact: true });
        await button.hover();
        await button.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        assert.equal(await button.evaluate(node => node.matches(':focus-visible')), true);
        await button.press('Enter');
        await canvas.getByRole('heading', { name: title, exact: true }).waitFor();
        assert.equal(
          await canvas.getByRole('region', { name: 'Apps used', exact: true }).getByRole('region').count(),
          count,
        );
        await page.getByRole('button', { name: 'Close canvas', exact: false }).click();
      }
      await page.getByRole('button', { name: 'Show card states' }).click();
      const states = page.getByRole('region', { name: 'Card states' });
      assert.equal(await states.locator('section[aria-label^="File:"]').count(), 8);
      const loading = states.locator('section[aria-busy="true"]');
      assert.equal(await loading.getByRole('button', { name: 'Open in Canvas', exact: true }).isDisabled(), true);
      const unavailable = states.locator('section').filter({ hasText: 'Access unavailable' });
      for (const button of await unavailable.getByRole('button').all()) assert.equal(await button.isDisabled(), true);
      const uncertain = states.locator('section[aria-label^="File:"]').filter({ hasText: 'Save not confirmed' });
      await uncertain.getByRole('button', { name: 'Google Slides actions', exact: true }).click();
      const unknownDetail = page.getByRole('dialog', { name: 'Google Slides actions', exact: true });
      await unknownDetail.getByText('Unconfirmed:', { exact: true }).waitFor();
      assert.doesNotMatch(await unknownDetail.innerText(), /Completed:/);
      await page.keyboard.press('Escape');
      await states.getByRole('button', { name: 'Check status', exact: true }).click();
      await page.getByText('This mock save is still not confirmed. No write was repeated.', { exact: true }).waitFor();
      assert.equal(await canvas.count(), 0, 'unknown save never opens a success result');
      const touch = await browser.newPage({
        viewport: { width: 375, height: 812 },
        hasTouch: true,
        reducedMotion: 'reduce',
      });
      await touch.goto(`${origin}bud-mock/chat/23232323-2323-4323-8323-232323232323?start=result-cards`);
      await touch.locator('[data-result-overflow="3"]').waitFor();
      for (const button of await touch.locator('section[aria-label] > div').getByRole('button').all()) {
        assert.ok((await button.boundingBox()).height >= 44, 'touch action is at least 44px tall');
      }
      await touch.getByRole('button', { name: '3 more apps', exact: true }).tap();
      const touchDetail = touch.getByRole('dialog', { name: '3 more apps', exact: true });
      await touchDetail.getByText('Emailed the weekly summary', { exact: true }).waitFor();
      const bounds = await touchDetail.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 375, 'touch detail stays within the screen');
      await touch.keyboard.press('Escape');
      await touch.getByRole('button', { name: 'View result', exact: true }).click();
      await touch.getByRole('region', { name: 'Canvas', exact: true }).waitFor();
      await touch.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await touch.getByRole('button', { name: 'View result', exact: true }).waitFor();
      await touch.close();
      const tileStyle = node => {
        const style = getComputedStyle(node);
        return Object.fromEntries(
          [
            'width',
            'height',
            'padding',
            'borderWidth',
            'borderColor',
            'borderRadius',
            'backgroundColor',
            'boxShadow',
          ].map(key => [key, style[key]]),
        );
      };
      await page.mouse.move(0, 0);
      const resultTile = await cards
        .nth(0)
        .getByRole('button', { name: 'Google Slides actions', exact: true })
        .evaluate(tileStyle);
      const integrations = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
        colorScheme: 'dark',
        reducedMotion: 'reduce',
      });
      await integrations.goto(`${origin}bud-mock/integrations`);
      const integrationTile = integrations.locator('[data-slot="brand-tile"][data-brand="gmail"]').first();
      await integrationTile.waitFor();
      assert.deepEqual(
        resultTile,
        await integrationTile.evaluate(tileStyle),
        'result tiles match the Integrations page frame exactly',
      );
      await integrations.close();
      assert.deepEqual(remote, []);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
