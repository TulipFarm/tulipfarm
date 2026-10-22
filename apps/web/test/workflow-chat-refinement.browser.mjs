import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
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
          const dock = page.getByRole('region', { name: 'Questions', exact: true });
          await dock.getByRole('radio').first().waitFor();
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
            composerBox.y - questionBox.y - questionBox.height,
            4,
            'question and composer form a compact input group',
          );
          const recommendation = dock.locator('[data-slot="badge"][data-variant="info"]');
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
          const before = await dock.getByRole('button', { name: 'Continue', exact: true }).boundingBox();
          await dock.getByRole('radio').last().check();
          const after = await dock.getByRole('button', { name: 'Continue', exact: true }).boundingBox();
          assert.equal(after.y, before.y, 'selecting the last scrolled option keeps actions in place');
          assert.ok(after.y + after.height <= 600, 'Continue remains on screen');
          await dock.getByRole('button', { name: 'Continue', exact: true }).click();
          await page.getByText('Your answer was recorded.', { exact: true }).waitFor();
          await page.close();
        }
      }
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test(
  'seeded workflow chat separates decisions, saved results, and recovery in both themes',
  { timeout: 120000 },
  async () => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = server.resolvedUrls.local[0];
    const open = async (scenario = 'workflow') => {
      await page.goto(`${origin}bud-mock/chat/12121212-1212-4212-8212-121212121212?start=${scenario}`);
      await page.getByRole('heading', { name: 'Who should send the Slack notification?' }).waitFor();
    };
    // Saved results are chat cards that open in Canvas since cloud 51d9a255 (#1053), src/features/chat/workflow-canvas.tsx:48.
    const result = page
      .getByRole('region', { name: 'Workflow: TulipFarm pull request summaries to tech', exact: true })
      .getByRole('button', { name: 'View workflow', exact: true });
    const canvas = page.getByRole('region', { name: 'Canvas', exact: true });
    const dock = page.getByRole('region', { name: 'Questions', exact: true });
    const diagram = page.getByRole('figure', { name: 'Read-only workflow diagram' });
    const settle = () =>
      page.waitForFunction(() => {
        const viewport = document.querySelector('.react-flow__viewport');
        return viewport && getComputedStyle(viewport).transform !== 'matrix(1, 0, 0, 1, 0, 0)';
      });

    try {
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme });
        for (const width of [320, 375, 414, 768, 1440, 1600]) {
          await page.setViewportSize({ width, height: 900 });
          await open();
          assert.equal(await result.count(), 1, 'identical saved results produce one control');
          const choice = dock.getByRole('radio', { name: /TulipFarm app/ });
          assert.equal(await choice.isChecked(), false);
          assert.equal(await dock.getByRole('button', { name: 'Continue', exact: true }).isEnabled(), true);
          const question = await dock.boundingBox();
          assert.ok(question.height <= 280, `${colorScheme} ${width}: question height ${question.height}`);
          const optionBoxes = await dock
            .getByRole('radio')
            .evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
          assert.ok(
            optionBoxes.every(box => box.height >= 36),
            'fine-pointer answer rows retain 36px targets',
          );
          assert.ok(optionBoxes[1].y > optionBoxes[0].y, 'choices follow a vertical reading order');
          assert.equal(await dock.getByRole('textbox', { name: 'Your answer' }).count(), 0);
          await choice.check();
          assert.equal(await choice.isChecked(), true);
          await result.click();
          await diagram.waitFor();
          await settle();
          assert.equal(
            await canvas
              .getByRole('heading', { name: 'TulipFarm pull request summaries to tech', exact: true })
              .count(),
            1,
          );
          const geometry = await diagram.evaluate(element => {
            const bounds = element.getBoundingClientRect();
            return {
              overflow: document.documentElement.scrollWidth > innerWidth,
              visible: [...element.querySelectorAll('.workflow-node')].every(node => {
                const box = node.getBoundingClientRect();
                return (
                  box.top >= bounds.top &&
                  box.bottom <= Math.min(bounds.bottom, innerHeight) &&
                  box.left >= bounds.left &&
                  box.right <= bounds.right
                );
              }),
              handlesHidden: [...element.querySelectorAll('.react-flow__handle')].every(
                handle => getComputedStyle(handle).opacity === '0',
              ),
            };
          });
          assert.equal(geometry.overflow, false, `${colorScheme} ${width}: no page overflow`);
          assert.equal(geometry.visible, true, `${colorScheme} ${width}: both workflow steps fit the visible diagram`);
          assert.equal(geometry.handlesHidden, true, 'view-only diagram has no visible edit handles');
          await canvas.getByRole('button', { name: 'Steps', exact: true }).click();
          assert.equal(await canvas.getByRole('list', { name: 'Workflow steps' }).getByRole('button').count(), 2);
          await canvas.getByRole('button', { name: 'Diagram', exact: true }).click();
        }
      }
      await page.setViewportSize({ width: 1600, height: 1000 });
      await open();
      await dock.getByRole('button', { name: 'Continue', exact: true }).click();
      await dock.getByText('Choose an answer.', { exact: true }).waitFor();
      await dock.getByRole('radio', { name: /TulipFarm app/ }).check();
      await dock.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByText('Your answer was recorded.', { exact: true }).waitFor();
      await open();
      await dock.getByRole('button', { name: 'Skip', exact: true }).click();
      await page.getByText('This request was cancelled without an answer.', { exact: true }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await open();
      assert.ok((await dock.boundingBox()).height <= 280, '390x844 question stays within 280px');
      await dock.getByRole('button', { name: 'Other answer', exact: true }).click();
      await dock.getByRole('textbox', { name: 'Your answer' }).fill('Use the release bot.');
      await dock.getByRole('button', { name: 'Use a listed answer', exact: true }).click();
      assert.equal(await dock.getByRole('textbox', { name: 'Your answer' }).count(), 0);
      await dock.getByRole('button', { name: 'Other answer', exact: true }).click();
      assert.equal(await dock.getByRole('textbox', { name: 'Your answer' }).inputValue(), 'Use the release bot.');
      await dock.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByText('Your answer was recorded.', { exact: true }).waitFor();
      await page.setViewportSize({ width: 1600, height: 1000 });
      await open('workflow-errors');
      const retryActions = page.getByRole('button', { name: 'Check connected-tool actions again', exact: true });
      await retryActions.waitFor();
      await result.click();
      const retryWorkflow = canvas.getByRole('button', { name: 'Retry loading workflow', exact: true });
      await retryWorkflow.waitFor();
      for (let attempt = 0; attempt < 3 && (await retryWorkflow.isVisible()); attempt++) {
        await retryWorkflow.click();
        await page.waitForLoadState('networkidle');
      }
      await diagram.waitFor();
      for (let attempt = 0; attempt < 3 && (await retryActions.isVisible()); attempt++) {
        await retryActions.click();
        await page.waitForLoadState('networkidle');
      }
      assert.equal(await retryActions.count(), 0, 'successful empty action list clears its error');
      await open('workflow-unavailable');
      await result.click();
      await canvas.getByRole('heading', { name: 'Workflow unavailable', exact: true }).waitFor();
      assert.equal(await diagram.count(), 0, 'denied workflow clears protected graph');
      await open('workflow-loading');
      await result.click();
      await page.getByRole('status', { name: 'Loading workflow diagram' }).waitFor();
      await diagram.waitFor();
      await page.goto(`${origin}bud-mock/chat/12121212-1212-4212-8212-121212121212?start=workflow-empty`);
      await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
      assert.equal(await result.count(), 0, 'empty chat invents no workflow result');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

for (const colorScheme of ['light', 'dark']) {
  for (const { width, hasTouch } of [
    { width: 1440, hasTouch: false },
    { width: 680, hasTouch: false },
    { width: 390, hasTouch: true },
    { width: 320, hasTouch: true },
  ]) {
    test(
      `question lists and slim composers: ${colorScheme}, ${width}px, touch ${hasTouch}`,
      { timeout: 120000 },
      async () => {
        const server = await createServer({
          root: fileURLToPath(new URL('..', import.meta.url)),
          server: { host: '127.0.0.1', port: 0 },
        });
        await server.listen();
        const browser = await chromium.launch();
        const errors = [];
        try {
          const page = await browser.newPage({
            viewport: { width, height: 900 },
            hasTouch,
            colorScheme,
            reducedMotion: 'reduce',
          });
          page.setDefaultTimeout(10000);
          page.on('pageerror', error => errors.push(error.message));
          const dock = page.getByRole('region', { name: 'Questions', exact: true });
          for (const [scenario, count] of [
            ['workflow', 2],
            ['workflow-three-choices', 3],
            ['workflow-four-choices', 4],
            ['workflow-long-choices', 4],
          ]) {
            await page.goto(
              `${server.resolvedUrls.local[0]}bud-mock/chat/12121212-1212-4212-8212-121212121212?start=${scenario}`,
            );
            const options = dock.getByRole('radio');
            await options.first().waitFor();
            assert.equal(await options.count(), count);
            const geometry = await options.evaluateAll(elements =>
              elements.map(element => element.getBoundingClientRect().toJSON()),
            );
            assert.ok(
              geometry.every(box => box.height >= (hasTouch ? 44 : 36)),
              'answer rows support mouse and touch',
            );
            assert.ok(
              geometry.every(box => box.x >= 0 && box.right <= width),
              'long choices stay within the screen',
            );
            const limit = 384;
            const question = await dock.boundingBox();
            const height = question.height;
            assert.ok(
              height <= limit,
              `${scenario}, ${colorScheme}, ${width}: ${height}px question stays within ${limit}px`,
            );
            assert.ok(
              geometry.every(
                (box, index) => box.x === geometry[0].x && (index === 0 || box.y >= geometry[index - 1].bottom),
              ),
              'numbered answers align without overlapping',
            );
            const composer = page.getByRole('form', { name: 'Message composer' });
            await page.waitForFunction(() =>
              document.querySelector('[aria-label="Message composer"]')?.hasAttribute('data-condensed'),
            );
            assert.ok(
              (await composer.boundingBox()).height <= 56,
              'idle composer stays one line while an answer is needed',
            );
            assert.equal(
              await dock.getByRole('button', { name: 'Check request status' }).count(),
              0,
              'routine request tools do not crowd the input group',
            );
            const editor = composer.getByRole('textbox', { name: 'Message', exact: true });
            const initialEditor = await editor.elementHandle();
            await editor.fill('Keep my separate message.');
            assert.equal(await composer.getAttribute('data-condensed'), null, 'using the composer restores its tools');
            await options.first().click();
            assert.equal(
              await editor.textContent(),
              'Keep my separate message.',
              'answer selection preserves the separate message draft',
            );
            assert.equal(
              await initialEditor.evaluate(element => element.isConnected),
              true,
              'expanding never remounts the editor',
            );
            await editor.fill('');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            await options.first().focus();
            await page.keyboard.press('ArrowRight');
            assert.equal(await options.nth(1).isChecked(), true, 'native arrow navigation selects the next choice');
            assert.equal(
              await dock.getByRole('button', { name: 'Continue', exact: true }).count(),
              1,
              'selection does not submit',
            );
          }
          await dock.getByRole('radio').last().check();
          await dock.getByRole('button', { name: 'Continue', exact: true }).click();
          await page.getByText('Your answer was recorded.', { exact: true }).waitFor();
          assert.equal(
            await page.getByRole('form', { name: 'Message composer' }).getAttribute('data-condensed'),
            null,
            'answer completion restores the normal composer',
          );
          await page.close();
          assert.deepEqual(errors, []);
        } finally {
          await browser.close();
          await server.close();
        }
      },
    );
  }
}
