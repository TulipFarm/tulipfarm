import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { catalogFamily, catalogFixture } from '../src/features/models/catalog-fixture.ts';
import { membership, credits, notifyChange } from './chat-query.fixture.mjs';
import { governanceSnapshot } from './governance-snapshot.mjs';
import { startBuiltApp, builderBrowserOptions, captureBrowserFailure } from './built-app.fixture.mjs';

// Operator catalog families (MODEL_CATALOG_FILE) carry their own names and vendors; unknown vendors get a neutral logo.
const server = await startBuiltApp();
const { origin } = server;
const shots = process.env.MODEL_BRANDING_SCREENSHOTS;
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  name: 'Acme',
  status: 'ready',
  createdAt: '2026-10-01T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
const base = `/v1/workspaces/${workspace.id}`;
const agentId = '44444444-4444-4444-8444-444444444444';
const teamId = '33333333-3333-4333-8333-333333333333';
const teams = [{ id: teamId, name: 'Engineering' }];
const catalog = {
  families: [
    catalogFamily('acme-chat'),
    catalogFamily('acme-claude'),
    catalogFamily('local-llama'),
    catalogFamily('grok'),
  ],
  defaultChatFamilyId: 'acme-chat',
};
const expected = [
  ['Acme Chat', 'neutral'],
  ['Acme Claude EU', 'claude'],
  ['Local Llama', 'neutral'],
  ['Grok', 'grok'],
];
const agent = {
  id: agentId,
  name: 'Research assistant',
  owningTeamId: teamId,
  savedRevision: 'a'.repeat(40),
  definitionRevision: 'b'.repeat(64),
  definition: {
    name: 'Research assistant',
    instructions: 'Read the supplied business rows.',
    tools: ['schema.inspect'],
    modelFamilyId: 'acme-chat',
  },
  capabilities: ['read', 'edit'],
  admin: false,
  activations: [],
};

async function routeApi(page, read) {
  await page.addInitScript(() => localStorage.setItem('tulipfarm:bud-corner', 'bottom-left'));
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const json = (value, status = 200) => route.fulfill({ status, json: value });
    if (path === '/v1/auth/get-session')
      return json({
        session: { id: 'fixture-session', userId: 'ada' },
        user: { id: 'ada', name: 'Ada', email: 'ada@example.com', lastModelFamilyId: null },
      });
    if (path === '/v1/workspaces') return json([workspace]);
    if (path === '/v1/workspaces/acme') return json(workspace);
    if (path === `${base}/governance/me`) return json(membership);
    if (path === `${base}/governance`)
      return json(
        governanceSnapshot({
          actorMembershipId: membership.membershipId,
          members: [
            { id: membership.membershipId, userId: 'ada', name: 'Ada', email: 'ada@example.com', role: 'admin' },
          ],
          teams: [{ ...teams[0], membershipIds: [membership.membershipId] }],
          resources: [],
          grants: [],
        }),
      );
    if (path === `${base}/credits`) return json(credits);
    if (path === `${base}/model-catalog`) return json(read());
    if (path === `${base}/model-policy/availability`)
      return json({ items: read().families.map(family => ({ familyId: family.id, enabled: true, revision: 0 })) });
    if (path.startsWith(`${base}/model-policy/rules/`))
      return json({
        sourceFamilyId: decodeURIComponent(path.split('/').at(-1)),
        targetFamilyId: null,
        revision: 0,
        editorMembershipId: null,
        updatedAt: null,
      });
    if (path === `${base}/settings`) return json({ error: 'forbidden' }, 403);
    if (path === `${base}/agents/authoring-context`)
      return json({ currentSoulRevision: agent.savedRevision, teams, admin: false });
    if (path === `${base}/workspace-mcp/capabilities`) return json({ enabled: false });
    if (path === `${base}/agents/${agentId}`) return json(agent);
    if (path === `${base}/agents/${agentId}/setup-draft`) return json({ error: 'setup-draft-not-found' }, 404);
    if (path === `${base}/skills`) return json({ workspace: [], nextCursor: null });
    if (path === `${base}/recommendations/events`) return json({ error: 'recommendations-unavailable' }, 503);
    return json({});
  });
}

