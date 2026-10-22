import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { skillImportFixture } from './skill-import.fixture.mjs';

test(
  'skills import supports one reviewed decision, safe file reading, and a lost response',
  { timeout: 60000 },
  async () => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0 },
      logLevel: 'error',
    });
    await server.listen();
    const browser = await chromium.launch();
    let activePage;
    try {
      const fixture = skillImportFixture();
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
      const page = await context.newPage(),
        errors = [];
      activePage = page;
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/v1/**', route => {
        const request = route.request();
        return route.fulfill(fixture.respond(request.method(), request.url(), request.postDataJSON()));
      });
      await page.goto(`${server.resolvedUrls.local[0]}${fixture.workspace.slug}/skills`);
      await page.getByRole('heading', { name: 'No workspace skills yet' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Create skill', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Import skill', exact: true }).first().click();
      await page.getByLabel('Source URL').fill('https://github.com/example/business-skills');
      await page.getByRole('button', { name: 'Find skills', exact: true }).click();
      await page.getByRole('group', { name: 'Choose skills to review' }).waitFor();
      await page.getByRole('checkbox').first().check();
      await page.getByRole('button', { name: 'Review selected skills', exact: true }).click();
      const install = page.getByRole('button', { name: 'Install and enable', exact: true });
      await install.waitFor();
      assert.equal(await install.isDisabled(), true);
      await page.getByRole('button', { name: 'Read package files', exact: true }).click();
      await page.getByRole('button', { name: 'references/guide.md', exact: true }).click();
      await page
        .getByRole('region', { name: 'File references/guide.md' })
        .getByText(/<img src=/)
        .waitFor();
      assert.equal(await page.locator('img[src="https://external.invalid/tracker"]').count(), 0);
      for (const [width, colorScheme] of [
        [320, 'light'],
        [375, 'dark'],
        [414, 'light'],
        [768, 'dark'],
        [1280, 'light'],
      ]) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          `No page overflow at ${width}`,
        );
      }
      await page.getByRole('checkbox', { name: 'I have read the high-risk warnings' }).check();
      fixture.loseNextDecision();
      await install.click();
      await page.getByRole('button', { name: 'Retry same operation' }).click();
      await page.getByRole('heading', { name: 'Skills installed and enabled' }).waitFor();
      assert.equal(fixture.installed.length, 1);
      const decisions = fixture.requests.filter(request => request.path.endsWith('/decision'));
      assert.equal(decisions.length, 2);
      assert.deepEqual(decisions[0].body, decisions[1].body);
      await page.getByRole('link', { name: 'Open monthly-close' }).click();
      await page.getByRole('heading', { name: 'monthly-close', exact: true }).waitFor();
      assert.equal(await page.getByRole('textbox').count(), 0, 'There is no manual skill editor');
      await page.getByRole('button', { name: 'Read package files', exact: true }).click();
      await page.getByRole('button', { name: 'SKILL.md', exact: true }).click();
      await page
        .getByRole('region', { name: 'File SKILL.md' })
        .getByText(/name: monthly-close/)
        .waitFor();
      assert.deepEqual(errors, []);
      await context.close();
    } catch (error) {
      if (activePage && !activePage.isClosed()) {
        await activePage.screenshot({ path: '/tmp/debug-skill-import.png', fullPage: true });
        console.error(await activePage.locator('main').last().innerText());
      }
      throw error;
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
