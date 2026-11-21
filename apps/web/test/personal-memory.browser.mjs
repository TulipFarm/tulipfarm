import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test(
  'profile memory supports editing, limits, clear, conflict and uncertain-save recovery',
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
      const editor = page.getByRole('textbox', { name: 'Your preferences', exact: true });
      const save = page.getByRole('button', { name: 'Save memory', exact: true });
      await page.goto(url.replace('/account', '/'));
      await page.getByRole('heading', { name: 'Workspace identity', exact: true }).waitFor();
      assert.equal(await page.getByText('workspace settings unavailable', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Save name', exact: true }).count(), 0);
      await page.getByRole('link', { name: 'Account', exact: true }).click();
      await editor.waitFor();
      assert.equal(page.url(), url);
      assert.match(await editor.inputValue(), /short, friendly replies/);
      await editor.fill('Use emojis. Explain unfamiliar words.');
      await save.click();
      await page.getByText('Memory saved. Your next private replies will use it.', { exact: true }).waitFor();
      await page.getByRole('link', { name: 'General', exact: true }).click();
      await page.getByRole('heading', { name: 'Workspace identity', exact: true }).waitFor();
      await page.getByRole('link', { name: 'Account', exact: true }).click();
      assert.equal(await editor.inputValue(), 'Use emojis. Explain unfamiliar words.');
      await editor.fill('🌷'.repeat(10000));
      await save.click();
      await page.getByText('Memory saved. Your next private replies will use it.', { exact: true }).waitFor();
      await editor.fill('🌷'.repeat(10001));
      await save.click();
      await page.getByText('Use valid text with no more than 10,000 characters.', { exact: true }).waitFor();
      assert.equal(await editor.inputValue(), '🌷'.repeat(10001));
      await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
      assert.equal(await editor.inputValue(), '🌷'.repeat(10000));
      await editor.fill('');
      await save.click();
      await page.getByText(/No preferences saved yet/).waitFor();
      for (const width of [320, 375, 768, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `no page overflow at ${width}`,
        );
        await editor.fill(`Use plain words at ${width}.`);
        await save.click();
        await page.getByText('Memory saved. Your next private replies will use it.', { exact: true }).waitFor();
      }
      await page.goto(`${url}?memoryScenario=conflict`);
      await editor.fill('My manual preference.');
      await save.click();
      assert.equal(await page.getByRole('button', { name: 'Discard changes', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Check saved memory', exact: true }).click();
      await page
        .getByText('Review the latest saved memory before replacing it with your draft.', { exact: true })
        .waitFor();
      assert.equal(await editor.inputValue(), 'My manual preference.');
      assert.equal(await page.getByRole('button', { name: 'Discard changes', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Keep my draft', exact: true }).click();
      await save.click();
      await page.getByText('Memory saved. Your next private replies will use it.', { exact: true }).waitFor();
      await page.goto(`${url}?memoryScenario=lost-save`);
      await editor.fill('Use plain words.');
      await save.click();
      await page.getByRole('button', { name: 'Check saved memory', exact: true }).click();
      await page.getByText('Memory saved. Your next private replies will use it.', { exact: true }).waitFor();
      assert.equal(await editor.inputValue(), 'Use plain words.');
      await page.goto(`${url}?memoryScenario=error`);
      await page.getByRole('button', { name: 'Retry loading memory', exact: true }).click();
      await editor.waitFor();
      await page.goto(`${url}?memoryScenario=slow`);
      await page.getByRole('heading', { name: 'Loading your memory', exact: true }).waitFor();
      assert.equal(await page.getByText(/No preferences saved yet/).count(), 0);
      await editor.waitFor();
      await page.goto(`${url}?memoryScenario=denied`);
      await page.getByRole('heading', { name: 'Memory is unavailable', exact: true }).waitFor();
      assert.equal(await editor.count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test('suggested memory changes can be confirmed, dismissed, or shown as out of date', { timeout: 90000 }, async () => {
  const server = await createServer({
    root: new URL('..', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  // Set MEMORY_SHOTS to a directory to save screenshots of each state.
  const shot = async (page, name) => {
    if (!process.env.MEMORY_SHOTS) return;
    await page.getByRole('region', { name: 'Suggested changes' }).screenshot({
      path: `${process.env.MEMORY_SHOTS}/${name}.png`,
    });
  };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1400 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const url = `http://127.0.0.1:${server.httpServer.address().port}/memory-mock/settings/account`;
    const editor = page.getByRole('textbox', { name: 'Your preferences', exact: true });
    const list = page.getByRole('list', { name: 'Suggested changes' });
    const card = name => list.getByRole('region', { name: `Suggested change: ${name}` });

    await page.goto(`${url}?proposalScenario=pending`);
    await card('Add to your memory').waitFor();
    await list.getByText('“Please always use British spelling.”').waitFor();
    await list.getByText('From the chat “Launch plan”').waitFor();
    await shot(page, 'pending');
    await editor.fill('Unsaved edit.');
    await card('Add to your memory').getByText('Save or discard your edits first.').waitFor();
    assert.ok(await card('Add to your memory').getByRole('button', { name: 'Confirm', exact: true }).isDisabled());
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await card('Add to your memory').getByRole('button', { name: 'Confirm', exact: true }).click();
    await page.getByText('Memory updated. Your next private replies will use it.', { exact: true }).waitFor();
    assert.match(await editor.inputValue(), /Answer in British English\.$/);
    await card('Change your memory').getByRole('button', { name: 'Dismiss', exact: true }).click();
    await page.getByText('Suggestion dismissed. Your memory didn’t change.', { exact: true }).waitFor();
    await page.getByText('No suggestions right now.', { exact: true }).waitFor();
    await shot(page, 'empty');

    await page.goto(`${url}?proposalScenario=outdated`);
    const outdated = card('Change your memory');
    await outdated.getByText('Out of date', { exact: true }).waitFor();
    assert.equal(await outdated.getByRole('button', { name: 'Confirm', exact: true }).count(), 0);
    await shot(page, 'outdated');
    await outdated.getByRole('button', { name: 'Update suggestion', exact: true }).click();
    await outdated.getByText('This suggestion no longer fits your memory. Dismiss it.', { exact: true }).waitFor();
    await shot(page, 'outdated-no-longer-fits');
    await outdated.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await page.getByText('Suggestion dismissed. Your memory didn’t change.', { exact: true }).waitFor();

    await page.goto(`${url}?proposalScenario=error`);
    await page.getByRole('heading', { name: 'Suggestions could not load', exact: true }).waitFor();
    await shot(page, 'error');
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByText('No suggestions right now.', { exact: true }).waitFor();

    await page.goto(`${url}?memoryScenario=empty`);
    await editor.waitFor();
    await page.getByText(/changes are suggested below for you to review\.$/).waitFor();
    await page.getByText('No suggestions right now.', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
});
