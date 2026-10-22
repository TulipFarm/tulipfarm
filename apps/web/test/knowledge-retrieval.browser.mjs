import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

test(
  'grouped knowledge activity shows real outcomes without implying Slides creation',
  { timeout: 120_000 },
  async () => {
    const port = process.env.KNOWLEDGE_BROWSER_PORT ?? '5864';
    const origin = process.env.KNOWLEDGE_BROWSER_ORIGIN ?? `http://127.0.0.1:${port}`;
    const screenshots =
      process.env.KNOWLEDGE_BROWSER_SCREENSHOTS ??
      new URL('../../../reports/check/knowledge-retrieval/', import.meta.url).pathname;
    const server = process.env.KNOWLEDGE_BROWSER_ORIGIN
      ? null
      : spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', port, '--strictPort'], {
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
        assert.ok(attempt < 150 && (!server || server.exitCode === null), 'Vite starts');
        await delay(100);
      }
      browser = await chromium.launch({ headless: process.env.CHAT_BROWSER_HEADED !== '1' });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(10_000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      const conversation = () => page.getByRole('region', { name: 'Conversation', exact: true });
      const load = async scenario => {
        await page.goto(`${origin}/canvas-mock/chat/11111111-1111-4111-8111-111111111111?scenario=${scenario}`);
        await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
        const toggle = conversation().locator('[data-slot="tool-activity"] > button').first();
        await toggle.waitFor();
        if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
      };
      const capture = async name => {
        await mkdir(screenshots, { recursive: true });
        await page.screenshot({ path: `${screenshots}/${name}.png` });
      };
      for (const width of [375, 1440])
        for (const colorScheme of ['light', 'dark']) {
          await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
          await page.emulateMedia({ colorScheme });
          await load('knowledge');
          await conversation().getByText('Searching knowledge', { exact: true }).waitFor();
          assert.equal(await conversation().locator('[data-tool-id]').count(), 1);
          const composer = page.getByRole('textbox', { name: 'Message', exact: true });
          await composer.fill('Keep the pitch outline short.');
          await page.keyboard.press('Control+Shift+Enter');
          await conversation().getByText('Read knowledge sources', { exact: true }).waitFor();
          assert.equal(await composer.innerText(), 'Keep the pitch outline short.');
          assert.equal(await composer.evaluate(element => element === document.activeElement), true);
          await conversation().getByRole('button', { name: 'Details', exact: true }).click();
          await conversation().getByRole('list', { name: 'Knowledge branches' }).waitFor();
          assert.equal(
            await conversation()
              .getByText(/Full document returned/)
              .count(),
            4,
          );
          await conversation()
            .getByText(/The Google Slides file has not been created/)
            .waitFor();
          assert.equal(await page.getByRole('region', { name: 'Canvas', exact: true }).count(), 0);
          assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
          );
          await capture(`grouped-${width}-${colorScheme}`);
          await composer.fill('');
        }
      for (const [scenario, label] of [
        ['knowledge-partial', 'Read partial knowledge evidence'],
        ['knowledge-empty', 'No new knowledge evidence'],
        ['knowledge-unavailable', 'Knowledge source unavailable'],
        ['knowledge-failed', 'Knowledge retrieval failed'],
        ['knowledge-exhausted', 'Knowledge search limit reached'],
        ['knowledge-cancelled', 'Knowledge retrieval cancelled'],
      ]) {
        await load(scenario);
        await conversation().getByText(label, { exact: true }).waitFor();
        if (scenario === 'knowledge-partial') {
          await conversation().getByRole('button', { name: 'Details', exact: true }).click();
          await conversation().getByText('Branch 2: Timed out', { exact: true }).waitFor();
          await conversation().getByText('Branch 3: No matches', { exact: true }).waitFor();
          assert.equal(
            await conversation()
              .getByText(/Some sections were not returned/)
              .count(),
            4,
          );
          await capture('partial-deep-round');
        }
        if (scenario === 'knowledge-unavailable')
          assert.equal(await conversation().getByText('PRIVATE TITLE', { exact: true }).count(), 0);
        if (scenario === 'knowledge-exhausted')
          await conversation()
            .getByText(/ask to go deeper in a new message/)
            .waitFor();
        assert.equal(await page.getByRole('region', { name: 'Canvas', exact: true }).count(), 0);
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      if (server && server.exitCode === null) server.kill('SIGTERM');
    }
  },
);
