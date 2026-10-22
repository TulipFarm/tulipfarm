import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

test(
  'chat owns activity and results; detailed views open only on request without losing work',
  { timeout: 240000 },
  async () => {
    const port = process.env.CANVAS_STEPPER_PORT ?? '5853';
    const cdp = process.env.CANVAS_STEPPER_CDP_PORT;
    const origin = process.env.CANVAS_STEPPER_ORIGIN ?? `http://127.0.0.1:${port}`;
    const screenshots =
      process.env.CANVAS_STEPPER_SCREENSHOTS ??
      new URL('../../../reports/check/chat-results/', import.meta.url).pathname;
    const server = process.env.CANVAS_STEPPER_ORIGIN
      ? null
      : spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', port, '--strictPort'], {
          cwd: new URL('..', import.meta.url),
          stdio: 'ignore',
        });
    let browser;
    let page;
    let currentScenario;
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
      browser = await chromium.launch({ args: cdp ? [`--remote-debugging-port=${cdp}`] : [] });
      page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      // Leaving a chat with an unsent draft asks to confirm (cloud private-conversations.tsx:377); switching scenarios leaves on purpose.
      // Chromium may finish the navigation before the accept arrives, which reports "No dialog is showing".
      page.on('dialog', dialog =>
        (dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()).catch(error => {
          if (!String(error).includes('No dialog is showing')) throw error;
        }),
      );
      const load = async scenario => {
        currentScenario = scenario;
        await page.goto(`${origin}/canvas-mock/chat/11111111-1111-4111-8111-111111111111?scenario=${scenario}`);
        await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
      };
      const canvas = () => page.getByRole('region', { name: 'Canvas', exact: true });
      const conversation = () => page.getByRole('region', { name: 'Conversation', exact: true });
      const composer = () => page.getByRole('textbox', { name: 'Message', exact: true });
      const complete = () => page.keyboard.press('Control+Shift+Enter');
      const expand = async () => {
        await conversation().locator('[data-slot="tool-activity"] > button').first().waitFor();
        const collapsed = conversation().locator('[data-slot="tool-activity"] > button[aria-expanded="false"]');
        while (await collapsed.count()) await collapsed.first().click();
      };
      const capture = async name => {
        await mkdir(screenshots, { recursive: true });
        if (cdp)
          await promisify(execFile)('agent-browser', [
            '--session',
            'chat-results-test',
            '--cdp',
            cdp,
            'screenshot',
            `${screenshots}/${name}.png`,
          ]);
        else await page.screenshot({ path: `${screenshots}/${name}.png` });
      };
      const openRows = async (index = 0) => {
        await conversation().getByRole('button', { name: 'Open Tasks', exact: true }).nth(index).click();
        await canvas().getByText('Check invoice totals', { exact: true }).waitFor();
      };

      await load('skill-only');
      await conversation().getByText('I read the procedure.', { exact: true }).waitFor();
      assert.equal(await canvas().count(), 0);
      assert.equal(await page.getByRole('button', { name: /Show canvas/ }).count(), 0);
      assert.equal(await conversation().locator('[data-tool-id]').count(), 0);

      for (const width of [320, 375, 414, 767, 768, 1440]) {
        for (const colorScheme of ['light', 'dark']) {
          await page.setViewportSize({ width, height: width === 1440 ? 1000 : 700 });
          await page.emulateMedia({ colorScheme });
          await load('running');
          const working = conversation().getByRole('button', { name: 'Working… Fetching task rows', exact: true });
          await working.waitFor();
          assert.equal(await working.getAttribute('aria-expanded'), 'false');
          assert.equal(await canvas().count(), 0, 'background work never opens the result view');
          await working.press('Enter');
          await conversation().locator('[data-tool-id][data-status="running"]').waitFor();
          assert.equal(await conversation().locator('[data-tool-id]').count(), 2);
          assert.equal(
            await conversation().locator('[data-status="completed"] .sprout-tool-activity-mark-completed').count(),
            1,
          );
          assert.equal(
            await conversation()
              .locator('[data-status="running"] svg circle')
              .last()
              .evaluate(element => getComputedStyle(element).animationName),
            'none',
          );
          await working.press('Space');
          assert.equal(await working.getAttribute('aria-expanded'), 'false');
          await composer().fill('Keep this draft while the rows finish.');
          const caret = await composer().evaluate(element => ({
            text: element.textContent,
            focused: document.activeElement === element,
            offset: window.getSelection()?.anchorOffset,
            history: window.history.length,
          }));
          assert.equal(caret.focused, true);
          await complete();
          await conversation().getByRole('button', { name: 'Open Tasks', exact: true }).waitFor();
          assert.equal(await canvas().count(), 0, 'completion cannot cover a mobile composer or open desktop Canvas');
          assert.deepEqual(
            await composer().evaluate(element => ({
              text: element.textContent,
              focused: document.activeElement === element,
              offset: window.getSelection()?.anchorOffset,
              history: window.history.length,
            })),
            caret,
            'passive completion preserves draft, focus, caret, and browser history',
          );
          assert.equal(
            await conversation()
              .getByRole('button', { name: /^Tool activity · \d+ tools?$/ })
              .getAttribute('aria-expanded'),
            'false',
          );
          if ([375, 1440].includes(width)) await capture(`chat-${width}-${colorScheme}`);
          await openRows();
          assert.equal(
            await canvas().locator('[data-tool-id]').count(),
            0,
            'result view contains no second activity feed',
          );
          assert.equal(await canvas().locator('tbody tr').count(), 3);
          assert.equal(await canvas().getByRole('tab').count(), 1);
          assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
          );
          if (width < 768) {
            const bounds = await page.getByRole('dialog', { name: 'Canvas', exact: true }).boundingBox();
            assert.equal(Math.round(bounds.width), width, 'mobile detail uses the full width');
            await page.goBack();
            await canvas().waitFor({ state: 'detached' });
            await page.goForward();
            await canvas().getByText('Check invoice totals', { exact: true }).waitFor();
            await page.goBack();
          } else if (await page.getByRole('dialog', { name: 'Canvas', exact: true }).isVisible()) {
            // A split narrower than 720px opens the canvas as a sheet beside the sidebar (cloud 51d9a255 #1053, ui canvas.tsx:13,26).
            await canvas().getByRole('button', { name: 'Back to chat', exact: true }).click();
          } else await canvas().getByRole('button', { name: 'Close canvas', exact: true }).click();
          await canvas().waitFor({ state: 'detached' });
          assert.equal(await composer().innerText(), 'Keep this draft while the rows finish.');
          await page
            .waitForFunction(() => document.activeElement?.textContent?.trim() === 'Open Tasks')
            .catch(async error => {
              console.error(
                'Focus after closing:',
                await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 700)),
              );
              await page.screenshot({ path: '/tmp/chat-result-focus-failure.png' });
              throw error;
            });
          assert.equal(
            await conversation()
              .getByRole('button', { name: 'Open Tasks', exact: true })
              .evaluate(element => document.activeElement === element),
            true,
            'focus returns to the result opener',
          );
          await page.getByRole('button', { name: 'Show canvas, 1 open' }).click();
          await canvas().getByText('Review customer request', { exact: true }).waitFor();
          if ([375, 1440].includes(width)) await capture(`result-${width}-${colorScheme}`);
          await canvas().getByRole('button', { name: 'Close Tasks', exact: true }).click();
          await canvas().waitFor({ state: 'detached' });
          assert.equal(
            await page.getByRole('button', { name: /Show canvas/ }).count(),
            0,
            'closing the final result leaves no empty Canvas',
          );
        }
      }

      await page.setViewportSize({ width: 1440, height: 1000 });
      await load('timeline');
      await conversation()
        .getByRole('button', { name: /Outcome unconfirmed/ })
        .waitFor();
      await expand();
      const states = [
        'completed',
        'completed',
        'completed',
        'completed',
        'completed',
        'unknown',
        'blocked',
        'failed',
        'cancelled',
        'queued',
        'waiting',
        'running',
      ];
      assert.deepEqual(
        await conversation()
          .locator('[data-tool-id]')
          .evaluateAll(steps => steps.map(step => step.dataset.status)),
        states,
      );
      assert.equal(
        new Set(
          await conversation()
            .locator('[data-tool-id]')
            .evaluateAll(steps => steps.map(step => step.dataset.toolId)),
        ).size,
        12,
      );
      assert.deepEqual(await conversation().locator('[data-slot="tool-status-label"]').allTextContents(), [
        'Completed',
        'Completed',
        'Completed',
        'Completed',
        'Completed',
        'Outcome unknown',
        'Access denied',
        'Failed',
        'Cancelled',
        'Pending',
        'Waiting',
        'In progress',
      ]);
      // Status words are announced but visually hidden; sprout hides them with its own clip rule rather than Tailwind's sr-only class.
      assert.ok(
        await conversation()
          .locator('[data-slot="tool-status-label"]')
          .evaluateAll(labels =>
            labels.every(label => {
              const style = getComputedStyle(label),
                box = label.getBoundingClientRect();
              return style.position === 'absolute' && style.overflow === 'hidden' && box.width <= 1 && box.height <= 1;
            }),
          ),
      );
      assert.equal(
        await conversation().locator('[data-slot="timeline-connector"]').count(),
        10,
        'connectors belong to their request, not a global feed',
      );
      assert.equal(await conversation().getByRole('button', { name: 'Show more', exact: true }).count(), 0);
      const lastGroup = conversation().locator('[data-slot="tool-activity"]').last();
      await complete();
      await conversation().getByRole('button', { name: 'Open Tasks', exact: true }).waitFor();
      assert.equal(
        await lastGroup.locator('button[aria-expanded]').first().getAttribute('aria-expanded'),
        'true',
        'completion preserves a manually expanded disclosure',
      );
      assert.equal(await conversation().locator('[data-tool-id]').count(), 12);
      assert.equal(await conversation().locator('[data-tool-id]').last().getAttribute('data-status'), 'completed');

      await load('timeline-pages');
      await conversation().getByRole('button', { name: 'Load older messages' }).click();
      await conversation().getByText('Find the customer and check team updates.').waitFor();
      await expand();
      assert.equal(await conversation().locator('[data-tool-id]').count(), 12);
      assert.equal(
        await conversation().locator('[data-tool-id]').first().getAttribute('data-tool-id'),
        '88888888-8888-4888-8888-000000000001',
      );
      await load('timeline-pages-error');
      await conversation().getByRole('button', { name: 'Load older messages' }).click();
      await conversation()
        .getByRole('button', { name: /Retry|Try again/ })
        .click();
      await conversation().getByText('Find the customer and check team updates.').waitFor();
      await expand();
      assert.equal(await conversation().locator('[data-tool-id]').count(), 12);

      for (const scenario of ['page', 'get', 'empty', 'error']) {
        await load(scenario);
        assert.equal(await canvas().count(), 0);
        await conversation().getByRole('button', { name: 'Open Tasks', exact: true }).click();
        if (scenario === 'empty') {
          await canvas().getByRole('heading', { name: 'No rows returned' }).waitFor();
          assert.equal(await canvas().locator('tbody tr').count(), 0);
        } else if (scenario === 'error') {
          const retry = canvas().getByRole('button', { name: /Try again|Retry refresh/ });
          await retry.waitFor();
          await retry.click();
          await retry.waitFor({ state: 'hidden' });
          await retry.waitFor();
          await complete();
          await retry.click();
          await canvas().getByText('Check invoice totals', { exact: true }).waitFor();
        } else {
          await canvas().getByText('Check invoice totals', { exact: true }).waitFor();
          assert.equal(await canvas().locator('tbody tr').count(), scenario === 'get' ? 1 : 3);
        }
      }
      for (const scenario of ['failed', 'blocked', 'unknown']) {
        await load(scenario);
        assert.equal(await canvas().count(), 0);
        await expand();
        await conversation().locator(`[data-tool-id][data-status="${scenario}"]`).waitFor();
        if (scenario === 'failed')
          await conversation().getByRole('button', { name: 'Retry reply', exact: true }).waitFor();
      }

      await load('history');
      await conversation().getByRole('button', { name: 'Open Tasks', exact: true }).nth(1).waitFor();
      await conversation().getByRole('button', { name: 'Open Tasks', exact: true }).first().click();
      await canvas().getByText('Confirm delivery date', { exact: true }).waitFor();
      assert.equal(await canvas().locator('tbody tr').count(), 1);
      await complete();
      assert.equal(await canvas().getByRole('tab').count(), 1, 'receiving other results does not create tabs');
      await openRows(1);
      await canvas().getByRole('tab').first().click();
      assert.equal(await canvas().locator('tbody tr:visible').count(), 1);
      await canvas().getByRole('button', { name: 'Details', exact: true }).filter({ visible: true }).click();
      await page.setViewportSize({ width: 375, height: 812 });
      await page.getByRole('dialog', { name: 'Canvas', exact: true }).waitFor();
      assert.equal(await canvas().getByRole('tab').first().getAttribute('aria-selected'), 'true');
      assert.equal(
        await canvas()
          .getByRole('button', { name: 'Details', exact: true })
          .filter({ visible: true })
          .getAttribute('aria-expanded'),
        'true',
        'breakpoint changes preserve the same result view',
      );
      await canvas().getByRole('button', { name: 'Back to chat', exact: true }).click();
      await canvas().waitFor({ state: 'detached' });

      await load('web');
      await expand();
      await conversation().getByText('web accessibility testing guides', { exact: true }).waitFor();
      await conversation()
        .getByRole('link', { name: /Accessibility \| MDN/ })
        .first()
        .waitFor();
      assert.equal(await canvas().count(), 0);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      assert.notEqual(
        await conversation()
          .locator('[data-status="running"] svg circle')
          .last()
          .evaluate(element => getComputedStyle(element).animationName),
        'none',
      );
      assert.deepEqual(errors, []);
    } catch (error) {
      if (page && !page.isClosed()) {
        console.error('Failed scenario:', currentScenario, await page.locator('body').innerText());
        await page.screenshot({ path: '/tmp/chat-results-failure.png' });
      }
      throw error;
    } finally {
      await browser?.close();
      server?.kill('SIGTERM');
    }
  },
);
