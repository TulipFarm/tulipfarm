import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { defaultChatModelFamilyId } from '@tulipfarm/config/model-catalog';
import { catalogFixture } from '../src/features/models/catalog-fixture.ts';
import { membership, credits, notifyChange } from './chat-query.fixture.mjs';
import { startBuiltApp, builderBrowserOptions, captureBrowserFailure } from './built-app.fixture.mjs';
import { modelOption } from './browser-controls.mjs';

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
const defaultModelName = `Model: ${catalog.find(family => family.id === defaultChatModelFamilyId).displayName}`;
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
      await page.route('**/v1/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/governance/me')) return route.fulfill({ json: membership });
        if (path.endsWith('/credits')) return route.fulfill({ json: credits });
        if (path === '/v1/auth/update-user') {
          saves++;
          await delay(150);
          if (saveStatus === 200) preferences.set(userId, route.request().postDataJSON().lastModelFamilyId);
          return route.fulfill({
            status: saveStatus,
            json: saveStatus === 200 ? { status: true } : { message: 'Could not save' },
          });
        }
        if (path.endsWith('/model-catalog')) {
          await delay(wait);
          return route.fulfill({ status, json: status === 200 ? { families: items } : { error: 'unavailable' } });
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
      await page.getByRole('combobox', { name: defaultModelName, exact: true }).click();
      await page.getByRole('option').first().waitFor();
      assert.equal(await page.getByRole('option').count(), 13);
      assert.equal(await page.getByRole('option', { name: /Gemini/ }).count(), 0);
      for (const [name, brand] of [
        ['Claude Haiku', 'claude'],
        ['GPT Astra', 'openai'],
        ['DeepSeek Pro', 'deepseek'],
        ['Grok', 'grok'],
        ['Kimi', 'kimi'],
      ]) {
        const row = modelOption(page, name);
        assert.notEqual(await row.getAttribute('aria-disabled'), 'true');
        assert.equal(await row.locator(`[data-brand="${brand}"] svg`).count(), 1);
      }
      assert.equal(saves, 0, 'The automatic initial choice is not a user preference');
      const deepseek = modelOption(page, 'DeepSeek Pro').locator('[data-brand="deepseek"] svg');
      assert.equal(
        await deepseek.evaluate(
          glyph => glyph.querySelector('path') !== null && glyph.getBoundingClientRect().width > 0,
        ),
        true,
      );
      const search = page.getByRole('combobox', { name: 'Search models' });
      await search.fill('no-such-model');
      await page.getByText('No models found.', { exact: true }).waitFor();
      await search.fill('Grok Fast');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.getByRole('combobox', { name: 'Model: Grok Fast', exact: true }).waitFor();
      await page.getByText('Saving your default model…', { exact: true }).waitFor();
      assert.equal(await page.getByRole('combobox', { name: 'Model: Grok Fast', exact: true }).isDisabled(), true);
      await page.getByText('Saving your default model…', { exact: true }).waitFor({ state: 'hidden' });
      assert.equal(preferences.get('ada'), 'grok-fast');
      await page.reload();
      await page.getByRole('combobox', { name: 'Model: Grok Fast', exact: true }).waitFor();
      await page.goto(`${origin}/other`);
      await page.getByRole('combobox', { name: 'Model: Grok Fast', exact: true }).waitFor();
      userId = 'grace';
      await page.reload();
      await page.getByRole('combobox', { name: defaultModelName, exact: true }).waitFor();
      userId = 'ada';
      await page.goto(`${origin}/acme`);
      await page.getByRole('combobox', { name: 'Model: Grok Fast', exact: true }).click();
      saveStatus = 503;
      await modelOption(page, 'Claude Haiku').click();
      await page.getByRole('button', { name: 'Retry saving default', exact: true }).waitFor();
      assert.equal(preferences.get('ada'), 'grok-fast');
      saveStatus = 200;
      await page.getByRole('button', { name: 'Retry saving default', exact: true }).click();
      await page.getByText('Saving your default model…', { exact: true }).waitFor({ state: 'hidden' });
      assert.equal(preferences.get('ada'), 'claude-haiku');
      await page.reload();
      await page.getByRole('combobox', { name: 'Model: Claude Haiku', exact: true }).waitFor();
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
      await page.getByRole('button', { name: 'Retry models', exact: true }).click();
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
      await page
        .getByText('Claude Haiku is disabled in this workspace. Choose another model.', { exact: true })
        .waitFor();
      assert.equal(preferences.get('ada'), 'claude-haiku');
      items = catalog.filter(family => family.id !== 'claude-haiku');
      await notifyChange(page, workspace.id, userId, 'catalog');
      await page.getByRole('combobox', { name: 'Model: Claude Haiku', exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await page.getByText(/Claude Haiku/).count(), 0);
      assert.equal(preferences.get('ada'), 'claude-haiku');
      userId = 'new-user';
      items = [];
      await page.goto(`${origin}/acme`);
      await page
        .getByText('No models configured. An operator needs to set up a model provider.', { exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole('link', { name: 'Model setup guide' }).getAttribute('href'),
        'https://docs.tulipfarm.ai/self-hosting/models/',
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
