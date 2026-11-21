import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test('memory files can be browsed, edited, deleted and changed by instruction', { timeout: 90000 }, async () => {
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
    const open = name => page.getByRole('button', { name: `Open ${name}`, exact: true });
    const row = name => page.locator('[data-slot="settings-row"]', { has: open(name) });
    const dialog = page.getByRole('dialog');
    const contents = dialog.getByRole('textbox', { name: 'Contents' });

    await page.goto(url);
    for (const group of ['You', 'Topics', 'Areas', 'People'])
      await page.getByRole('heading', { name: group, exact: true }).waitFor();
    await open('Preferences').waitFor();
    await row('Preferences').getByText('How you want Bud to respond', { exact: true }).waitFor();
    await row('Hiring').getByText('Updated yesterday', { exact: true }).waitFor();
    await open('Sam Lee').waitFor();

    await open('Career').click();
    assert.equal(await contents.inputValue(), 'Working towards a COO role next year.');
    await contents.fill('Working towards a COO role in 2027.');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.getByText('Saved. Bud uses the new version from now on.', { exact: true }).waitFor();
    await contents.fill('x'.repeat(8193));
    await dialog.getByText('This file is too long. Shorten it to under 8 KB, then save.', { exact: true }).waitFor();
    assert.ok(await dialog.getByRole('button', { name: 'Save', exact: true }).isDisabled());
    await contents.fill('Working towards a COO role in 2027.');
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByText('Career deleted.', { exact: true }).waitFor();
    assert.equal(await open('Career').count(), 0);
    await page.getByText('No topics yet. Bud adds them as subjects come up in your chats.', { exact: true }).waitFor();

    await open('Preferences').click();
    await dialog.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Clear', exact: true }).click();
    await page.getByText('Preferences cleared.', { exact: true }).waitFor();
    await row('Preferences').getByText('Empty', { exact: true }).waitFor();

    const instruction = page.getByRole('textbox', { name: 'Tell Bud what to remember' });
    await instruction.fill('I lead Project Falcon');
    await page.getByRole('button', { name: 'Update memory', exact: true }).click();
    await page.getByText('Updated Profile. Added Project Falcon.', { exact: true }).waitFor();
    await open('Project Falcon').waitFor();
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
    await open('Profile').click();
    await contents.fill('Head of operations. Based in Berlin.');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.getByText(/This file changed after you opened it, so nothing was saved\./).waitFor();
    await dialog.getByRole('button', { name: 'Reload', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role=dialog] textarea')?.value.includes('London'));
    assert.equal(await contents.inputValue(), 'Head of operations at Tulip demo. Based in London.');

    await page.goto(`${url}?memoryScenario=instruct-error`);
    await instruction.fill('I moved to Berlin');
    await page.getByRole('button', { name: 'Update memory', exact: true }).click();
    await page.getByText(/Your workspace is out of credits\./).waitFor();
    assert.equal(await instruction.inputValue(), 'I moved to Berlin');

    await page.goto(`${url}?memoryScenario=empty`);
    await row('Profile').getByText('Empty', { exact: true }).waitFor();
    await page
      .getByText('No people yet. Bud adds them as you mention people you work with.', { exact: true })
      .waitFor();
    await page.goto(`${url}?memoryScenario=error`);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await open('Preferences').waitFor();
    await page.goto(`${url}?memoryScenario=slow`);
    await page.getByRole('heading', { name: 'Loading your memory', exact: true }).waitFor();
    await open('Preferences').waitFor();
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
});
