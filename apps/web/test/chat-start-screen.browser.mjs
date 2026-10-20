import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test(
  'new chat separates tasks and setup, updates placeholders, and preserves Bud drafts',
  { timeout: 120000 },
  async () => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const browser = await chromium.launch({ headless: process.env.CHAT_START_HEADED !== '1' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = server.resolvedUrls.local[0];
    try {
      await page.goto(`${origin}bud-mock?start=setup`);
      const tasks = page.getByRole('region', { name: 'Start with a task', exact: true });
      const setup = page.getByRole('region', { name: 'Set up your workspace', exact: true });
      await setup.waitFor();
      assert.equal(await tasks.getByRole('button').count(), 3);
      assert.equal(await setup.getByRole('button').count(), 1);
      const composer = page
        .getByRole('region', { name: 'Personal conversations' })
        .getByRole('textbox', { name: 'Message' });
      await composer.locator('[data-placeholder="What would you like to get done?"]').waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Start this chat in: Personal chats', exact: true }).innerText(),
        'Personal chat',
      );
      assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
      for (const heading of ['Daily work', 'Agents & workflows', 'Data & integrations']) {
        assert.equal(await page.getByText(heading, { exact: true }).count(), 1);
      }
      const more = page.getByText('More setup options (4)', { exact: true });
      const composerBounds = await composer.boundingBox();
      const greeting = page.getByRole('heading', { name: 'Welcome back, Dhruv', exact: true });
      const greetingBounds = await greeting.boundingBox();
      await more.focus();
      await page.keyboard.press('Enter');
      const fewer = page.getByRole('button', { name: 'Fewer setup options', exact: true });
      await fewer.waitFor();
      assert.equal(await fewer.getAttribute('aria-expanded'), 'true');
      const moreSetup = page.getByRole('region', { name: 'More setup options', exact: true });
      await moreSetup.waitFor();
      assert.equal(await moreSetup.getByRole('button').count(), 4);
      assert.equal(
        await page.getByRole('region', { name: 'Recommended for you' }).getByRole('heading').count(),
        2,
        'Only tasks and setup have headings',
      );
      assert.ok(
        Math.abs((await composer.boundingBox()).y - composerBounds.y) <= 1,
        'Expanding setup does not move the composer',
      );
      assert.ok(
        Math.abs((await greeting.boundingBox()).y - greetingBounds.y) <= 1,
        'Expanding setup does not move the greeting',
      );
      assert.equal(await moreSetup.getByRole('img', { name: 'Google', exact: true }).count(), 1);
      const slack = moreSetup.getByRole('button', { name: 'Choose Slack channels for knowledge' });
      const labelBounds = await slack.boundingBox();
      const brandBounds = await moreSetup.getByRole('img', { name: 'Slack' }).boundingBox();
      assert.ok(brandBounds.x - labelBounds.x - labelBounds.width <= 16, 'Provider icon stays beside its label');

      await page.getByRole('button', { name: 'Open Bud', exact: true }).click();
      const popup = page.getByRole('dialog');
      await popup.getByText('Your separate private chat', { exact: true }).waitFor();
      const budEditor = popup.getByRole('textbox', { name: 'Message' });
      await budEditor.locator('[data-placeholder="Reply…"]').waitFor();
      await budEditor.fill('Keep this private draft');
      await page.getByRole('button', { name: 'Minimize chat', exact: true }).click();
      await composer.locator('[data-placeholder="What would you like to get done?"]').waitFor();
      await page.getByRole('button', { name: 'Open Bud', exact: true }).click();
      assert.equal(await budEditor.innerText(), 'Keep this private draft');
      await page.getByRole('button', { name: 'Minimize chat', exact: true }).click();

      await composer.fill('Help me plan a customer follow-up');
      assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), true);
      assert.equal(
        await tasks.getByRole('button').first().isDisabled(),
        true,
        'Task choices cannot replace an existing draft',
      );
      await composer.fill('');
      assert.equal(await tasks.getByRole('button').first().isEnabled(), true);
      const warning = page.getByRole('region', { name: 'Integration authorization', exact: true });
      assert.match(await warning.innerText(), /GitHub reads and actions with this account need renewed access/);
      const launcher = page.getByRole('button', { name: 'Open Bud', exact: true });
      assert.equal(await launcher.getByText('Bud quick chat', { exact: true }).count(), 1);
      assert.equal(await launcher.getByText('Separate private chat', { exact: true }).count(), 1);

      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme });
        for (const width of [320, 375, 414, 768, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(
            () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
            `${colorScheme} page fits ${width}px`,
          );
          assert.equal(
            await warning.evaluate(element => element.scrollWidth <= element.clientWidth),
            true,
            `${colorScheme} warning fits ${width}px`,
          );
          assert.equal(
            await composer.evaluate(element => element.scrollWidth <= element.clientWidth),
            true,
            `${colorScheme} composer fits ${width}px`,
          );
          assert.equal(await page.getByRole('button', { name: 'Open Bud', exact: true }).isVisible(), true);
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        assert.equal(
          await fewer.getAttribute('aria-expanded'),
          'true',
          `${colorScheme} setup stays expanded across screen sizes`,
        );
        await fewer.click();
        await more.waitFor();
        assert.equal(await more.getAttribute('aria-expanded'), 'false');
        const collapsed = await composer.boundingBox();
        await more.click();
        await fewer.waitFor();
        await moreSetup.waitFor();
        assert.ok(
          Math.abs((await composer.boundingBox()).y - collapsed.y) <= 1,
          `${colorScheme} expansion keeps input still`,
        );
        await fewer.click();
        await more.waitFor();
        assert.equal(await more.getAttribute('aria-expanded'), 'false');
        assert.ok(
          Math.abs((await composer.boundingBox()).y - collapsed.y) <= 1,
          `${colorScheme} collapse keeps input still`,
        );
        await page.mouse.move(0, 0);
        const rows = await tasks.locator('li').evaluateAll(elements =>
          elements.map(element => ({
            arrowOpacity: getComputedStyle(element.querySelector('.sprout-prompt-list-arrow')).opacity,
            arrowTransform: getComputedStyle(element.querySelector('.sprout-prompt-list-arrow')).transform,
            cursor: getComputedStyle(element.querySelector('button')).cursor,
          })),
        );
        assert.ok(
          rows.every(row => row.arrowOpacity === '1' && row.arrowTransform === 'none' && row.cursor === 'pointer'),
          `${colorScheme} task actions are visible before hover`,
        );
        const contrast = await composer.evaluate(element => {
          const group = element.closest('[data-variant="composer"]');
          const style = getComputedStyle(group);
          const context = document.createElement('canvas').getContext('2d');
          function rgba(value) {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = value;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data];
          }
          function luminance(rgb) {
            return rgb
              .slice(0, 3)
              .map(value => value / 255)
              .map(value => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
              .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
          }
          const background = rgba(style.backgroundColor);
          function ratio(color, surface = background) {
            const foreground = rgba(color);
            const blended = foreground
              .slice(0, 3)
              .map((value, index) => (value * foreground[3]) / 255 + surface[index] * (1 - foreground[3] / 255));
            const a = luminance(blended),
              b = luminance(surface);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          }
          const pageBackground = rgba(getComputedStyle(document.body).backgroundColor);
          return {
            placeholder: ratio(getComputedStyle(element.querySelector('[data-placeholder]'), '::before').color),
            border: ratio(style.borderTopColor),
            icon: ratio(getComputedStyle(document.querySelector('.sprout-prompt-list-icon')).color, pageBackground),
            setupDivider: ratio(
              getComputedStyle(document.querySelector('[aria-label="Recommended for you"] > .border-t')).borderTopColor,
              pageBackground,
            ),
          };
        });
        assert.ok(contrast.placeholder >= 4.5, `${colorScheme} placeholder contrast ${contrast.placeholder} >= 4.5`);
        assert.ok(contrast.border >= 1.5, `${colorScheme} composer edge contrast ${contrast.border} >= 1.5`);
        assert.ok(contrast.icon >= 4.5, `${colorScheme} task icon contrast ${contrast.icon} >= 4.5`);
        assert.ok(
          contrast.setupDivider >= 1.5,
          `${colorScheme} setup divider contrast ${contrast.setupDivider} >= 1.5`,
        );
        await page.setViewportSize({ width: 375, height: 500 });
        await more.click();
        await moreSetup.waitFor();
        await moreSetup.getByRole('button').last().scrollIntoViewIfNeeded();
        const last = await moreSetup.getByRole('button').last().boundingBox();
        assert.ok(last.y >= 0 && last.y + last.height <= 500, `${colorScheme} setup stays reachable on a short phone`);
      }
      await page.goto(`${origin}bud-mock?start=empty`);
      await tasks.getByRole('button', { name: 'Plan customer follow-ups', exact: true }).waitFor();
      assert.equal(await setup.count(), 0, 'No invented setup when the saved list is empty');
      // Cloud 21d61168 (#1116) shows three starter tasks and keeps the rest behind More tasks (starting-task-priority.ts:1, starting-tasks.tsx:65-71).
      assert.equal(await tasks.getByRole('button').count(), 3);
      await page.getByRole('button', { name: 'More tasks (2)', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Write down a business process', exact: true }).count(), 1);
      assert.deepEqual(errors, []);
    } catch (error) {
      console.error(error);
      throw error;
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
