import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { catalogFixture } from '../src/features/models/catalog-fixture.ts';
import { membership, credits, notifyChange } from './chat-query.fixture.mjs';
import { startBuiltApp, builderBrowserOptions, captureBrowserFailure } from './built-app.fixture.mjs';
import { modelOption, modelPicker } from './browser-controls.mjs';

const server = await startBuiltApp();
const { origin } = server;
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  name: 'Acme',
  status: 'ready',
  createdAt: '2026-10-01T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
const otherWorkspace = { ...workspace, id: '22222222-2222-4222-8222-222222222222', slug: 'other', name: 'Other' };
const catalog = catalogFixture()
  .families.filter(family => family.vendor !== 'google')
  .map(family => ({ ...family, mappingRevision: 'fixture', pricingRevision: 'fixture' }));
const defaultChatFamilyId = 'claude-sonnet';
const defaultModel = catalog.find(family => family.id === defaultChatFamilyId).displayName;
let browser;
let activePage;
try {
  browser = await chromium.launch(builderBrowserOptions());
  for (const mobile of [false, true])
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      activePage = page;
      let status = 200;
      let items = catalog;
      let wait = 300;
      let userId = 'ada';
      const preferences = new Map();
      let saveStatus = 200;
      let saves = 0;
      // While set, preference saves and catalog reads wait until the test has seen their pending state.
      let holdSave = null;
      let holdCatalog = Promise.withResolvers();
      await page.route('**/v1/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/governance/me')) return route.fulfill({ json: membership });
        if (path.endsWith('/credits')) return route.fulfill({ json: credits });
        if (path === '/v1/auth/update-user') {
          saves++;
          await delay(150);
          await holdSave?.promise;
          if (saveStatus === 200) preferences.set(userId, route.request().postDataJSON().lastModelFamilyId);
          return route.fulfill({
            status: saveStatus,
            json: saveStatus === 200 ? { status: true } : { message: 'Could not save' },
          });
        }
        if (path.endsWith('/model-catalog')) {
          await delay(wait);
          await holdCatalog?.promise;
          return route.fulfill({
            status,
            json: status === 200 ? { families: items, defaultChatFamilyId } : { error: 'unavailable' },
          });
        }
        const json =
          path === '/v1/auth/get-session'
            ? {
                session: { id: `fixture-${userId}`, userId },
                user: {
                  id: userId,
                  name: 'Ada',
                  email: `${userId}@example.com`,
                  lastModelFamilyId: preferences.get(userId) ?? null,
                },
              }
            : path === '/v1/workspaces'
              ? [workspace, otherWorkspace]
              : path === '/v1/workspaces/acme'
                ? workspace
                : path === '/v1/workspaces/other'
                  ? otherWorkspace
                  : {};
        await route.fulfill({ json });
      });
      await page.goto(`${origin}/acme`);
      await page.getByText('Checking available models…', { exact: true }).waitFor();
      holdCatalog.resolve();
      holdCatalog = null;
      await modelPicker(page, defaultModel).click();
      await page.getByRole('menuitemradio').first().waitFor();
      assert.equal(await page.getByRole('menuitemradio').count(), 13);
      assert.equal(await page.getByRole('menuitemradio', { name: /Gemini/ }).count(), 0);
      for (const [name, brand] of [
        ['Claude Haiku 4.5', 'claude'],
        ['GPT-6 Astra', 'openai'],
        ['DeepSeek V4 Pro', 'deepseek'],
        ['Grok 4.6', 'grok'],
        ['Kimi K2.6', 'kimi'],
      ]) {
        const row = modelOption(page, name);
        assert.notEqual(await row.getAttribute('aria-disabled'), 'true');
        assert.equal(await row.locator(`[data-brand="${brand}"] svg`).count(), 1);
      }
      assert.equal(saves, 0, 'The automatic initial choice is not a user preference');
      const deepseek = modelOption(page, 'DeepSeek V4 Pro').locator('[data-brand="deepseek"] svg');
      assert.equal(
        await deepseek.evaluate(
          glyph => glyph.querySelector('path') !== null && glyph.getBoundingClientRect().width > 0,
        ),
        true,
      );
      holdSave = Promise.withResolvers();
      await modelOption(page, 'Grok 4.3 Fast').click();
      await modelPicker(page, 'Grok 4.3 Fast').waitFor();
      await page.getByText('Saving your default model…', { exact: true }).waitFor();
      assert.equal(await modelPicker(page, 'Grok 4.3 Fast').isDisabled(), true);
      holdSave.resolve();
      holdSave = null;
      await page.getByText('Saving your default model…', { exact: true }).waitFor({ state: 'hidden' });
      assert.equal(preferences.get('ada'), 'grok-fast');
      await page.reload();
      await modelPicker(page, 'Grok 4.3 Fast').waitFor();
      assert.equal(await page.getByText(/Your last model is no longer available/).count(), 0);
      await page.goto(`${origin}/other`);
      await modelPicker(page, 'Grok 4.3 Fast').waitFor();
      userId = 'grace';
      await page.reload();
      await modelPicker(page, defaultModel).waitFor();
      // A saved model the operator removed from the catalog falls back to the default, with a notice.
      userId = 'lin';
      preferences.set('lin', 'retired-model');
      await page.reload();
      await modelPicker(page, defaultModel).waitFor();
      await page
        .getByText('Your last model is no longer available. New messages use Claude Sonnet 5.', { exact: true })
        .waitFor();
      await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
      await page.getByText(/Your last model is no longer available/).waitFor({ state: 'hidden' });
      await page.reload();
      await modelPicker(page, defaultModel).waitFor();
      assert.equal(await page.getByText(/Your last model is no longer available/).count(), 0);
      userId = 'ada';
      await page.goto(`${origin}/acme`);
      await modelPicker(page, 'Grok 4.3 Fast').click();
      saveStatus = 503;
      await modelOption(page, 'Claude Haiku 4.5').click();
      await page.getByText('Saving your default model…', { exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await page.getByText(/Could not save your default model/).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Retry saving default', exact: true }).count(), 0);
      await modelPicker(page, 'Claude Haiku 4.5').waitFor();
      assert.equal(preferences.get('ada'), 'grok-fast');
      saveStatus = 200;
      await modelPicker(page, 'Claude Haiku 4.5').click();
      await modelOption(page, 'Claude Haiku 4.5').click();
      await page.getByText('Saving your default model…', { exact: true }).waitFor({ state: 'hidden' });
      assert.equal(preferences.get('ada'), 'claude-haiku');
      await page.reload();
      await modelPicker(page, 'Claude Haiku 4.5').waitFor();
      const message = page.getByRole('textbox', { name: 'Message', exact: true });
      await message.fill('Keep this draft');
      status = 503;
      wait = 0;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await delay(300);
      assert.equal(await page.getByText('Could not check model availability. Try again.', { exact: true }).count(), 0);
      await notifyChange(page, workspace.id, userId, 'catalog');
      await page.getByText('Could not check model availability. Try again.', { exact: true }).waitFor();
      assert.equal(await message.innerText(), 'Keep this draft');
      assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), false);
      status = 200;
      await notifyChange(page, workspace.id, userId, 'catalog');
      await page.waitForFunction(() => !document.querySelector('button[aria-label="Send message"]').disabled);
      items = catalog.map(family =>
        family.id === 'claude-haiku'
          ? {
              ...family,
              available: false,
              unavailableReason: 'workspace-disabled',
              mappingRevision: null,
              pricingRevision: null,
            }
          : family,
      );
      await notifyChange(page, workspace.id, userId, 'catalog');
      // A selection that becomes disabled falls back to the workspace default and says so.
      await modelPicker(page, defaultModel).waitFor();
      await page
        .getByText('Your last model is no longer available. New messages use Claude Sonnet 5.', { exact: true })
        .waitFor();
      assert.equal(await message.innerText(), 'Keep this draft');
      assert.equal(preferences.get('ada'), 'claude-haiku');
      items = catalog.filter(family => family.id !== 'claude-haiku');
      await notifyChange(page, workspace.id, userId, 'catalog');
      await modelPicker(page, 'Claude Haiku 4.5').waitFor({ state: 'hidden' });
      assert.equal(await page.getByText(/Claude Haiku 4.5/).count(), 0);
      assert.equal(preferences.get('ada'), 'claude-haiku');
      userId = 'new-user';
      items = [];
      await page.goto(`${origin}/acme`);
      await page
        .getByText('No models configured. An operator needs to set up a model provider.', { exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole('link', { name: 'Model setup guide' }).getAttribute('href'),
        'https://tulipfarm.ai/docs/self-hosting/models/',
      );
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.close();
      console.log(
        `${mobile ? 'Mobile' : 'Desktop'} ${theme}: pricing, persisted user choice, workspace switching, account isolation, save recovery, unavailable preference, keyboard, search, loading, empty and retry passed.`,
      );
    }
} catch (error) {
  await captureBrowserFailure(activePage, 'model-picker');
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