async function logo(row, brand) {
  await row.locator(`[data-brand="${brand}"]`).first().waitFor();
  assert.equal(await row.locator('[data-brand] svg').count(), 1, `${await row.innerText()} shows one logo`);
  assert.equal(
    await row.locator(`[data-brand="${brand}"] svg`).evaluate(glyph => glyph.getBoundingClientRect().width > 0),
    true,
  );
}

async function screenshot(page, name, theme, focus) {
  if (!shots) return;
  await focus?.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, `${name}-${theme}.png`) });
}

let browser;
let activePage;
try {
  browser = await chromium.launch(builderBrowserOptions());
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      colorScheme: theme,
      reducedMotion: 'reduce',
    });
    activePage = page;
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    let items = catalog;
    await routeApi(page, () => items);

    await page.goto(`${origin}/acme`);
    await page.getByRole('combobox', { name: 'Model: Acme Chat', exact: true }).click();
    await page.getByRole('option').first().waitFor();
    assert.equal(await page.getByRole('option').count(), expected.length);
    for (const [name, brand] of expected)
      await logo(page.getByRole('option', { name: new RegExp(`^${name}\\b`) }), brand);
    await screenshot(page, 'composer-picker', theme);
    await page.keyboard.press('Escape');
    await logo(page.getByRole('combobox', { name: 'Model: Acme Chat', exact: true }), 'neutral');

    await page.goto(`${origin}/acme/agents/${agentId}`);
    await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
    const preference = page.getByRole('combobox', { name: 'Preferred model family', exact: true });
    await logo(preference, 'neutral');
    assert.match(await preference.innerText(), /Acme Chat/);
    await preference.evaluate(trigger => trigger.scrollIntoView({ block: 'start' }));
    await preference.click();
    for (const [name, brand] of expected)
      await logo(page.getByRole('option', { name: new RegExp(`^${name} `) }), brand);
    await screenshot(page, 'agent-picker', theme);
    await page.keyboard.press('Escape');

    await page.goto(`${origin}/acme/settings/models`);
    for (const [name, brand] of expected) {
      await page.getByRole('switch', { name: `Allow ${name}`, exact: true }).waitFor();
      await logo(page.getByRole('row', { name, exact: true }), brand);
    }
    await screenshot(page, 'availability', theme);

    items = catalogFixture([]);
    const setupGuide = 'https://docs.tulipfarm.ai/self-hosting/models/';
    await page.goto(`${origin}/acme`);
    await page.getByRole('combobox', { name: 'Model: Acme Chat', exact: true }).waitFor();
    await notifyChange(page, workspace.id, 'ada', 'catalog');
    await page
      .getByText('No models configured. An operator needs to set up a model provider.', { exact: true })
      .waitFor();
    assert.equal(await page.getByRole('link', { name: 'Model setup guide' }).getAttribute('href'), setupGuide);
    // The model status sits below the starting tasks and meetings in the chat footer.
    await page.setViewportSize({ width: 1280, height: 1300 });
    await screenshot(page, 'composer-empty', theme);
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.goto(`${origin}/acme/agents/${agentId}`);
    await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
    await page.getByText('No models configured', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Model setup guide' }).getAttribute('href'), setupGuide);
    await screenshot(page, 'agent-empty', theme, page.getByRole('link', { name: 'Model setup guide' }));

    await page.goto(`${origin}/acme/settings/models`);
    await page.getByText('No models configured yet', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Model setup guide' }).getAttribute('href'), setupGuide);
    await screenshot(page, 'models-empty', theme);

    assert.deepEqual(errors, [], 'No browser runtime errors');
    await page.close();
    console.log(
      `${theme}: operator catalog names and logos in the composer, agent and availability pickers; empty catalog.`,
    );
  }
} catch (error) {
  await captureBrowserFailure(activePage, 'model-branding');
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
