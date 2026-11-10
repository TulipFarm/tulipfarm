import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { skillImportFixture } from './skill-import.fixture.mjs';
import { catalogFamily } from '../src/features/models/catalog-fixture.ts';
import { notifyChange } from './chat-query.fixture.mjs';
import { startBuiltApp, captureBrowserFailure } from './built-app.fixture.mjs';

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
      let releaseFirstDraft;
      const firstDraft = new Promise(resolve => {
        releaseFirstDraft = resolve;
      });
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/v1/**', route => {
        const request = route.request();
        if (new URL(request.url()).pathname.endsWith('/draft')) {
          attempts.push({ url: request.url(), body: request.postDataJSON() });
          if (attempts.length === 1)
            return firstDraft.then(() => route.fulfill({ status: 503, json: { error: 'skill-import-unavailable' } }));
        }
        return route.fulfill(fixture.respond(request.method(), request.url(), request.postDataJSON()));
      });
      await page.goto(`${server.resolvedUrls.local[0]}${fixture.workspace.slug}/skills`);
      await page.getByRole('link', { name: 'Create manually', exact: true }).click();
      await page.getByRole('heading', { name: 'Create skill', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Review skill', exact: true }).click();
      for (const message of ['Enter a name.', 'Enter a description.', 'Enter instructions.'])
        await page.getByText(message, { exact: true }).waitFor();
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
      await page.getByText('Starting review…', { exact: true }).waitFor();
      assert.equal(await page.getByText('Starting review…', { exact: true }).count(), 1);
      assert.equal(await page.getByText('Submitting your operation…', { exact: true }).count(), 0);
      releaseFirstDraft();
      await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
      assert.equal(await page.getByText('Starting review…', { exact: true }).count(), 0);
      assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Monthly close');
      assert.equal(
        await page.getByLabel('Instructions', { exact: true }).inputValue(),
        'Read the guide, check the totals, and ask before any change.',
      );
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      const install = page.getByRole('button', { name: 'Install and enable', exact: true });
      await install.waitFor();
      await page.getByText('Written by you', { exact: true }).waitFor();
      assert.deepEqual(attempts[1], attempts[0]);
      assert.equal(fixture.installed.length, 0);
      assert.equal(
        fixture.requests.some(request => request.path.includes('/conversations')),
        false,
      );
      const draft = fixture.requests.find(request => request.path.endsWith('/draft'));
      assert.equal(draft.body.name, 'Monthly close');
      assert.equal(draft.body.instructions, 'Read the guide, check the totals, and ask before any change.');
      const proposal = fixture.imports.get(draft.path.split('/').at(-2));
      proposal.candidates[0].source.canonicalUrl = 'chat';
      await page.reload();
      await page.getByText('Drafted in chat', { exact: true }).waitFor();
      proposal.candidates[0].source.canonicalUrl = 'manual';
      await page.reload();
      await page.getByText('Written by you', { exact: true }).waitFor();
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
  { timeout: 90000 },
  async () => {
    const server = await startBuiltApp();
    const browser = await chromium.launch();
    let activePage;
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
      activePage = page;
      const savedModels = [];
      const sends = [];
      const chats = new Map();
      await page.route('**/v1/**', route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.endsWith('/model-catalog')) return route.fulfill({ json: catalog });
        if (path === '/v1/auth/update-user') {
          const model = request.postDataJSON().lastModelFamilyId;
          savedModels.push(model);
          fixture.session.user.lastModelFamilyId = model;
          return route.fulfill({ json: { status: true } });
        }
        const conversation = /\/conversations\/([\w-]+)(\/.*)?$/.exec(path);
        if (conversation) {
          const [, id, rest = ''] = conversation;
          if (request.method() === 'PUT' && !rest) {
            chats.set(id, {
              id,
              title: 'Weekly summary',
              titleRevision: 1,
              archived: false,
              activityAt: '2026-10-01T00:00:00Z',
              createdAt: '2026-10-01T00:00:00Z',
            });
            return route.fulfill({ json: { id } });
          }
          if (request.method() === 'PUT' && rest.startsWith('/messages/')) {
            const body = request.postDataJSON();
            sends.push(body);
            chats.get(id).model = body.model;
            return route.fulfill({
              json: { messageId: rest.split('/').at(-1), turnId: crypto.randomUUID(), sequence: 1 },
            });
          }
          if (rest === '/messages')
            return route.fulfill({ json: { messages: [], nextBefore: null, hasGitHubProposals: false } });
          if (!rest) return route.fulfill({ json: chats.get(id) });
        }
        return route.fulfill(fixture.respond(request.method(), request.url(), request.postDataJSON()));
      });
      await page.goto(`${server.origin}/${fixture.workspace.slug}/skills`);
      assert.equal(
        await page.getByRole('link', { name: 'New skill', exact: true }).getAttribute('aria-description'),
        'Opens a chat with Bud',
      );
      await page.getByRole('link', { name: 'New skill', exact: true }).click();
      await page.getByRole('combobox', { name: /Model: Grok Fast/ }).waitFor();
      await page.getByText('Create a reusable skill · Version latest', { exact: true }).waitFor();
      const message = page.getByRole('textbox', { name: 'Message', exact: true });
      await message.fill('Create a weekly summary with completed work, open questions, and next actions.');
      await message.press('Enter');
      await page.waitForFunction(
        () => document.querySelector('[role="textbox"][aria-label="Message"]')?.textContent === '',
      );
      assert.equal(sends[0].model, 'grok-fast');
      assert.deepEqual(savedModels, [], 'Sending an applied workspace default must not save a preference');
      await page.goto(`${server.origin}/${fixture.workspace.slug}`);
      await page.getByRole('combobox', { name: 'Model: DeepSeek Pro', exact: true }).waitFor();
      await page.getByRole('combobox', { name: 'Model: DeepSeek Pro', exact: true }).click();
      await page.getByRole('option', { name: /Grok Fast/ }).click();
      await page.getByText('Saving your default model…', { exact: true }).waitFor({ state: 'hidden' });
      await message.fill('Summarize this week.');
      await message.press('Enter');
      await page.waitForFunction(
        () => document.querySelector('[role="textbox"][aria-label="Message"]')?.textContent === '',
      );
      assert.equal(sends.at(-1).model, 'grok-fast');
      assert.deepEqual(savedModels, ['grok-fast']);
      await page.goto(`${server.origin}/${fixture.workspace.slug}`);
      await page.getByRole('combobox', { name: 'Model: Grok Fast', exact: true }).waitFor();
      await page.getByRole('link', { name: 'Skills', exact: true }).click();
      await page.getByRole('link', { name: 'New skill', exact: true }).click();
      await page.getByRole('combobox', { name: /Model: Grok Fast/ }).click();
      await page.getByRole('option', { name: /Kimi/ }).click();
      await page.getByRole('combobox', { name: /Model: Kimi/ }).waitFor();
      assert.deepEqual(savedModels, ['grok-fast', 'kimi']);
      await notifyChange(page, fixture.workspace.id, fixture.session.user.id, 'catalog');
      await page.getByRole('combobox', { name: /Model: Kimi/ }).waitFor();
      await page.goto(`${server.origin}/${fixture.workspace.slug}`);
      await page.getByRole('combobox', { name: 'Model: Kimi', exact: true }).waitFor();
      await page.getByRole('link', { name: 'Skills', exact: true }).click();
      await page.getByRole('link', { name: 'New skill', exact: true }).click();
      await page.getByRole('combobox', { name: 'Model: Grok Fast', exact: true }).click();
      await page.getByRole('option', { name: /Kimi/ }).click();
      await page.getByRole('combobox', { name: 'Model: Kimi', exact: true }).waitFor();
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
    } catch (error) {
      await captureBrowserFailure(activePage, 'skill-model-default');
      throw error;
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
