import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test('chat list keeps clear columns, responsive actions, filters, and recovery', { timeout: 120000 }, async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = server.resolvedUrls.local[0];
  const open = async scenario => {
    await page.goto(`${origin}bud-mock/chat?start=${scenario}`);
    await page.waitForLoadState('networkidle');
  };
  const table = page.getByRole('table', { name: 'Chats', exact: true });
  const firstTitle = 'Prepare the weekly customer update';
  const first = page.getByRole('button', { name: firstTitle, exact: true });
  const menu = title => page.getByRole('button', { name: `More actions for ${title}`, exact: true });
  try {
    await open('chats');
    await first.waitFor();
    assert.equal(await table.getByRole('row').count(), 13);
    assert.equal((await table.locator('time').first().getAttribute('dateTime')) !== null, true);
    assert.match(await table.locator('time').first().innerText(), /Today\s+\d/);
    assert.equal(await page.getByRole('group', { name: 'Chat filters', exact: true }).count(), 1);

    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const width of [320, 375, 414, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await open('chats');
        await first.waitFor();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const geometry = await table.evaluate(element => {
          const row = element.querySelector('[data-slot="data-list-row"]');
          const action = row.querySelector('[data-slot="data-list-actions"]');
          const title = row.querySelector('[data-slot="data-list-link"]').getBoundingClientRect();
          const time = row.querySelector('time').getBoundingClientRect();
          return {
            overflow: document.documentElement.scrollWidth > innerWidth || element.scrollWidth > element.clientWidth,
            grid: getComputedStyle(row).gridTemplateColumns,
            tracks: getComputedStyle(row).gridTemplateColumns.split(' ').length,
            rightGap: row.getBoundingClientRect().right - action.getBoundingClientRect().right,
            metadataLeftGap: Math.abs(time.left - title.left),
            metadataTopGap: time.top - title.bottom,
          };
        });
        assert.equal(geometry.overflow, false, `${colorScheme} ${width}: no horizontal overflow`);
        assert.equal(
          geometry.tracks,
          2,
          `${colorScheme} ${width}: only chat and action tracks (${JSON.stringify(geometry)})`,
        );
        assert.ok(geometry.rightGap <= 10, `${colorScheme} ${width}: actions at the row edge`);
        assert.ok(geometry.metadataLeftGap <= 1, `${colorScheme} ${width}: date aligns with title`);
        assert.ok(
          geometry.metadataTopGap >= 0 && geometry.metadataTopGap <= 8,
          `${colorScheme} ${width}: date sits directly below title`,
        );
      }
    }

    await page.setViewportSize({ width: 375, height: 500 });
    await open('chats');
    const lastMenu = menu('Review the customer handoff process');
    await lastMenu.waitFor();
    await page.getByRole('button', { name: 'Open Bud', exact: true }).waitFor();
    await lastMenu.scrollIntoViewIfNeeded();
    const lastBox = await lastMenu.boundingBox();
    const budBox = await page.getByRole('button', { name: 'Open Bud', exact: true }).boundingBox();
    assert.ok(lastBox.y + lastBox.height <= budBox.y, 'Last action can scroll clear of Bud');
    await menu(firstTitle).scrollIntoViewIfNeeded();
    await menu(firstTitle).click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.getByRole('textbox', { name: 'Chat title', exact: true }).fill('Customer update draft');
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      'Rename fits mobile',
    );
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Customer update draft', exact: true }).waitFor();

    await menu('Customer update draft').click();
    await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByRole('button', { name: 'Customer update draft', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Archived chats', exact: true }).click();
    await page.getByRole('button', { name: 'Last quarter’s planning notes', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Active chats', exact: true }).click();
    await page.getByLabel('Search chat titles').fill('no matching title');
    await page.getByRole('heading', { name: 'No matching chats', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Clear search', exact: true }).first().click();
    await page.getByRole('button', { name: 'Customer update draft', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Show chats from: Personal chats', exact: true }).click();
    await page.getByRole('option', { name: 'Product launch', exact: true }).click();
    await page.getByRole('button', { name: 'Launch readiness review', exact: true }).waitFor();
    assert.equal(
      await page
        .getByText('Shared with everyone in Product launch. Most recently active first.', { exact: true })
        .count(),
      1,
    );
    assert.equal(await table.locator('[data-slot="data-list-row"]').count(), 1, 'Project scope hides personal chats');

    await open('chats');
    await first.waitFor();
    await menu(firstTitle).click();
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Keep chat', exact: true }).click();
    assert.equal(await first.count(), 1);
    await menu(firstTitle).click();
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Delete chat', exact: true }).click();
    await first.waitFor({ state: 'detached' });
    await open('chats-error');
    await page.getByRole('heading', { name: 'Could not load chats', exact: true }).waitFor();
    // Cloud 1f8cf59a (#1028): the demo fails the first three list reads (chats-mock-api.ts:48); the page makes two, so the first retry fails too.
    const retry = page.getByRole('button', { name: 'Retry loading chats', exact: true });
    await retry.click();
    await page.getByRole('heading', { name: 'Could not load chats', exact: true }).waitFor();
    await retry.click();
    await first.waitFor();
    await open('chats-empty');
    await page.getByRole('heading', { name: 'No chats yet', exact: true }).waitFor();
    // The demo holds the list read for 2s in the page (chats-mock-api.ts:47); waiting for network idle can outlast it.
    await page.goto(`${origin}bud-mock/chat?start=chats-loading`);
    await page.getByRole('status', { name: 'Loading chats', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'No chats yet', exact: true }).count(), 0);
    await first.waitFor();
    await first.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({ path: '/tmp/chats-list-test-failure.png' });
    throw error;
  } finally {
    await browser.close();
    await server.close();
  }
});
