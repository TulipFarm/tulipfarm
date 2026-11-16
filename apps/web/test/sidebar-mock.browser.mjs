import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';

test(
  'sidebar mock has three independent three-item sections under More and keeps normal links',
  { timeout: 120000 },
  async () => {
    const origin = 'http://127.0.0.1:5775';
    const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5775', '--strictPort'], {
      cwd: new URL('..', import.meta.url),
      stdio: 'ignore',
    });
    let browser;
    try {
      for (
        let attempt = 0;
        !(await fetch(origin).then(
          response => response.ok,
          () => false,
        ));
        attempt++
      ) {
        assert.ok(attempt < 150 && server.exitCode === null, 'mock starts');
        await delay(100);
      }
      browser = await chromium.launch();
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1200 },
        colorScheme: 'light',
        reducedMotion: 'reduce',
      });
      const errors = [],
        requests = [];
      page.on('pageerror', error => errors.push(String(error)));
      page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/v1/')) requests.push(request.url());
      });
      // Chats and Agents are plain core links; the sections with recent items sit under More.
      const sections = ['Workflows', 'Tables', 'Files'];
      const nav = page.getByRole('navigation', { name: 'Workspace navigation', exact: true });
      // Sprout's section list is unnamed, so find it inside the menu item that owns the section's toggle.
      const list = label =>
        nav
          .getByRole('listitem')
          .filter({ has: page.getByRole('button', { name: new RegExp(`^(Collapse|Expand) ${label}$`) }) })
          .getByRole('list');
      const open = async (scenario = 'ready') => {
        await page.goto(`${origin}/sidebar-mock/workflows?scenario=${scenario}`);
        await nav.getByRole('button', { name: 'Collapse Workflows', exact: true }).waitFor();
      };
      await open();
      assert.equal(await nav.getByRole('button', { name: 'More', exact: true }).getAttribute('aria-expanded'), 'true');
      const sectionToggle = nav.getByRole('button', { name: 'Collapse Workflows', exact: true });
      // Sprout keeps section chevrons visible rather than revealing them on hover.
      const chevronOpacity = () => sectionToggle.evaluate(element => getComputedStyle(element).opacity);
      await page.mouse.move(1000, 500);
      assert.equal(await chevronOpacity(), '1', 'chevron is visible at rest');
      assert.ok(await sectionToggle.isVisible());
      await nav.getByRole('link', { name: 'Workflows', exact: true }).hover();
      assert.equal(await chevronOpacity(), '1', 'chevron is visible on hover');
      await page.mouse.move(1000, 500);
      await sectionToggle.focus();
      assert.equal(await chevronOpacity(), '1', 'chevron is visible on focus');
      assert.ok(
        await list('Workflows').evaluate(
          element => parseFloat(getComputedStyle(element.parentElement).transitionDuration) <= 0.001,
        ),
        'reduced motion is effectively instant',
      );
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      assert.ok(
        (await list('Workflows').evaluate(element => getComputedStyle(element.parentElement).transitionDuration))
          .split(', ')
          .every(duration => duration === '0.15s'),
        'panel transition is only 150ms',
      );
      await sectionToggle.click();
      await list('Workflows').waitFor({ state: 'hidden' });
      await nav.getByRole('button', { name: 'Expand Workflows', exact: true }).click();
      await list('Workflows').waitFor();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      for (const label of sections) {
        assert.equal(await list(label).getByRole('link').count(), 3, `${label} shows exactly three of four samples`);
        const names = await list(label).getByRole('link').allTextContents();
        assert.ok(
          names.every(name => !name.includes('Earlier')),
          'older fourth item is excluded',
        );
        await nav.getByRole('button', { name: `Collapse ${label}`, exact: true }).click();
        await list(label).waitFor({ state: 'hidden' });
        assert.equal(await nav.getByRole('button', { name: /^Collapse / }).count(), 2, 'only selected section closes');
        const toggle = nav.getByRole('button', { name: `Expand ${label}`, exact: true });
        await toggle.focus();
        await page.keyboard.press('Enter');
        await list(label).waitFor();
        assert.equal(await list(label).getByRole('link').count(), 3);
        await list(label).getByRole('link').first().click();
        await page.getByRole('heading', { name: `Opened ${names[0]}`, exact: true }).waitFor();
        assert.equal(await list(label).getByRole('link').first().getAttribute('aria-current'), 'page');
        await nav.getByRole('link', { name: label, exact: true }).click();
        await page.getByRole('heading', { name: label, exact: true }).waitFor();
      }
      for (const label of ['Chats', 'Agents', 'Integrations']) {
        assert.equal(await nav.getByRole('button', { name: new RegExp(label) }).count(), 0);
        await nav.getByRole('link', { name: label, exact: true }).click();
        await page.getByRole('heading', { name: label, exact: true }).waitFor();
      }
      await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
      await page.locator('[data-sprout-sidebar][data-state="collapsed"]').waitFor();
      assert.deepEqual(
        await nav.locator('[aria-expanded]:visible').allTextContents(),
        ['More'],
        'icon rail hides section expansion controls and keeps only More',
      );
      // Base UI unmounts the closing panels a frame after the rail state changes.
      await nav.locator('.sprout-sidebar-sub-button').first().waitFor({ state: 'hidden' });
      assert.equal(await nav.locator('.sprout-sidebar-sub-button:visible').count(), 0);
      await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
      await page.locator('[data-sprout-sidebar][data-state="expanded"]').waitFor();
      await nav.locator('.sprout-sidebar-sub-button').nth(8).waitFor();
      assert.equal(await nav.locator('.sprout-sidebar-sub-button:visible').count(), 9, 'expansions survive icon mode');

      await open('slow');
      await page.getByRole('status', { name: 'Loading recent workflows' }).waitFor();
      assert.equal(await list('Workflows').getByRole('link').count(), 0);
      assert.equal(await page.getByText(/No recent items yet/).count(), 0, 'no empty flash');
      await list('Workflows').getByRole('link').first().waitFor();
      await open('empty');
      assert.equal(await nav.getByText(/No recent items yet/).count(), 3);
      assert.equal(await nav.locator('.sprout-sidebar-sub-button').count(), 0);
      await nav.getByRole('link', { name: 'Tables', exact: true }).click();
      await page.getByRole('heading', { name: 'Tables', exact: true }).waitFor();
      await open('error');
      assert.equal(await nav.getByRole('alert').count(), 3);
      await list('Workflows').getByRole('button', { name: 'Try again', exact: true }).click();
      assert.equal(await list('Workflows').getByRole('link').count(), 3);
      assert.equal(await nav.getByRole('alert').count(), 2, 'retry only changes its own section');

      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme });
        for (const width of [320, 375, 768, 1440]) {
          await page.setViewportSize({ width, height: 1200 });
          await page.goto(`${origin}/sidebar-mock/workflows?scenario=long`);
          await page.getByRole('heading', { name: 'Workflows', exact: true }).waitFor();
          if (width < 768) await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
          await list('Workflows').getByRole('link').first().waitFor();
          assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            `no overflow at ${width}`,
          );
          assert.ok(
            await list('Workflows')
              .getByRole('link')
              .first()
              .locator('span.truncate')
              .evaluate(element => element.scrollWidth > element.clientWidth),
            'long names truncate',
          );
          await nav.getByRole('link', { name: 'Integrations', exact: true }).scrollIntoViewIfNeeded();
          if (width < 768) {
            await nav.getByRole('link', { name: 'Integrations', exact: true }).click();
            await page.getByRole('dialog', { name: 'Workspace sidebar' }).waitFor({ state: 'hidden' });
          }
        }
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(requests, [], 'no mock account or workspace request reaches the network');
      const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await touch.goto(`${origin}/sidebar-mock/workflows`);
      await touch.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
      const touchToggle = touch.getByRole('button', { name: 'Collapse Workflows', exact: true });
      await touchToggle.waitFor();
      assert.equal(
        await touchToggle.evaluate(element => getComputedStyle(element).opacity),
        '1',
        'touch has visible chevrons without hover',
      );
      assert.ok((await touchToggle.boundingBox()).height >= 44, 'touch target is at least 44px');
    } finally {
      await browser?.close();
      server.kill('SIGTERM');
    }
  },
);
