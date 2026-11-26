import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBuiltAppServer as createServer } from './built-app.fixture.mjs';
import { chromium } from 'playwright';
import { clearEditor } from './browser-controls.mjs';

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
      // The home offers three suggested tasks and the first setup step as bento cards.
      const recommended = page.getByRole('region', { name: 'Recommended for you', exact: true });
      const chips = recommended.getByRole('button');
      const labels = () =>
        chips.evaluateAll(buttons =>
          buttons.map(button => button.querySelector(':scope > span:last-child > span:nth-child(2)').textContent),
        );
      const starters = ['Plan customer follow-ups', 'Draft a support reply', 'Plan my week'];
      await recommended.getByRole('button', { name: /Set how Bud replies to you/ }).waitFor();
      assert.deepEqual(await labels(), [...starters, 'Set how Bud replies to you']);
      assert.deepEqual(
        await chips.evaluateAll(buttons =>
          buttons.map(button => button.querySelector(':scope > span:last-child > span:first-child').textContent),
        ),
        ['Suggested for you', 'Suggested task', 'Suggested task', 'Set up your workspace'],
      );
      assert.equal(await recommended.getByRole('heading').count(), 0, 'The cards need no section headings');
      assert.equal(await page.getByText(/More setup options/).count(), 0, 'Setup shows one next step');
      const composer = page
        .getByRole('region', { name: 'Personal conversations' })
        .getByRole('textbox', { name: 'Message' });
      await composer.locator('[data-placeholder="What would you like to get done?"]').waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Start this chat in: Personal chats', exact: true }).innerText(),
        'Personal chat',
      );
      assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
      const composerBounds = await composer.boundingBox();
      const lastCard = await chips.last().boundingBox();
      assert.ok(lastCard.y + lastCard.height <= composerBounds.y, 'The composer sits below the suggestions');

      await page.getByRole('button', { name: /Open quick chat$/ }).click();
      const popup = page.getByRole('dialog');
      await popup.getByText('Your separate private chat', { exact: true }).waitFor();
      const budEditor = popup.getByRole('textbox', { name: 'Message' });
      await budEditor.locator('[data-placeholder="Reply…"]').waitFor();
      await budEditor.fill('Keep this private draft');
      await page.getByRole('button', { name: 'Minimize chat', exact: true }).click();
      await composer.locator('[data-placeholder="What would you like to get done?"]').waitFor();
      await page.getByRole('button', { name: /Open quick chat$/ }).click();
      assert.equal(await budEditor.innerText(), 'Keep this private draft');
      await page.getByRole('button', { name: 'Minimize chat', exact: true }).click();
      await popup.waitFor({ state: 'hidden' });

      const disabled = () => chips.evaluateAll(buttons => buttons.map(button => button.disabled));
      await composer.fill('Help me plan a customer follow-up');
      assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), true);
      assert.deepEqual(await disabled(), [true, true, true, true], 'Chips cannot replace an existing draft');
      await clearEditor(composer);
      assert.deepEqual(await disabled(), [false, false, false, false]);
      const warning = page.getByRole('region', { name: 'Integration authorization', exact: true });
      assert.match(await warning.innerText(), /GitHub reads and actions with this account need renewed access/);
      // The home keeps the composer at the bottom, so Bud docks in the header instead of a corner.
      const launcher = page.getByRole('button', { name: 'Bud. Open quick chat', exact: true });
      assert.equal(
        await page.locator('[aria-label="Workspace header"] [aria-label="Bud assistant"]').getByRole('button').count(),
        1,
      );
      assert.equal(await launcher.getAttribute('title'), 'Your separate private quick chat');

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
          assert.equal(
            await recommended.evaluate(element => element.scrollWidth <= element.clientWidth),
            true,
            `${colorScheme} cards fit within ${width}px`,
          );
          assert.equal(await page.getByRole('button', { name: /Open quick chat$/ }).isVisible(), true);
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.mouse.move(0, 0);
        const rows = await chips.evaluateAll(elements =>
          elements.map(element => ({
            icon: getComputedStyle(element.querySelector('.rounded-xl svg')).visibility,
            cursor: getComputedStyle(element).cursor,
          })),
        );
        assert.ok(
          rows.length === 4 && rows.every(row => row.icon === 'visible' && row.cursor === 'pointer'),
          `${colorScheme} cards show their icon and pointer before hover`,
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
          const chipButtons = [...document.querySelectorAll('[aria-label="Recommended for you"] button')];
          const surface = button => rgba(getComputedStyle(button).backgroundColor);
          return {
            placeholder: ratio(getComputedStyle(element.querySelector('[data-placeholder]'), '::before').color),
            border: ratio(style.borderTopColor),
            icon: Math.min(
              ...chipButtons.map(button => {
                const tile = button.querySelector('.rounded-xl');
                return ratio(
                  getComputedStyle(tile.querySelector('svg')).color,
                  rgba(getComputedStyle(tile).backgroundColor),
                );
              }),
            ),
            label: Math.min(
              ...chipButtons.map(button =>
                ratio(
                  getComputedStyle(button.querySelector(':scope > span:last-child > span:nth-child(2)')).color,
                  surface(button),
                ),
              ),
            ),
          };
        });
        assert.ok(contrast.placeholder >= 4.5, `${colorScheme} placeholder contrast ${contrast.placeholder} >= 4.5`);
        assert.ok(contrast.border >= 1.5, `${colorScheme} composer edge contrast ${contrast.border} >= 1.5`);
        assert.ok(contrast.icon >= 4.5, `${colorScheme} card icon contrast ${contrast.icon} >= 4.5`);
        assert.ok(contrast.label >= 4.5, `${colorScheme} card label contrast ${contrast.label} >= 4.5`);
        await page.setViewportSize({ width: 375, height: 500 });
        await chips.last().scrollIntoViewIfNeeded();
        const last = await chips.last().boundingBox();
        assert.ok(last.y >= 0 && last.y + last.height <= 500, `${colorScheme} setup stays reachable on a short phone`);
      }
      await page.goto(`${origin}bud-mock?start=empty`);
      await recommended.getByRole('button', { name: /Plan customer follow-ups/ }).waitFor();
      // Three starter tasks show; the rest of the saved list stays off the home (starting-task-priority.ts).
      assert.deepEqual(await labels(), starters, 'No invented setup when the saved list is empty');
      await page.goto(`${origin}bud-mock?start=sparse`);
      await recommended.getByRole('button', { name: /Set how Bud replies to you/ }).waitFor();
      assert.deepEqual(
        await labels(),
        [...starters, 'Set how Bud replies to you'],
        'A one-item saved list is topped up with general prompts, without repeating a label',
      );
      await page.setViewportSize({ width: 390, height: 844 });
      const lastControl = chips.last();
      await lastControl.scrollIntoViewIfNeeded();
      await page
        .getByRole('region', { name: 'Personal conversations' })
        .evaluate(element => element.querySelector('.overflow-y-auto')?.scrollTo({ top: 1e6, behavior: 'instant' }));
      const lastBounds = await lastControl.boundingBox();
      const launcherBounds = await page.getByRole('button', { name: /Open quick chat$/ }).boundingBox();
      assert.ok(
        lastBounds.y >= launcherBounds.y + launcherBounds.height ||
          lastBounds.y + lastBounds.height <= launcherBounds.y ||
          lastBounds.x >= launcherBounds.x + launcherBounds.width ||
          lastBounds.x + lastBounds.width <= launcherBounds.x,
        'Bud quick chat never covers the last setup control',
      );
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
