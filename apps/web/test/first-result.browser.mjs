import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { notifyChange } from './chat-query.fixture.mjs';
import { governanceSnapshot } from './governance-snapshot.mjs';
import { catalogFamily } from '../src/features/models/catalog-fixture.ts';

const port = Number(process.env.FIRST_RESULT_PORT ?? 5317);
const cdpPort = port + 4000;
const origin = `http://127.0.0.1:${port}`;
const before = process.env.FIRST_RESULT_BEFORE === '1';
const capture = process.env.FIRST_RESULT_SCREENSHOTS;
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  name: 'Acme',
  status: 'ready',
  createdAt: '2026-09-30T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
const memberId = '22222222-2222-4222-8222-222222222222';
const teamId = '33333333-3333-4333-8333-333333333333';
const agentId = '44444444-4444-4444-8444-444444444444';
const teams = [{ id: teamId, name: 'Operations' }];
const family = (id, displayName, provider) =>
  catalogFamily(id, {
    displayName,
    provider,
    currentVersion: `${id}-v1`,
    inputCreditsPerMillionTokens: 300,
    outputCreditsPerMillionTokens: 1500,
    mappingRevision: 'mapping-1',
    pricingRevision: 'pricing-1',
  });
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    if (
      await fetch(origin).then(
        response => response.ok,
        () => false,
      )
    )
      break;
    assert.ok(attempt < 100, 'Vite starts');
    await delay(100);
  }
  browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${cdpPort}`] });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: 'reduce',
      colorScheme: mobile ? 'dark' : 'light',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    let signedIn = false;
    let catalog = [
      family('claude-sonnet', 'Claude Sonnet', 'anthropic'),
      family('gemini-flash', 'Gemini Flash', 'google'),
    ];
    let catalogStatus = 200;
    let catalogDelay = 0;
    let role = 'admin';
    const chats = new Map();
    const messages = new Map();
    const sends = [];
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      let json;
      if (path === '/v1/auth/get-session')
        json = signedIn
          ? {
              session: { id: 'session-ada', userId: 'ada' },
              user: { id: 'ada', name: 'Ada', email: 'ada@example.com' },
            }
          : null;
      else if (path === '/v1/workspaces') json = [workspace];
      else if (path === '/v1/workspaces/acme') json = workspace;
      else if (path.endsWith('/credits'))
        json = { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] };
      else if (path.endsWith('/model-catalog')) {
        await delay(catalogDelay);
        return route.fulfill({
          status: catalogStatus,
          json: catalogStatus === 200 ? { families: catalog } : { error: 'unavailable' },
        });
      } else if (path.endsWith('/governance/me'))
        json = {
          membershipId: memberId,
          role,
          teams,
          capabilities: { manageGovernance: role === 'admin', canLeave: true },
        };
      else if (path.endsWith('/governance'))
        json = governanceSnapshot({
          actorMembershipId: memberId,
          members: [{ id: memberId, userId: 'ada', name: 'Ada', email: 'ada@example.com', role }],
          teams: teams.map(team => ({ ...team, description: '', membershipIds: [] })),
          resources: [],
          grants: [],
        });
      else if (path.endsWith('/integrations/creation-context')) json = { teams: role === 'admin' ? teams : [] };
      else if (path.endsWith('/atlassian/accounts'))
        json = {
          accounts: [],
          providers: [
            { protocol: 'atlassian-mcp', configured: false },
            { protocol: 'atlassian-rest', configured: false },
            { protocol: 'trello', configured: false },
          ],
        };
      else if (path.endsWith('/atlassian/sources'))
        json = {
          sources: [],
          mcp: { enabled: false, explanation: 'Provider operations are not configured in this fixture.' },
        };
      else if (path.endsWith('/integrations')) json = { integrations: [] };
      else if (path.endsWith('/provider-integrations') || path.endsWith('/workflows')) json = [];
      else if (path.endsWith('/agents/authoring-context'))
        json = { currentSoulRevision: 'a'.repeat(40), teams, admin: role === 'admin' };
      else if (path.endsWith(`/agents/${agentId}`))
        json = {
          id: agentId,
          name: 'Customer reviewer',
          owningTeamId: teamId,
          savedRevision: 'a'.repeat(40),
          definitionRevision: 'b'.repeat(64),
          definition: {
            name: 'Customer reviewer',
            instructions: 'Review customer requests.',
            tools: ['schema.inspect'],
            modelFamilyId: 'claude-sonnet',
          },
          capabilities: ['read', 'edit'],
          admin: false,
          activations: [],
        };
      else if (path.endsWith('/skills')) json = { workspace: [], nextCursor: null };
      else if (path.includes('/model-policy/rules/'))
        json = {
          sourceFamilyId: path.split('/').at(-1),
          targetFamilyId: null,
          revision: 0,
          editorMembershipId: null,
          updatedAt: null,
        };
      else if (/\/conversations\/[\w-]+$/.test(path)) {
        const id = path.split('/').at(-1);
        if (method === 'PUT') {
          chats.set(id, {
            id,
            title: 'Customer follow-up plan',
            titleRevision: 0,
            archived: false,
            activityAt: workspace.createdAt,
            createdAt: workspace.createdAt,
          });
          json = { id };
        } else json = chats.get(id);
      } else if (/\/conversations\/[\w-]+\/messages\/[\w-]+$/.test(path)) {
        const body = route.request().postDataJSON();
        const chatId = path.split('/').at(-3);
        const id = path.split('/').at(-1);
        sends.push(body);
        messages.set(chatId, [
          { id, sequence: 1, author: 'human', createdAt: workspace.createdAt, parts: body.parts, turn: null },
          {
            id: agentId,
            sequence: 2,
            author: 'assistant',
            createdAt: workspace.createdAt,
            parts: [
              {
                kind: 'text',
                text: 'Start by listing each customer, their last contact date, and the next action. Review the list before sending any follow-ups.',
              },
            ],
            turn: null,
          },
        ]);
        json = { messageId: id, turnId: agentId, sequence: 1 };
      } else if (path.endsWith('/messages'))
        json = { messages: messages.get(path.split('/').at(-2)) ?? [], nextBefore: null };
      else return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      await route.fulfill({ json });
    });
    async function screenshot(name) {
      if (!capture) return;
      await page.evaluate(() => document.fonts.ready);
      execFileSync(
        'agent-browser',
        [
          '--cdp',
          String(cdpPort),
          'screenshot',
          `${capture}/${before ? 'before' : 'after'}-${mobile ? 'mobile' : 'desktop'}-${name}.png`,
        ],
        { stdio: 'inherit' },
      );
    }
    await page.goto(`${origin}/login`);
    await page.getByRole('heading', { name: 'Log in to TulipFarm' }).waitFor();
    if (!before && !mobile) {
      // Cloud 41fccc94 (#747) restored the animated agent showcase that #204 had made static; it stays decorative and hidden from assistive tech.
      await page.getByText('How agents work in TulipFarm', { exact: true }).waitFor();
      assert.equal(await page.getByText('Live', { exact: true }).count(), 0);
      assert.equal(await page.locator('aside:not([aria-hidden="true"]) [role="progressbar"]').count(), 0);
      assert.equal(await page.getByRole('progressbar').count(), 0);
    }
    await screenshot('login');
    signedIn = true;
    await page.goto(`${origin}/acme`);
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    if (!before) {
      await page.getByRole('button', { name: 'Model: Claude Sonnet', exact: true }).waitFor();
      assert.equal(await page.getByRole('navigation', { name: 'Business setup' }).count(), 0);
      assert.equal(await page.getByText(/Plan work, draft text|Plans and drafts need only/).count(), 0);
      assert.equal(await page.getByRole('button', { name: /Refresh model availability|Retry models/ }).count(), 0);
    }
    await screenshot('home');
    await page.getByRole('button', { name: /^Model:/ }).click();
    await page.getByRole('combobox', { name: 'Search models' }).waitFor();
    if (!before) {
      await page.getByRole('option', { name: 'Gemini Flash', exact: true }).waitFor();
      assert.equal(await page.getByRole('option').count(), 2);
    }
    await screenshot('models');
    await page.keyboard.press('Escape');
    await page.goto(`${origin}/acme/integrations`);
    await page.getByRole('heading', { name: 'Integrations', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Gmail', exact: true }).waitFor();
    await screenshot('integrations');
    if (before) {
      await context.close();
      continue;
    }

    for (const [name, id, field] of [
      ['Google Sheets', 'google-sheets', 'Spreadsheet ID'],
      ['Slack', 'slack', 'Slack workspace ID'],
      ['Notion', 'notion', 'Data source ID'],
      ['Gmail', 'gmail', 'Gmail account email'],
      ['Google Forms', 'google-forms', 'Google Form ID'],
      ['Jira', 'jira', 'Jira cloud ID'],
      ['HubSpot', 'hubspot', 'HubSpot portal ID'],
    ]) {
      await page.goto(`${origin}/acme/integrations#${id}`);
      const sheet = page.getByRole('dialog', { name });
      if (['notion', 'google-forms', 'hubspot'].includes(id))
        await sheet.getByRole('link', { name: 'Set up', exact: true }).click();
      else {
        await sheet.getByRole('button', { name: 'Settings', exact: true }).click();
        await sheet.getByRole('link', { name: `Start workflows from ${name}`, exact: true }).click();
      }
      await page.getByLabel(field, { exact: true }).waitFor();
      assert.equal(await page.getByRole('checkbox').isChecked(), false, 'Discovery never grants consent');
      assert.equal(
        await page.getByRole('button', { name: 'Connect provider source', exact: true }).isDisabled(),
        true,
        'Connecting waits for a test and consent',
      );
      await page.getByRole('button', { name: 'Test integration', exact: true }).click();
      await page.getByText('Confirm that you authorize access to this source.', { exact: true }).waitFor();
      if (name === 'Gmail') await screenshot('gmail-setup');
    }
    for (const [hash, name, panel] of [
      ['github-integrations', 'GitHub', 'Settings'],
      ['atlassian-heading', 'Jira', 'Your account'],
    ]) {
      await page.goto(`${origin}/acme/integrations#${hash}`);
      assert.equal(
        await page
          .getByRole('dialog', { name })
          .getByRole('button', { name: panel, exact: true })
          .getAttribute('aria-expanded'),
        'true',
      );
    }
    role = 'member';
    await page.goto(`${origin}/acme/integrations#gmail`);
    await page.reload();
    await page.getByRole('dialog').getByRole('button', { name: 'Your account', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('dialog').getByRole('region', { name: 'Settings', exact: true }).count(),
      0,
      'Workspace settings are admin-only',
    );
    await page.goto(`${origin}/acme/workflows?provider=gmail#provider-setup`);
    await page.getByLabel('Bearer token for new source or rotation').waitFor();
    assert.equal(
      await page.getByRole('heading', { name: 'Provider access unavailable', exact: true }).count(),
      0,
      'ordinary members may connect their own private sources',
    );
    role = 'admin';

    await page.goto(`${origin}/acme`);
    const message = page.getByRole('textbox', { name: 'Message', exact: true });
    const send = page.getByRole('button', { name: 'Send message', exact: true });
    await page.getByRole('button', { name: 'Model: Claude Sonnet', exact: true }).click();
    await page.getByRole('option', { name: 'Gemini Flash', exact: true }).click();
    // Cloud 8f05815c (#856) sends a starter on click from a new chat (private-conversations.tsx:454); a draft still disables starters.
    await message.fill('My own draft');
    assert.equal(
      await page.getByRole('button', { name: 'Draft a support reply', exact: true }).isEnabled(),
      false,
      'A starter cannot overwrite a draft',
    );
    await message.fill('');
    assert.equal(sends.length, 0, 'Typing a draft does not submit');
    await page.getByRole('button', { name: 'Plan customer follow-ups', exact: true }).click();
    await page.getByText(/^Help me plan customer follow-ups\./).waitFor();
    await page
      .getByText(
        'Start by listing each customer, their last contact date, and the next action. Review the list before sending any follow-ups.',
        { exact: true },
      )
      .waitFor();
    assert.equal(sends.length, 1);
    assert.equal(sends[0].model, 'gemini-flash');
    await page.getByRole('button', { name: 'Model: Gemini Flash', exact: true }).click();
    await page.getByRole('option', { name: 'Claude Sonnet', exact: true }).click();
    assert.equal(await page.getByRole('region', { name: 'Recommended for you' }).count(), 0);
    await message.fill('Keep this draft while checking models.');
    catalog = catalog.map(item =>
      item.id === 'claude-sonnet'
        ? { ...item, available: false, unavailableReason: 'workspace-disabled', fallbackFor: [] }
        : item,
    );
    await notifyChange(page, workspace.id, 'ada', 'catalog');
    await page.getByText(/Claude Sonnet is disabled in this workspace/).waitFor();
    assert.equal(await send.isEnabled(), false);
    assert.equal(await message.textContent(), 'Keep this draft while checking models.');
    await screenshot('model-disabled');
    await page.getByRole('button', { name: 'Model: Claude Sonnet', exact: true }).click();
    assert.equal(
      await page.getByRole('option', { name: /^Claude Sonnet .*disabled in workspace/ }).getAttribute('aria-disabled'),
      'true',
    );
    await page.getByRole('option', { name: 'Gemini Flash', exact: true }).click();
    assert.equal(await send.isEnabled(), true);
    await send.click();
    await page.getByRole('button', { name: 'Model: Gemini Flash', exact: true }).waitFor();
    assert.equal(sends.at(-1).model, 'gemini-flash');
    await message.fill('Keep this draft while checking models.');
    catalogStatus = 503;
    await notifyChange(page, workspace.id, 'ada', 'catalog');
    await page.getByText(/Could not check model availability/).waitFor();
    assert.equal(await send.isEnabled(), true);
    await page.getByRole('button', { name: 'Retry models', exact: true }).click();
    await page.getByText('Checking available models…', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Retry models', exact: true }).waitFor();
    catalogStatus = 200;
    catalogDelay = 600;
    await page.getByRole('button', { name: 'Retry models', exact: true }).click();
    await page.getByText('Checking available models…', { exact: true }).waitFor();
    assert.equal(await send.isEnabled(), true);
    await page.getByText('Checking available models…', { exact: true }).waitFor({ state: 'hidden' });
    catalogDelay = 0;
    catalog = catalog.map(item =>
      item.id === 'gemini-flash'
        ? { ...item, available: false, unavailableReason: 'model-family-unavailable', fallbackFor: [] }
        : item,
    );
    await notifyChange(page, workspace.id, 'ada', 'catalog');
    await page.getByRole('button', { name: 'Model: Gemini Flash', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByText(/Gemini Flash/).count(), 0);
    assert.equal(await send.isEnabled(), false);
    catalog = [];
    await page.getByRole('button', { name: 'Retry models', exact: true }).click();
    await page.getByText(/No models configured/).waitFor();
    assert.equal(await message.textContent(), 'Keep this draft while checking models.');
    await message.fill('');
    await page.goto(`${origin}/acme`);
    await page.getByText(/No models configured/).waitFor();
    assert.equal(await send.isEnabled(), false);
    catalogStatus = 503;
    await page.reload();
    await page.getByText(/No models configured/).waitFor();
    await notifyChange(page, workspace.id, 'ada', 'catalog');
    await page.getByText(/Could not check model availability/).waitFor();
    catalogStatus = 200;
    catalog = [family('claude-sonnet', 'Claude Sonnet', 'anthropic'), family('gemini-flash', 'Gemini Flash', 'google')];
    await page.getByRole('button', { name: 'Retry models', exact: true }).click();
    await page.getByRole('button', { name: 'Model: Claude Sonnet', exact: true }).waitFor();
    catalog = catalog.map(item => ({
      ...item,
      available: false,
      unavailableReason: item.id === 'claude-sonnet' ? 'workspace-disabled' : 'model-family-unavailable',
      fallbackFor: [],
    }));
    await page.goto(`${origin}/acme/agents/${agentId}`);
    await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
    await page.getByLabel('Preferred model family', { exact: true }).waitFor();
    await notifyChange(page, workspace.id, 'ada', 'catalog');
    // Cloud 3e124b0f (#1004) made this a Select (agent-model-picker.tsx:21-27) labelling unavailable families "(unavailable)" (model-option.tsx:11).
    const familyPicker = page.getByRole('combobox', { name: 'Preferred model family', exact: true });
    await familyPicker.click();
    assert.equal(
      await page.getByRole('option', { name: /^Claude Sonnet \(unavailable\)/ }).getAttribute('aria-disabled'),
      'true',
    );
    assert.equal(await page.getByRole('option', { name: /Gemini Flash/ }).count(), 0);
    await page.keyboard.press('Escape');
    assert.match(await familyPicker.textContent(), /^Claude Sonnet \(unavailable\)/);
    await page
      .getByText(
        'Your saved preference is unavailable and has not been replaced. Choose an available family or clear it.',
        { exact: true },
      )
      .waitFor();
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    console.log(
      `${mobile ? 'Mobile' : 'Desktop'} passed starter submission, model availability and recovery, seven integration destinations, and member denial.`,
    );
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
