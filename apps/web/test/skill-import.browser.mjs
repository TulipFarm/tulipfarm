import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { skillImportFixture } from './skill-import.fixture.mjs';
import { catalogFamily } from '../src/features/models/catalog-fixture.ts';
import { notifyChange } from './chat-query.fixture.mjs';

test(
  'a procedure can be created without chat and still requires the package review decision',
  { timeout: 60000 },
  async () => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0 },
      logLevel: 'error',
    });
    await server.listen();
    const browser = await chromium.launch();
    try {
      const fixture = skillImportFixture();
      fixture.workspace.name = 'Acme';
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
      const errors = [];
      const attempts = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/v1/**', route => {
        const request = route.request();
        if (new URL(request.url()).pathname.endsWith('/draft')) {
          attempts.push({ url: request.url(), body: request.postDataJSON() });
          if (attempts.length === 1) return route.fulfill({ status: 503, json: { error: 'skill-import-unavailable' } });
        }
        return route.fulfill(fixture.respond(request.method(), request.url(), request.postDataJSON()));
      });
      await page.goto(`${server.resolvedUrls.local[0]}${fixture.workspace.slug}/skills`);
      await page.getByRole('link', { name: 'Create manually', exact: true }).click();
      await page.getByRole('heading', { name: 'Create skill', exact: true }).waitFor();
      await page.getByLabel('Name', { exact: true }).fill('Monthly close');
      await page
        .getByLabel('Description', { exact: true })
        .fill('Prepare a monthly close with a clear list of checks.');
      await page
        .getByLabel('Instructions', { exact: true })
        .fill('Read the guide, check the totals, and ask before any change.');
      for (const [width, colorScheme] of [
        [390, 'dark'],
        [1280, 'light'],
      ]) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      await page.screenshot({ path: '/tmp/skill-create-form.png', fullPage: true });
      await page.getByRole('button', { name: 'Review skill', exact: true }).click();
      await page.getByRole('button', { name: 'Retry same operation', exact: true }).waitFor();
      assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Monthly close');
      assert.equal(
        await page.getByLabel('Instructions', { exact: true }).inputValue(),
        'Read the guide, check the totals, and ask before any change.',
      );
      await page.getByRole('button', { name: 'Retry same operation', exact: true }).click();
      const install = page.getByRole('button', { name: 'Install and enable', exact: true });
      await install.waitFor();
      assert.deepEqual(attempts[1], attempts[0]);
      assert.equal(fixture.installed.length, 0);
      assert.equal(
        fixture.requests.some(request => request.path.includes('/conversations')),
        false,
      );
      const draft = fixture.requests.find(request => request.path.endsWith('/draft'));
      assert.equal(draft.body.name, 'Monthly close');
      assert.equal(draft.body.instructions, 'Read the guide, check the totals, and ask before any change.');
      await page.getByRole('button', { name: 'Read package files', exact: true }).click();
      await page.getByRole('button', { name: 'SKILL.md', exact: true }).click();
      await page
        .getByRole('region', { name: 'File SKILL.md' })
        .getByText(/name: monthly-close/)
        .waitFor();
      await page.getByRole('checkbox', { name: 'I have read the high-risk warnings' }).check();
      await install.click();
      await page.getByRole('heading', { name: 'Skills installed and enabled' }).waitFor();
      assert.equal(fixture.installed.length, 1);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test(
  'New skill uses the workspace default and replaces stale models without replacing a valid choice',
  { timeout: 60000 },
  async () => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0 },
      logLevel: 'error',
    });
    await server.listen();
    const browser = await chromium.launch();
    try {
      const fixture = skillImportFixture();
      fixture.workspace.name = 'Acme';
      fixture.session.user.lastModelFamilyId = 'deepseek-pro';
      const catalog = {
        families: [catalogFamily('deepseek-pro'), catalogFamily('grok-fast'), catalogFamily('kimi')],
        imageModels: [],
        defaultChatFamilyId: 'grok-fast',
      };
      const page = await browser.newPage();
      await page.route('**/v1/**', route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.endsWith('/model-catalog')) return route.fulfill({ json: catalog });
        if (path === '/v1/auth/update-user') return route.fulfill({ json: { status: true } });
        return route.fulfill(fixture.respond(request.method(), request.url(), request.postDataJSON()));
      });
      await page.goto(`${server.resolvedUrls.local[0]}${fixture.workspace.slug}/skills`);
      await page.getByRole('link', { name: 'New skill', exact: true }).click();
      await page.getByRole('combobox', { name: /Model: Grok Fast/ }).waitFor();
      await page.getByText('Create a reusable skill · Version latest', { exact: true }).waitFor();
      await page.getByRole('combobox', { name: /Model: Grok Fast/ }).click();
      await page.getByRole('option', { name: /Kimi/ }).click();
      await page.getByRole('combobox', { name: /Model: Kimi/ }).waitFor();
      await notifyChange(page, fixture.workspace.id, fixture.session.user.id, 'catalog');
      await page.getByRole('combobox', { name: /Model: Kimi/ }).waitFor();
      catalog.families = catalog.families.map(family =>
        family.id === 'kimi' ? { ...family, available: false, unavailableReason: 'model-family-unavailable' } : family,
      );
      await notifyChange(page, fixture.workspace.id, fixture.session.user.id, 'catalog');
      await page.getByRole('combobox', { name: /Model: Grok Fast/ }).waitFor();
      await page.screenshot({ path: '/tmp/skill-create-model.png', fullPage: true });
      assert.equal(
        fixture.requests.some(request => request.path.includes('/skills/workspace-skill-authoring')),
        false,
      );
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

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
