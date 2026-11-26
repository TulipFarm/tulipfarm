import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBuiltAppServer as createServer } from './built-app.fixture.mjs';
import { chromium } from 'playwright';

// The compact choice list is sprout's ChoiceList layout="compact" (cloud's app-local .choice-options-compact).
test(
  'question proportions preserve the transcript and keep actions outside option scrolling',
  { timeout: 120000 },
  async () => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const browser = await chromium.launch();
    try {
      for (const colorScheme of ['light', 'dark']) {
        for (const viewport of [
          { width: 1440, height: 900 },
          { width: 1280, height: 720 },
          { width: 390, height: 844 },
        ]) {
          const hasTouch = viewport.width === 390;
          const page = await browser.newPage({ viewport, hasTouch, colorScheme, reducedMotion: 'reduce' });
          await page.goto(
            `${server.resolvedUrls.local[0]}bud-mock/chat/12121212-1212-4212-8212-121212121212?start=workflow-four-choices`,
          );
          const dock = page.getByRole('region', { name: 'Who should send the Slack notification?', exact: true });
          await dock.getByRole('radio').first().waitFor({ timeout: 30000 });
          await page.waitForFunction(() =>
            document.querySelector('[aria-label="Message composer"]')?.hasAttribute('data-condensed'),
          );
          const height = (await dock.boundingBox()).height;
          assert.ok(
            height <= viewport.height * (hasTouch ? 0.4 : 0.35),
            `${colorScheme} ${viewport.width}x${viewport.height}: ${height}px question respects viewport share`,
          );
          if (!hasTouch)
            assert.ok(
              (await page.getByRole('region', { name: 'Conversation', exact: true }).boundingBox()).height > height,
              'transcript remains taller than the question',
            );
          const lines = await dock
            .locator(
              '[data-slot="choice-list"][data-layout="compact"] [data-slot="choice-list-options"] > [data-slot="choice-list-option"]',
            )
            .nth(1)
            .evaluate(element => {
              const divider = getComputedStyle(element, '::before');
              const panel = getComputedStyle(element.closest('section'));
              const context = document.createElement('canvas').getContext('2d');
              if (!context) throw new Error('Canvas context needed to compare separator colors');
              const rgb = color => {
                context.fillStyle = color;
                context.fillRect(0, 0, 1, 1);
                return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
              };
              const background = rgb(panel.backgroundColor);
              const distance = color =>
                rgb(color).reduce((sum, value, index) => sum + Math.abs(value - background[index]), 0);
              return {
                divider: divider.backgroundColor,
                dividerHeight: divider.height,
                border: panel.borderTopColor,
                background: panel.backgroundColor,
                dividerWeight: distance(divider.backgroundColor),
                borderWeight: distance(panel.borderTopColor),
              };
            });
          assert.equal(lines.dividerHeight, '1px');
          assert.notEqual(lines.divider, 'rgba(0, 0, 0, 0)');
          assert.notEqual(lines.border, lines.background, 'outer border separates the panel from its surface');
          assert.ok(
            lines.dividerWeight > 0 && lines.dividerWeight < lines.borderWeight,
            'row dividers are visible but quieter than the enclosing edge',
          );
          assert.equal(
            await dock.locator('[data-slot="request-status"]').count(),
            0,
            'healthy questions have no metadata row',
          );
          assert.equal(
            await dock.locator('form').getByRole('button', { name: 'Details', exact: true }).count(),
            0,
            'diagnostics are separate from answering',
          );
          const questionBox = await dock.boundingBox();
          const composerBox = await page.getByRole('form', { name: 'Message composer' }).boundingBox();
          assert.equal(
            await page
              .getByRole('region', { name: 'Conversation', exact: true })
              .locator('section.question-panel')
              .count(),
            1,
            'question is answered inline in the transcript',
          );
          assert.ok(questionBox.y + questionBox.height <= composerBox.y, 'question sits above the composer');
          const recommendation = dock.locator('[data-slot="badge"][data-variant="success"]');
          assert.equal(await recommendation.textContent(), 'Recommended');
          assert.equal(await dock.getByRole('radio').first().isChecked(), false, 'recommendation is not a selection');
          if (process.env.WORKFLOW_CHAT_SCREENSHOTS) {
            await page.screenshot({
              path: `${process.env.WORKFLOW_CHAT_SCREENSHOTS}/question-${colorScheme}-${viewport.width}.png`,
            });
          }
          await page.setViewportSize({ width: viewport.width, height: 600 });
          const list = dock.locator(
            '[data-slot="choice-list"][data-layout="compact"] [data-slot="choice-list-options"]',
          );
          await page.waitForFunction(() => {
            const options = document.querySelector(
              '[data-slot="choice-list"][data-layout="compact"] [data-slot="choice-list-options"]',
            );
            return options && options.scrollHeight > options.clientHeight;
          });
          assert.equal(
            await list.evaluate(element => element.scrollHeight > element.clientHeight),
            true,
            'short screens scroll the options, not the action footer',
          );
          // Both boxes are read in one frame: the transcript may still be scrolling after the resize.
          const footerOffset = async () =>
            dock
              .getByRole('button', { name: 'Continue', exact: true })
              .evaluate(
                (button, region) => button.getBoundingClientRect().y - region.getBoundingClientRect().y,
                await dock.elementHandle(),
              );
          const before = await footerOffset();
          await dock.getByRole('radio').last().check();
          assert.equal(await footerOffset(), before, 'selecting the last scrolled option keeps actions in place');
          const after = await dock.getByRole('button', { name: 'Continue', exact: true }).boundingBox();
          assert.ok(after.y + after.height <= 600, 'Continue remains on screen');
          await dock.getByRole('button', { name: 'Continue', exact: true }).click();
          await page.locator('[data-slot="choice-summary"]').getByText('Team account', { exact: true }).waitFor();
          await page.close();
        }
      }
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
