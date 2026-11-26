import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBuiltAppServer as createServer } from './built-app.fixture.mjs';
import { chromium } from 'playwright';

test(
  'memory files show inline and can be edited in place, deleted and changed by instruction',
  { timeout: 90000 },
  async () => {
    const server = await createServer({
      root: new URL('..', import.meta.url).pathname,
      server: { host: '127.0.0.1', port: 0 },
      logLevel: 'error',
    });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      const url = `http://127.0.0.1:${server.httpServer.address().port}/memory-mock/settings/account`;
      const edit = name => page.getByRole('button', { name: `Edit ${name}`, exact: true });
      const item = path => page.locator(`[data-memory-file="${path}"]`);
      const contents = name => page.getByRole('textbox', { name: `${name} contents` });
      const save = () => page.getByRole('button', { name: 'Save', exact: true }).click();

      await page.goto(url);
      for (const group of ['You', 'Topics', 'Areas', 'People'])
        await page.getByRole('heading', { name: group, exact: true }).waitFor();
      await item('/profile.md').getByText('How you want Bud to respond', { exact: true }).waitFor();
      await item('/profile.md').getByText('Greet me for my time of day.', { exact: false }).waitFor();
      await item('/areas/hiring.md').getByText('Updated yesterday', { exact: true }).waitFor();
      await item('/people/sam-lee.md').getByText('Prefers numbers in tables. Reviews budgets on Fridays.').waitFor();

      await edit('Career').click();
      assert.equal(await contents('Career').inputValue(), 'Working towards a COO role next year.');
      assert.ok(await edit('Profile').isDisabled(), 'one file is edited at a time');
      await contents('Career').fill('Working towards a COO role in **2027**.');
      await save();
      await item('/topics/career.md')
        .getByText('Saved. Bud uses the new version from now on.', { exact: true })
        .waitFor();
      await item('/topics/career.md').locator('strong', { hasText: '2027' }).waitFor();
      assert.equal(await contents('Career').count(), 0);

      await edit('Career').click();
      await contents('Career').fill('x'.repeat(8193));
      await page.getByText('This file is too long. Shorten it to under 8 KB, then save.', { exact: true }).waitFor();
      assert.ok(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled());
      await contents('Career').fill('Working towards a COO role in **2027**.');
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await page.getByText('Career deleted.', { exact: true }).waitFor();
      assert.equal(await edit('Career').count(), 0);
      await page
        .getByText('No topics yet. Bud adds them as subjects come up in your chats.', { exact: true })
        .waitFor();

      await edit('Profile').click();
      await contents('Profile').fill(
        ['Head of operations.', ...Array.from({ length: 12 }, (_, line) => `- Note ${line + 1}`)].join('\n'),
      );
      await save();
      const more = item('/you/about.md').getByRole('button', { name: 'Show more', exact: true });
      await more.click();
      await item('/you/about.md').getByRole('button', { name: 'Show less', exact: true }).waitFor();
      assert.equal(await item('/you/about.md').getByRole('button', { expanded: true }).count(), 1);

      await edit('Preferences').click();
      await page.getByRole('button', { name: 'Clear', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Clear', exact: true }).click();
      await page.getByText('Preferences cleared.', { exact: true }).waitFor();
      await item('/profile.md').getByText('Empty', { exact: true }).waitFor();

      const instruction = page.getByRole('textbox', { name: 'Tell Bud what to remember' });
      await instruction.fill('I lead Project Falcon');
      await page.getByRole('button', { name: 'Update memory', exact: true }).click();
      await page.getByText('Updated Profile. Added Project Falcon.', { exact: true }).waitFor();
      await edit('Project Falcon').waitFor();
      assert.equal(await instruction.inputValue(), '');
      await instruction.fill('Forget everything about Project Falcon');
      await page.getByRole('button', { name: 'Update memory', exact: true }).click();
      await page.getByText('Deleted Project Falcon.', { exact: true }).waitFor();
      await instruction.fill('Forget my old team');
      await page.getByRole('button', { name: 'Update memory', exact: true }).click();
      await page.getByText('Nothing needed changing. Your memory is already up to date.', { exact: true }).waitFor();

      for (const width of [320, 375, 768, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `no page overflow at ${width}`,
        );
      }
      await page.setViewportSize({ width: 1440, height: 1000 });

      await page.goto(`${url}?memoryScenario=conflict`);
      await edit('Profile').click();
      await contents('Profile').fill('Head of operations. Based in Berlin.');
      await save();
      await page.getByText(/This file changed after you started editing, so nothing was saved\./).waitFor();
      await page.getByRole('button', { name: 'Reload', exact: true }).click();
      await page.waitForFunction(() =>
        document.querySelector('[data-memory-file="/you/about.md"] textarea')?.value.includes('London'),
      );
      assert.equal(await contents('Profile').inputValue(), 'Head of operations at Tulip demo. Based in London.');

      await page.goto(`${url}?memoryScenario=instruct-error`);
      await instruction.fill('I moved to Berlin');
      await page.getByRole('button', { name: 'Update memory', exact: true }).click();
      await page.getByText(/Your workspace is out of credits\./).waitFor();
      assert.equal(await instruction.inputValue(), 'I moved to Berlin');

      await page.goto(`${url}?memoryScenario=empty`);
      await item('/you/about.md').getByText('Empty', { exact: true }).waitFor();
      await page
        .getByText('No people yet. Bud adds them as you mention people you work with.', { exact: true })
        .waitFor();
      await page.goto(`${url}?memoryScenario=error`);
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await edit('Preferences').waitFor();
      await page.goto(`${url}?memoryScenario=slow`);
      await page.getByRole('heading', { name: 'Loading your memory', exact: true }).waitFor();
      await edit('Preferences').waitFor();
      await page.goto(`${url}?memoryScenario=keep-unavailable`);
      await page.getByRole('heading', { name: 'Memory can’t be reached', exact: true }).waitFor();
      await page.goto(`${url}?memoryScenario=denied`);
      await page.getByRole('heading', { name: 'Memory is unavailable', exact: true }).waitFor();
      assert.equal(await instruction.count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
