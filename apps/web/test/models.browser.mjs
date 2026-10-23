import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { notifyChange } from './chat-query.fixture.mjs';
import { governanceSnapshot } from './governance-snapshot.mjs';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const membershipId = '22222222-2222-4222-8222-222222222222';
const teamId = '33333333-3333-4333-8333-333333333333';
const agentId = '44444444-4444-4444-8444-444444444444';
const timestamp = '2026-09-28T00:00:00.000Z';
const base = `/v1/workspaces/${workspaceId}`;
const workspace = {
  id: workspaceId,
  name: 'Acme',
  slug: 'acme',
  createdAt: timestamp,
  status: 'ready',
  soulCommit: 'a'.repeat(40),
};
const teams = [{ id: teamId, name: 'Engineering' }];
const definition = {
  name: 'Research assistant',
  instructions: 'Read the supplied business rows.',
  tools: ['schema.inspect'],
  modelFamilyId: 'retired-family',
};
const catalog = {
  families: [
    {
      id: 'primary',
      displayName: 'Primary family',
      vendor: 'anthropic',
      currentVersion: 'primary-version-1',
      provider: 'anthropic',
      inputCreditsPerMillionTokens: 300,
      outputCreditsPerMillionTokens: 1500,
      available: true,
      unavailableReason: null,
      mappingRevision: 'fixture-mapping-1',
      pricingRevision: 'fixture-pricing-1',
      fallbackFor: ['secondary'],
    },
    {
      id: 'secondary',
      displayName: 'Secondary family',
      vendor: 'google',
      currentVersion: 'secondary-version-1',
      provider: 'google',
      inputCreditsPerMillionTokens: 50,
      outputCreditsPerMillionTokens: 250,
      available: true,
      unavailableReason: null,
      mappingRevision: 'fixture-mapping-1',
      pricingRevision: 'fixture-pricing-1',
      fallbackFor: ['primary'],
    },
    {
      id: 'unavailable',
      displayName: 'Unavailable family',
      vendor: 'openai',
      currentVersion: 'unavailable-version-1',
      provider: 'azure',
      inputCreditsPerMillionTokens: 100,
      outputCreditsPerMillionTokens: 500,
      available: false,
      unavailableReason: 'model-family-unavailable',
      mappingRevision: null,
      pricingRevision: null,
      fallbackFor: [],
    },
  ],
};

function initialRule(sourceFamilyId) {
  return { sourceFamilyId, targetFamilyId: null, revision: 0, editorMembershipId: null, updatedAt: null };
}

function fixtureState() {
  return {
    role: 'admin',
    catalog: structuredClone(catalog),
    catalogStatus: 200,
    catalogGate: null,
    saveGate: null,
    receiptGate: null,
    nextSave: 'commit',
    ruleStatus: new Map(),
    ruleResponses: new Map(),
    ruleGates: new Map(),
    rules: new Map(catalog.families.map(family => [family.id, initialRule(family.id)])),
    compaction: {
      automatic: true,
      triggerPercent: 70,
      targetPercent: 30,
      modelFamilyId: 'claude-haiku',
      fallbackFamilyId: null,
      outputPrompt: null,
      revision: 0,
      editorMembershipId: null,
      updatedAt: null,
      budgetFamilies: [
        { id: 'claude-haiku', name: 'Claude Haiku', enabled: true },
        { id: 'deepseek-flash', name: 'DeepSeek Flash', enabled: true },
      ],
    },
    images: {
      recognitionFamilyId: null,
      defaultImageModelId: null,
      generationEnabled: true,
      revision: 0,
      editorMembershipId: null,
      updatedAt: null,
      effective: { recognitionFamilyId: 'claude-haiku', defaultImageModelId: null },
      recognitionFamilies: [{ id: 'claude-haiku', name: 'Claude Haiku', enabled: true }],
      imageModels: [],
    },
    imageReceipts: new Map(),
    compactionStatus: 200,
    compactionGate: null,
    nextCompactionSave: 'commit',
    compactionReceipts: new Map(),
    receipts: new Map(),
    agentCommands: new Map(),
    requests: [],
    errors: [],
    agent: {
      id: agentId,
      name: definition.name,
      owningTeamId: teamId,
      savedRevision: 'a'.repeat(40),
      definitionRevision: 'b'.repeat(64),
      definition: structuredClone(definition),
      capabilities: ['read', 'edit'],
      admin: false,
      activations: [],
    },
  };
}

function gate() {
  const { promise, resolve } = Promise.withResolvers();
  return { promise, release: resolve };
}

function writes(state) {
  return state.requests.filter(request => !['GET', 'OPTIONS'].includes(request.method));
}

async function eventually(read, expected, message = 'Observed value must reach the expected value') {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (value === expected) return;
    await delay(50);
  }
  assert.equal(await read(), expected, message);
}

test('models in the actual Vite app through a local HTTP API fixture', { timeout: 240_000 }, async t => {
  let contracts;
  try {
    contracts = await import('@tulipfarm/agents/model-policy-contracts');
  } catch (cause) {
    throw new Error(
      'Model policy contracts are not built/exported. Integrate PR 70 and build workspace packages before running test:models.',
      { cause },
    );
  }
  const { modelCatalogSchema } = await import('@tulipfarm/config/model-catalog');
  const { compactionPolicySchema, compactionPolicyCommandSchema, compactionPolicyReceiptSchema } =
    await import('@tulipfarm/agents/compaction-policy-contracts');
  const { imageSettingsSchema, imageSettingsCommandSchema, imageSettingsReceiptSchema } =
    await import('@tulipfarm/agents/image-settings-contracts');
  const { saveAgentSchema, agentCommandStatusSchema } = await import('@tulipfarm/agents/saved-contracts');
  const { chromium } = await import(
    process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
  );
  const { modelPolicyCommandSchema, modelPolicyRuleSchema, modelPolicyReceiptSchema } = contracts;
  modelCatalogSchema.parse(catalog);
  const webPort = Number(process.env.MODELS_BROWSER_PORT ?? 5199);
  const origin = `http://127.0.0.1:${webPort}`;
  let state = fixtureState();
  let browser;
  let vite;
  let output = '';
  const selectedScenario = process.env.MODELS_BROWSER_SCENARIO;
  let matchedScenario = false;
  const server = createServer(async (request, response) => {
    const current = state;
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Cache-Control', 'no-store');
    const send = (value, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }
      const path = new URL(request.url, origin).pathname;
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      if (request.method === 'POST' && path === '/v1/user/visit') return send({ firstSession: false });
      if (request.method === 'GET' && path === '/v1/feature-flags') return send({});
      if (request.method === 'PUT' && path === '/v1/workspaces/acme/last-used') {
        response.writeHead(204);
        response.end();
        return;
      }
      current.requests.push({ method: request.method, path, body });
      if (request.method === 'GET') {
        if (path === '/v1/auth/get-session')
          return send({
            session: { id: 'fixture-session', userId: 'ada', expiresAt: '2099-01-01T00:00:00.000Z' },
            user: {
              id: 'ada',
              name: 'Ada',
              email: 'ada@example.com',
              emailVerified: true,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          });
        if (path === '/v1/workspaces') return send([workspace]);
        if (path === '/v1/workspaces/acme') return send(workspace);
        if (path === '/v1/google-workspace/availability') return send({ configured: false });
        if (path === `${base}/google-workspace`) return send({ status: 'disconnected' });
        if (path === `${base}/github/accounts`) return send({ configured: false, accounts: [] });
        if (path === `${base}/atlassian/accounts`) return send({ accounts: [], providers: [] });
        if (path === `${base}/slack/status`)
          return send({ state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] });
        if (path === `${base}/bud`)
          return send({
            conversationId: null,
            onboarding: 'skipped',
            bubblesEnabled: false,
            snoozedUntil: null,
            nudge: null,
            preferences: [],
          });
        if (path === `${base}/recommendations/events`) return send({ error: 'recommendations-unavailable' }, 503);
        if (path === `${base}/settings`) return send({ error: 'forbidden' }, 403);
        if (path === `${base}/credits`)
          return send({ available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] });
        if (path === `${base}/skills`) return send({ workspace: [], nextCursor: null });
        if (path === `${base}/governance/me`)
          return send({
            membershipId,
            role: current.role,
            teams,
            capabilities: { manageGovernance: current.role === 'admin', canLeave: true },
          });
        if (path === `${base}/governance`)
          return send(
            governanceSnapshot({
              actorMembershipId: membershipId,
              members: [{ id: membershipId, userId: 'ada', name: 'Ada', email: 'ada@example.com', role: current.role }],
              teams: [{ ...teams[0], membershipIds: [membershipId] }],
              resources: [],
              grants: [],
            }),
          );
        if (path === `${base}/compaction-policy`) {
          const policy = compactionPolicySchema.parse(current.compaction);
          await current.compactionGate?.promise;
          return current.compactionStatus === 200
            ? send(policy)
            : send({ error: 'compaction-unavailable' }, current.compactionStatus);
        }
        if (path === `${base}/model-policy/images`) {
          if (current.role !== 'admin') return send({ error: 'agent-not-found' }, 404);
          return send(imageSettingsSchema.parse(current.images));
        }
        if (path.startsWith(`${base}/model-policy/images/commands/`)) {
          const receipt = current.imageReceipts.get(path.split('/').at(-1));
          return receipt
            ? send(imageSettingsReceiptSchema.parse(receipt))
            : send({ error: 'image-settings-command-not-found' }, 404);
        }
        if (path === `${base}/model-policy/availability`)
          return send({
            items: current.catalog.families.map(family => ({ familyId: family.id, enabled: true, revision: 0 })),
          });
        if (path === `${base}/model-catalog`) {
          await current.catalogGate?.promise;
          return current.catalogStatus === 200
            ? send(modelCatalogSchema.parse(current.catalog))
            : send({ error: 'catalog-unavailable' }, current.catalogStatus);
        }
        if (path.startsWith(`${base}/model-policy/rules/`)) {
          const source = decodeURIComponent(path.split('/').at(-1));
          const status = current.ruleStatus.get(source) ?? 200;
          const rule = current.ruleResponses.get(source) ?? current.rules.get(source) ?? initialRule(source);
          await current.ruleGates.get(source)?.promise;
          if (status !== 200) return send({ error: 'agent-not-found' }, status);
          return send(modelPolicyRuleSchema.parse(rule));
        }
        if (path.startsWith(`${base}/model-policy/commands/`)) {
          await current.receiptGate?.promise;
          if (current.role !== 'admin') return send({ error: 'agent-not-found' }, 404);
          const receipt = current.receipts.get(path.split('/').at(-1));
          return receipt
            ? send(modelPolicyReceiptSchema.parse(receipt))
            : send({ error: 'model-policy-command-not-found' }, 404);
        }
        if (path === `${base}/agents/authoring-context`)
          return send({ currentSoulRevision: current.agent.savedRevision, teams, admin: false });
        if (path === `${base}/workspace-mcp/capabilities`) return send({ enabled: false });
        if (path === `${base}/agents/${agentId}`) return send(current.agent);
        if (path.startsWith(`${base}/agents/commands/`)) {
          const command = current.agentCommands.get(path.split('/').at(-1));
          if (command) return send(agentCommandStatusSchema.parse(command));
        }
      }
      if (request.method === 'PUT' && path === `${base}/model-policy/images`) {
        if (current.role !== 'admin') return send({ error: 'agent-not-found' }, 404);
        const input = imageSettingsCommandSchema.parse(body);
        const previous = current.imageReceipts.get(input.requestId);
        if (previous) return send(previous);
        if (input.expectedRevision !== current.images.revision)
          return send({ error: 'image-settings-revision-conflict' }, 409);
        const { requestId, expectedRevision, ...settings } = input;
        current.images = imageSettingsSchema.parse({
          ...current.images,
          ...settings,
          revision: expectedRevision + 1,
          editorMembershipId: membershipId,
          updatedAt: timestamp,
        });
        const receipt = imageSettingsReceiptSchema.parse({ ...current.images, requestId });
        current.imageReceipts.set(requestId, receipt);
        return send(receipt);
      }
      if (request.method === 'PUT' && path === `${base}/compaction-policy`) {
        const input = compactionPolicyCommandSchema.parse(body);
        await current.saveGate?.promise;
        if (current.role !== 'admin') return send({ error: 'agent-not-found' }, 404);
        const mode = current.nextCompactionSave;
        current.nextCompactionSave = 'commit';
        if (mode === 'reject') return send({ error: 'model-family-unavailable' }, 400);
        const previous = current.compactionReceipts.get(input.requestId);
        if (previous) return send(previous);
        if (input.expectedRevision !== current.compaction.revision)
          return send({ error: 'compaction-policy-revision-conflict' }, 409);
        const receipt = compactionPolicyReceiptSchema.parse({
          ...current.compaction,
          ...input,
          revision: input.expectedRevision + 1,
          editorMembershipId: membershipId,
          updatedAt: timestamp,
        });
        if (mode !== 'lose-uncommitted') {
          current.compaction = compactionPolicySchema.parse(receipt);
          current.compactionReceipts.set(input.requestId, receipt);
        }
        if (mode.startsWith('lose-')) {
          response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '10000' });
          response.write('{');
          await delay(20);
          response.destroy();
          return;
        }
        return send(receipt);
      }
      if (request.method === 'PUT' && path === `${base}/model-policy`) {
        if (current.role !== 'admin') return send({ error: 'agent-not-found' }, 404);
        const input = modelPolicyCommandSchema.parse(body);
        await current.saveGate?.promise;
        const mode = current.nextSave;
        current.nextSave = 'commit';
        if (typeof mode === 'number') return send({ error: 'agent-not-found' }, mode);
        if (mode === 'family-unavailable') return send({ error: 'model-family-unavailable' }, 400);
        const previous = current.receipts.get(input.requestId);
        if (previous) return send(previous);
        const rule = current.rules.get(input.sourceFamilyId) ?? initialRule(input.sourceFamilyId);
        if (input.expectedRevision !== rule.revision) return send({ error: 'model-policy-revision-conflict' }, 409);
        const receipt = modelPolicyReceiptSchema.parse({
          ...input,
          revision: rule.revision + 1,
          editorMembershipId: membershipId,
          updatedAt: timestamp,
        });
        if (mode !== 'lose-uncommitted') {
          current.rules.set(input.sourceFamilyId, modelPolicyRuleSchema.parse(receipt));
          current.receipts.set(input.requestId, receipt);
        }
        if (mode.startsWith('lose-')) {
          // Truncate a started HTTP response so Chromium cannot transparently retry a closed idle socket.
          response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '10000' });
          response.write('{');
          await delay(20);
          response.destroy();
          return;
        }
        return send(receipt);
      }
      if (request.method === 'PUT' && path === `${base}/agents/${agentId}`) {
        const input = saveAgentSchema.parse(body);
        if (input.expectedSavedRevision !== current.agent.savedRevision)
          return send({ error: 'agent-revision-conflict' }, 409);
        current.agent = {
          ...current.agent,
          name: input.definition.name,
          definition: input.definition,
          savedRevision: 'c'.repeat(40),
          definitionRevision: 'd'.repeat(64),
        };
        const command = agentCommandStatusSchema.parse({
          commandId: input.requestId,
          agentId,
          status: 'accepted',
          savedRevision: current.agent.savedRevision,
        });
        current.agentCommands.set(command.commandId, command);
        return send(command);
      }
      // The agent page reads a pending setup draft; none exists here (cloud 3e124b0f #1004, pages/agents.tsx:190).
      if (request.method === 'GET' && path === `${base}/agents/${agentId}/setup-draft`)
        return send({ error: 'setup-draft-not-found' }, 404);
      throw new Error(`Unexpected fixture request ${request.method} ${path}`);
    } catch (error) {
      current.errors.push(String(error));
      if (!response.headersSent) send({ error: 'fixture-contract-error' }, 500);
      else response.destroy();
    }
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const apiOrigin = `http://127.0.0.1:${server.address().port}`;
    vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, VITE_API_URL: apiOrigin },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    vite.stdout.on('data', data => {
      output = (output + data).slice(-16000);
    });
    vite.stderr.on('data', data => {
      output = (output + data).slice(-16000);
    });
    vite.on('error', error => {
      output += String(error);
    });
    for (let attempt = 0; ; attempt++) {
      assert.equal(vite.exitCode, null, `Vite exited. ${output}`);
      const ready =
        output.includes(`http://127.0.0.1:${webPort}`) &&
        (await fetch(origin, { signal: AbortSignal.timeout(1000) }).then(
          response => response.ok,
          () => false,
        ));
      if (ready) break;
      assert.ok(attempt < 150, `Vite did not start. ${output}`);
      await delay(100);
    }
    browser = await chromium.launch({ headless: true });

    async function scenario(name, run, options = {}) {
      if (selectedScenario && name !== selectedScenario) return;
      matchedScenario = true;
      await t.test(name, { timeout: 30_000 }, async () => {
        state = fixtureState();
        const context = await browser.newContext({
          viewport: { width: 1280, height: 900 },
          locale: 'en-US',
          ...options,
        });
        const page = await context.newPage();
        // Bud's labelled launcher sits bottom-right over the agent form footer; move it as a user would by dragging (cloud features/chat/bud-position.ts:3).
        await page.addInitScript(() => localStorage.setItem('tulipfarm:bud-corner', 'bottom-left'));
        page.setDefaultTimeout(8000);
        page.setDefaultNavigationTimeout(30000);
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        try {
          await run(page, state);
          assert.deepEqual(state.errors, [], 'All HTTP fixture requests match the contracts');
          assert.deepEqual(errors, [], 'No browser runtime errors');
        } catch (error) {
          t.diagnostic(
            `${name}\n${error}\nFixture errors: ${state.errors.join('\n')}\nBrowser errors: ${errors.join('\n')}\nVite: ${output}`,
          );
          throw error;
        } finally {
          state.catalogGate?.release();
          state.saveGate?.release();
          state.receiptGate?.release();
          state.compactionGate?.release();
          for (const pending of state.ruleGates.values()) pending.release();
          await context.close();
        }
      });
    }

    const modelPreference = page => page.getByRole('combobox', { name: 'Preferred model family', exact: true });
    async function modelPreferenceValue(page) {
      return (await modelPreference(page).innerText()).trim();
    }
    async function pickModel(page, label) {
      await modelPreference(page).click();
      // Agent family options carry their credit rates (cloud 3e124b0f #1004, features/models/model-option.tsx:11-13).
      await page.getByRole('option', { name: new RegExp(`^${label} `) }).click();
    }
    const models = (page, tab) => page.goto(`${origin}/acme/settings/models${tab ? `?tab=${tab}` : ''}`);
    const primary = page => page.getByRole('row', { name: 'Primary family', exact: true });
    const fallback = page => primary(page).getByLabel('Fallback for Primary family', { exact: true });
    const saveButton = page => primary(page).getByRole('button', { name: 'Save', exact: true });
    async function ready(page, admin = true) {
      await models(page);
      if (admin) await fallback(page).waitFor();
      else await primary(page).getByText('No fallback', { exact: true }).waitFor();
    }
    async function saved(page, fixture, target, revision) {
      await eventually(() => fixture.rules.get('primary').revision, revision);
      await primary(page).getByText('Saved', { exact: true }).waitFor();
      assert.equal(await fallbackValue(page), target ? familyNames[target] : 'No fallback');
    }
    const familyNames = { secondary: 'Secondary family', unavailable: 'Unavailable family' };
    const fallbackValue = page => fallback(page).locator('[data-slot="select-value"]').textContent();
    async function pickFallback(page, name) {
      await fallback(page).click();
      await page.getByRole('option', { name, exact: true }).click();
    }
    async function optionDisabled(page, trigger, name) {
      await trigger.click();
      const disabled = await page.getByRole('option', { name, exact: true }).isDisabled();
      await page.keyboard.press('Escape');
      return disabled;
    }
    const chooseFallback = page => pickFallback(page, 'Secondary family');
    async function recoveryLink(page, region, status) {
      const link = region.locator('a').filter({ hasText: status === 401 ? /^Sign in$/ : /^Back to workspaces$/ });
      await link.waitFor();
      const destination = new URL(await link.getAttribute('href'), origin);
      assert.equal(destination.origin, origin);
      assert.equal(destination.pathname, status === 401 ? '/login' : '/');
      if (status === 401) {
        const current = new URL(page.url());
        assert.equal(destination.searchParams.get('redirect'), `${current.pathname}${current.search}${current.hash}`);
      }
      assert.equal(
        await region
          .locator('a')
          .filter({ hasText: status === 401 ? /^Back to workspaces$/ : /^Sign in$/ })
          .count(),
        0,
      );
    }
    async function watchEmpty(page) {
      await page.addInitScript(() => {
        window.modelEmptySeen = false;
        new MutationObserver(records => {
          if (
            records.some(record =>
              [...record.addedNodes, ...(record.type === 'characterData' ? [record.target] : [])].some(node =>
                node.textContent?.includes('No models configured yet'),
              ),
            )
          )
            window.modelEmptySeen = true;
        }).observe(document, { subtree: true, childList: true, characterData: true });
      });
    }

    const trigger = page => page.getByLabel('Trigger', { exact: true });
    const handoff = page => page.getByLabel('Handoff instructions', { exact: true });
    const saveCompaction = page => page.getByRole('button', { name: 'Save compaction settings', exact: true });
    const policyReads = fixture =>
      fixture.requests.filter(request => request.method === 'GET' && request.path === `${base}/compaction-policy`)
        .length;
    const policyWrites = fixture => writes(fixture).filter(request => request.path === `${base}/compaction-policy`);
    async function compaction(page) {
      await models(page, 'compaction');
      await eventually(() => trigger(page).isEnabled(), true);
    }
    async function refreshCompaction(page, fixture) {
      const before = policyReads(fixture);
      await notifyChange(page, workspaceId, 'ada', 'catalog');
      await eventually(() => policyReads(fixture) > before, true, 'Catalog refresh rechecks compaction policy');
      await eventually(() => trigger(page).isEnabled(), true);
    }
    await scenario('an admin turns image creation off and the saved settings stay', async (page, fixture) => {
      await models(page, 'images');
      const create = page.getByRole('checkbox', { name: 'Create images', exact: true });
      await eventually(() => create.isEnabled(), true);
      assert.equal(await create.isChecked(), true);
      await create.uncheck();
      await page.getByRole('button', { name: 'Save image settings', exact: true }).click();
      await eventually(() => fixture.images.revision, 1, 'Image settings save once');
      assert.equal(fixture.images.generationEnabled, false);
      assert.equal(
        writes(fixture).filter(request => request.path === `${base}/model-policy/images`).length,
        1,
        'One image settings write',
      );
      assert.equal(await create.isChecked(), false);
    });
    await scenario('compaction draft and focused input survive an identical catalog refresh', async (page, fixture) => {
      await compaction(page);
      await trigger(page).fill('85');
      await handoff(page).fill('Keep totals in the handoff.');
      const input = await handoff(page).elementHandle();
      await refreshCompaction(page, fixture);
      assert.equal(await trigger(page).inputValue(), '85');
      assert.equal(await handoff(page).inputValue(), 'Keep totals in the handoff.');
      assert.equal(await input.evaluate(node => node.isConnected), true);
      assert.equal(policyWrites(fixture).length, 0);
      await saveCompaction(page).click();
      await page.getByText('Compaction settings saved.', { exact: true }).waitFor();
      assert.equal(policyWrites(fixture)[0].body.expectedRevision, 0);
      assert.equal(fixture.compaction.triggerPercent, 85);
    });
    await scenario(
      'compaction clean forms accept current policy; dirty forms keep their save revision',
      async (page, fixture) => {
        await compaction(page);
        fixture.compaction = { ...fixture.compaction, triggerPercent: 75, revision: 1 };
        await refreshCompaction(page, fixture);
        assert.equal(await trigger(page).inputValue(), '75');
        await trigger(page).fill('85');
        fixture.compaction = { ...fixture.compaction, triggerPercent: 80, revision: 2 };
        await refreshCompaction(page, fixture);
        assert.equal(await trigger(page).inputValue(), '85');
        await saveCompaction(page).click();
        await page.getByRole('button', { name: 'Reload latest settings', exact: true }).waitFor();
        assert.equal(policyWrites(fixture)[0].body.expectedRevision, 1);
        await refreshCompaction(page, fixture);
        assert.equal(await trigger(page).inputValue(), '85');
        await page.getByRole('button', { name: 'Reload latest settings', exact: true }).click();
        await eventually(() => trigger(page).inputValue(), '80');
      },
    );
    await scenario('compaction failed refresh retains edits and retry never writes', async (page, fixture) => {
      await compaction(page);
      await trigger(page).fill('85');
      fixture.compactionStatus = 503;
      await notifyChange(page, workspaceId, 'ada', 'catalog');
      const retry = page.getByRole('button', { name: 'Retry compaction settings', exact: true });
      await retry.waitFor();
      assert.equal(await trigger(page).inputValue(), '85');
      assert.equal(await saveCompaction(page).getAttribute('aria-disabled'), 'true');
      await retry.click();
      await eventually(() => retry.isEnabled(), true);
      assert.equal(await trigger(page).inputValue(), '85');
      fixture.compactionStatus = 200;
      await retry.click();
      await retry.waitFor({ state: 'hidden' });
      assert.equal(await trigger(page).inputValue(), '85');
      assert.equal(policyWrites(fixture).length, 0);
    });
    for (const mode of ['lose-uncommitted', 'lose-committed'])
      await scenario(`compaction ${mode} retry remains exact across catalog refresh`, async (page, fixture) => {
        await compaction(page);
        await trigger(page).fill('85');
        fixture.nextCompactionSave = mode;
        await saveCompaction(page).click();
        await page
          .getByText('We could not confirm this save. Saving again sends the same change once.', { exact: true })
          .waitFor();
        const command = policyWrites(fixture)[0].body;
        await refreshCompaction(page, fixture);
        assert.equal(await trigger(page).inputValue(), '85');
        await saveCompaction(page).click();
        await page.getByText('Compaction settings saved.', { exact: true }).waitFor();
        assert.deepEqual(
          policyWrites(fixture).map(request => request.body),
          [command, command],
        );
      });
    await scenario(
      'compaction role changes discard previous authority drafts rather than revive them',
      async (page, fixture) => {
        await compaction(page);
        await handoff(page).fill('Old admin draft');
        fixture.role = 'member';
        await notifyChange(page, workspaceId, 'ada', 'models');
        await page.getByText('Only workspace admins can change compaction settings.', { exact: true }).waitFor();
        assert.equal(await handoff(page).count(), 0);
        fixture.role = 'admin';
        await notifyChange(page, workspaceId, 'ada', 'models');
        await handoff(page).waitFor();
        assert.equal(await handoff(page).inputValue(), '');
        assert.equal(policyWrites(fixture).length, 0);
      },
    );
    await scenario(
      'compaction save survives catalog refresh without a stale read or repeated write',
      async (page, fixture) => {
        await compaction(page);
        await trigger(page).fill('85');
        fixture.saveGate = gate();
        await saveCompaction(page).click();
        await eventually(() => policyWrites(fixture).length, 1);
        const before = policyReads(fixture);
        await notifyChange(page, workspaceId, 'ada', 'catalog');
        await delay(150);
        fixture.saveGate.release();
        await page.getByText('Compaction settings saved.', { exact: true }).waitFor();
        await eventually(() => policyReads(fixture) > before, true);
        assert.equal(await trigger(page).inputValue(), '85');
        assert.equal(policyWrites(fixture).length, 1);
      },
    );
    await scenario(
      'compaction initial loading and repeated read failure recover without a false empty state',
      async (page, fixture) => {
        fixture.compactionGate = gate();
        await models(page, 'compaction');
        await page.getByText('Loading compaction settings…', { exact: true }).waitFor();
        assert.equal(await trigger(page).count(), 0);
        fixture.compactionStatus = 503;
        fixture.compactionGate.release();
        const retry = page.getByRole('button', { name: 'Retry compaction settings', exact: true });
        await retry.waitFor();
        await retry.click();
        await eventually(() => retry.isEnabled(), true);
        assert.equal(await trigger(page).count(), 0);
        fixture.compactionStatus = 200;
        await retry.click();
        await eventually(() => trigger(page).isEnabled(), true);
        assert.equal(await trigger(page).inputValue(), '70');
        assert.equal(policyWrites(fixture).length, 0);
      },
    );
    await scenario('read-only compaction refresh failures still expose a retry', async (page, fixture) => {
      fixture.role = 'member';
      await models(page, 'compaction');
      await page.getByText('Only workspace admins can change compaction settings.', { exact: true }).waitFor();
      fixture.compactionStatus = 503;
      await notifyChange(page, workspaceId, 'ada', 'catalog');
      const retry = page.getByRole('button', { name: 'Retry compaction settings', exact: true });
      await retry.waitFor();
      assert.equal(await trigger(page).count(), 0);
      fixture.compactionStatus = 200;
      await retry.click();
      await retry.waitFor({ state: 'hidden' });
      assert.equal(policyWrites(fixture).length, 0);
    });
    await scenario(
      'compaction refresh preserves drafts after rejection and updates model eligibility',
      async (page, fixture) => {
        await compaction(page);
        await trigger(page).fill('85');
        fixture.nextCompactionSave = 'reject';
        await saveCompaction(page).click();
        await page
          .getByText('A selected summary model is no longer available. Choose another approved summary model.', {
            exact: true,
          })
          .waitFor();
        await refreshCompaction(page, fixture);
        assert.equal(await trigger(page).inputValue(), '85');
        fixture.compaction.budgetFamilies[0].enabled = false;
        await refreshCompaction(page, fixture);
        await saveCompaction(page).click();
        await page.getByText('Choose an available summary model.', { exact: true }).waitFor();
        assert.equal(policyWrites(fixture).length, 1);
        fixture.compaction.budgetFamilies[0].enabled = true;
        await refreshCompaction(page, fixture);
        await saveCompaction(page).click();
        await page.getByText('Compaction settings saved.', { exact: true }).waitFor();
        assert.notEqual(policyWrites(fixture)[1].body.requestId, policyWrites(fixture)[0].body.requestId);
        assert.equal(fixture.compaction.triggerPercent, 85);
      },
    );
    for (const status of [403, 404])
      await scenario(
        `compaction ${status} read conceals prior input until a successful retry`,
        async (page, fixture) => {
          await compaction(page);
          await handoff(page).fill('Conceal this draft');
          fixture.compactionStatus = status;
          await notifyChange(page, workspaceId, 'ada', 'catalog');
          const retry = page.getByRole('button', { name: 'Retry compaction settings', exact: true });
          await retry.waitFor();
          assert.equal(await handoff(page).count(), 0);
          assert.equal(await saveCompaction(page).count(), 0);
          fixture.compactionStatus = 200;
          await retry.click();
          await handoff(page).waitFor();
          assert.equal(await handoff(page).inputValue(), '');
          assert.equal(policyWrites(fixture).length, 0);
        },
      );
    for (const width of [320, 375, 414, 768, 1440])
      await scenario(`compaction draft recovery fits ${width}px`, async (page, fixture) => {
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ colorScheme: width === 375 ? 'dark' : 'light', reducedMotion: 'reduce' });
        await compaction(page);
        await trigger(page).fill('85');
        await handoff(page).fill('Keep totals.');
        await refreshCompaction(page, fixture);
        assert.equal(await trigger(page).inputValue(), '85');
        assert.equal(await handoff(page).inputValue(), 'Keep totals.');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await trigger(page).focus();
        await page.keyboard.press('Enter');
        await page.getByText('Compaction settings saved.', { exact: true }).waitFor();
        assert.equal(policyWrites(fixture).length, 1);
      });
    await scenario('models denied copy identifies models and recovers without writes', async (page, fixture) => {
      fixture.catalogStatus = 403;
      await models(page);
      await page.getByRole('heading', { name: 'workspace models unavailable', exact: true }).waitFor();
      assert.doesNotMatch(await page.locator('main').innerText(), /This table is missing/);
      await page
        .getByText('You no longer have access to workspace models. A workspace admin can manage permissions.', {
          exact: true,
        })
        .waitFor();
      fixture.catalogStatus = 200;
      await page.getByRole('button', { name: 'Reload workspace models', exact: true }).click();
      await fallback(page).waitFor();
      assert.equal(writes(fixture).length, 0);
    });
    await scenario('general settings denial names settings and retains read-only recovery', async (page, fixture) => {
      await page.goto(`${origin}/acme/settings`);
      await page.getByRole('heading', { name: 'workspace settings unavailable', exact: true }).waitFor();
      await page
        .getByText('You no longer have access to workspace settings. A workspace admin can manage permissions.', {
          exact: true,
        })
        .waitFor();
      assert.doesNotMatch(await page.locator('main').innerText(), /This table is missing/);
      const reads = () => fixture.requests.filter(request => request.path === `${base}/settings`).length;
      const before = reads();
      await page.getByRole('button', { name: 'Reload workspace settings', exact: true }).click();
      await eventually(reads, before + 1);
      await page.getByRole('heading', { name: 'workspace settings unavailable', exact: true }).waitFor();
      assert.equal(writes(fixture).length, 0);
      await recoveryLink(page, page.locator('main'), 403);
    });

    await scenario('access rows carry fallbacks; compaction sits behind one URL parameter', async page => {
      const shots = process.env.MODELS_SCREENSHOTS;
      for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 900 });
        await models(page);
        await page.getByRole('switch', { name: 'Allow Primary family', exact: true }).waitFor();
        await page
          .getByRole('row', { name: 'Primary family', exact: true })
          .getByText('300 / 1,500', { exact: true })
          .waitFor();
        await fallback(page).waitFor();
        await page.getByRole('searchbox', { name: 'Search models' }).fill('second');
        assert.equal(await page.getByRole('switch', { name: 'Allow Primary family', exact: true }).count(), 0);
        await page.getByRole('switch', { name: 'Allow Secondary family', exact: true }).waitFor();
        await page.getByRole('searchbox', { name: 'Search models' }).fill('zzz');
        await page.getByRole('button', { name: 'Clear search', exact: true }).last().click();
        await fallback(page).waitFor();
        if (shots) await page.screenshot({ path: `${shots}/access-${width}.png`, fullPage: true });
        await page.getByRole('tab', { name: 'Compaction', exact: true }).click();
        await page.waitForURL(url => new URL(url).searchParams.get('tab') === 'compaction');
        if (shots) {
          await page.waitForTimeout(300);
          await page.screenshot({ path: `${shots}/compaction-${width}.png`, fullPage: true });
        }
      }
      await page.reload();
      assert.equal(
        await page.getByRole('tab', { name: 'Compaction', exact: true }).getAttribute('aria-selected'),
        'true',
      );
    });

    await scenario('loading becomes success without an empty flash', async (page, fixture) => {
      fixture.catalogGate = gate();
      await watchEmpty(page);
      await models(page);
      await page.getByRole('status', { name: 'Loading workspace models', exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'No models configured yet' }).count(), 0);
      fixture.catalogGate.release();
      await page.getByRole('switch', { name: 'Allow Primary family', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.modelEmptySeen), false);
      await page
        .getByRole('row', { name: 'Primary family', exact: true })
        .getByText('300 / 1,500', { exact: true })
        .waitFor();
    });

    await scenario('initial failure and failed retry remain actionable before recovery', async (page, fixture) => {
      fixture.catalogStatus = 503;
      await watchEmpty(page);
      await models(page);
      await page.getByRole('heading', { name: 'Could not load workspace models' }).waitFor();
      const count = fixture.requests.filter(request => request.path.endsWith('/model-catalog')).length;
      await page.getByRole('button', { name: 'Reload workspace models', exact: true }).click();
      await page.getByRole('heading', { name: 'Could not load workspace models' }).waitFor();
      await eventually(
        () => fixture.requests.filter(request => request.path.endsWith('/model-catalog')).length,
        count + 3,
      );
      assert.equal(await page.evaluate(() => window.modelEmptySeen), false);
      fixture.catalogStatus = 200;
      await page.getByRole('button', { name: 'Reload workspace models', exact: true }).click();
      await page.getByRole('switch', { name: 'Allow Primary family', exact: true }).waitFor();
    });

    await scenario('empty catalog has a working refresh action', async (page, fixture) => {
      fixture.catalog = { families: [] };
      await models(page);
      await page.getByRole('heading', { name: 'No models configured yet' }).waitFor();
      fixture.catalog = structuredClone(catalog);
      await notifyChange(page, workspaceId, 'ada', 'models');
      await page.getByRole('switch', { name: 'Allow Primary family', exact: true }).waitFor();
    });

    await scenario('models route uses the Settings shell heading and leaves other navigation intact', async page => {
      await ready(page);
      await page.getByRole('heading', { name: 'Models', level: 1, exact: true }).waitFor();
      assert.equal(
        await page.locator('header[aria-label="Workspace header"]').getByText('Settings / Models').count(),
        0,
      );
      const navigation = page.getByRole('navigation', { name: 'Workspace navigation', exact: true });
      assert.equal(
        await navigation
          .locator('a')
          .filter({ hasText: /^Inbox$/ })
          .count(),
        0,
      );
      assert.equal(await page.getByRole('link', { name: 'Back to app', exact: true }).count(), 1);
    });

    await scenario(
      'platform-unavailable families are hidden and a fallback to one reads as unset',
      async (page, fixture) => {
        fixture.rules.set('primary', {
          ...initialRule('primary'),
          targetFamilyId: 'unavailable',
          revision: 1,
          editorMembershipId: membershipId,
          updatedAt: timestamp,
        });
        await models(page);
        await eventually(() => fallbackValue(page), 'No fallback');
        assert.equal(await page.getByRole('row', { name: 'Unavailable family', exact: true }).count(), 0);
        assert.equal(await page.getByText(/Unavailable family|Platform unavailable/).count(), 0);
        await fallback(page).click();
        await page.getByRole('option', { name: 'Secondary family', exact: true }).waitFor();
        assert.equal(await page.getByRole('option', { name: /Unavailable family/ }).count(), 0);
        await page.keyboard.press('Escape');
        assert.equal(await saveButton(page).count(), 0);
        assert.equal(writes(fixture).length, 0);
      },
    );

    await scenario('member reads rules and refreshes without write controls or requests', async (page, fixture) => {
      fixture.role = 'member';
      await ready(page, false);
      await page.getByText(/You have read-only access/).waitFor();
      assert.equal(await page.getByRole('combobox').count(), 0);
      assert.equal(await page.getByRole('switch').count(), 0);
      await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/model-policy/rules/primary')),
        notifyChange(page, workspaceId, 'ada', 'models'),
      ]);
      await page.getByText(/You have read-only access/).waitFor();
      assert.equal(writes(fixture).length, 0);
    });

    await scenario('admin choice saves once on change, then removes the fallback', async (page, fixture) => {
      await ready(page);
      assert.equal(await optionDisabled(page, fallback(page), 'Secondary family'), false);
      fixture.saveGate = gate();
      await chooseFallback(page);
      await primary(page).getByText('Saving…', { exact: true }).waitFor();
      await eventually(() => writes(fixture).length, 1);
      const command = writes(fixture)[0].body;
      assert.deepEqual(command, {
        requestId: command.requestId,
        sourceFamilyId: 'primary',
        targetFamilyId: 'secondary',
        expectedRevision: 0,
      });
      assert.match(command.requestId, /^[0-9a-f-]{36}$/);
      assert.equal(await fallback(page).isDisabled(), true);
      fixture.saveGate.release();
      await saved(page, fixture, 'secondary', 1);
      assert.equal(writes(fixture).length, 1);
      assert.equal(fixture.receipts.size, 1);
      assert.equal(await saveButton(page).count(), 0);
      await pickFallback(page, 'No fallback');
      await saved(page, fixture, null, 2);
      assert.deepEqual(writes(fixture)[1].body, {
        requestId: writes(fixture)[1].body.requestId,
        sourceFamilyId: 'primary',
        targetFamilyId: null,
        expectedRevision: 1,
      });
      assert.notEqual(writes(fixture)[1].body.requestId, command.requestId);
    });

    await scenario('confirmed revision survives stale reads after a save', async (page, fixture) => {
      await ready(page);
      fixture.saveGate = gate();
      await chooseFallback(page);
      await primary(page).getByText('Saving…', { exact: true }).waitFor();
      fixture.ruleResponses.set('primary', initialRule('primary'));
      fixture.saveGate.release();
      await saved(page, fixture, 'secondary', 1);
      await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/model-policy/rules/primary')),
        notifyChange(page, workspaceId, 'ada', 'models'),
      ]);
      await eventually(() => fallback(page).isEnabled(), true);
      assert.equal(await fallbackValue(page), 'Secondary family');
      assert.equal(await saveButton(page).count(), 0);
      assert.equal(writes(fixture).length, 1);
      assert.equal(fixture.rules.get('primary').revision, 1);
    });

    await scenario(
      'ordinary fallback refresh keeps row geometry and focused controls stable',
      async (page, fixture) => {
        await ready(page);
        const following = page.getByRole('row', { name: 'Secondary family', exact: true });
        await following.getByLabel('Fallback for Secondary family', { exact: true }).waitFor();
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await eventually(() => fallback(page).isEnabled(), true);
          await fallback(page).focus();
          const control = await fallback(page).elementHandle();
          assert.equal(await control.evaluate(node => node === document.activeElement), true);
          const geometry = async () => ({
            rowTop: await primary(page).evaluate(node => node.getBoundingClientRect().top),
            rowHeight: await primary(page).evaluate(node => node.getBoundingClientRect().height),
            nextTop: await following.evaluate(node => node.getBoundingClientRect().top),
          });
          const before = await geometry();
          const pending = gate();
          fixture.ruleGates.set('primary', pending);
          await notifyChange(page, workspaceId, 'ada', 'model-rule', 'primary');
          await primary(page).getByText('Refreshing fallback rule…', { exact: true }).waitFor({ state: 'attached' });
          await page.evaluate(
            () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          const during = await geometry();
          for (const key of Object.keys(before))
            assert.ok(Math.abs(before[key] - during[key]) <= 1, `${width}px refresh keeps ${key} stable`);
          assert.equal(
            await control.evaluate(
              node =>
                node.isConnected &&
                node === document.activeElement &&
                node === document.querySelector('#fallback-primary'),
            ),
            true,
          );
          pending.release();
          fixture.ruleGates.delete('primary');
          await primary(page).getByText('Refreshing fallback rule…', { exact: true }).waitFor({ state: 'detached' });
          const after = await geometry();
          for (const key of Object.keys(before))
            assert.ok(Math.abs(before[key] - after[key]) <= 1, `${width}px completed refresh keeps ${key} stable`);
          assert.equal(await control.evaluate(node => node.isConnected && node === document.activeElement), true);
        }
        assert.equal(writes(fixture).length, 0, 'A status refresh never writes a fallback');
      },
    );

    await scenario(
      'pending save survives successful parent refresh with the same control and command',
      async (page, fixture) => {
        await ready(page);
        fixture.saveGate = gate();
        const select = await fallback(page).elementHandle();
        await chooseFallback(page);
        await eventually(() => writes(fixture).length, 1);
        const command = structuredClone(writes(fixture)[0].body);
        const ruleGate = gate();
        fixture.ruleGates.set('primary', ruleGate);
        const ruleReads = () =>
          fixture.requests.filter(request => request.path.endsWith('/model-policy/rules/primary')).length;
        const beforeRefresh = ruleReads();
        await notifyChange(page, workspaceId, 'ada', 'models');
        await eventually(ruleReads, beforeRefresh + 1);
        await primary(page).getByText('Refreshing fallback rule…', { exact: true }).waitFor();
        async function retained() {
          assert.equal(
            await select.evaluate(
              element => element.isConnected && element === document.querySelector('#fallback-primary'),
            ),
            true,
          );
          assert.equal(
            await select.$eval('[data-slot="select-value"]', element => element.textContent),
            'Secondary family',
          );
          assert.equal(await select.isDisabled(), true);
          assert.equal(await select.getAttribute('aria-busy'), 'true');
          assert.deepEqual(
            writes(fixture).map(request => request.body),
            [command],
          );
        }
        await retained();
        ruleGate.release();
        await primary(page).getByText('Refreshing fallback rule…', { exact: true }).waitFor({ state: 'hidden' });
        await retained();
        fixture.saveGate.release();
        await saved(page, fixture, 'secondary', 1);
        assert.equal(await select.evaluate(element => element.isConnected), true);
        assert.deepEqual(
          writes(fixture).map(request => request.body),
          [command],
        );
        assert.equal(fixture.receipts.size, 1);
      },
    );

    for (const oldStatus of [200, 403]) {
      await scenario(
        `parent refresh during an active ${oldStatus} rule read queues fresh access revalidation`,
        async (page, fixture) => {
          await ready(page);
          const oldRead = gate();
          fixture.ruleGates.set('primary', oldRead);
          fixture.ruleStatus.set('primary', oldStatus);
          const ruleReads = () =>
            fixture.requests.filter(request => request.path.endsWith('/model-policy/rules/primary')).length;
          const beforeRefresh = ruleReads();
          await notifyChange(page, workspaceId, 'ada', 'models');
          await eventually(ruleReads, beforeRefresh + 1);
          fixture.ruleStatus.set('primary', oldStatus === 200 ? 403 : 200);
          const freshRead = gate();
          fixture.ruleGates.set('primary', freshRead);
          oldRead.release();
          await eventually(ruleReads, beforeRefresh + 2);
          const denied = primary(page).getByRole('heading', { name: 'fallback rule unavailable', exact: true });
          if (oldStatus === 403) {
            await denied.waitFor();
            assert.equal(
              await fallback(page).count(),
              0,
              'An older denied read stays concealed until the fresh rule read succeeds',
            );
          }
          freshRead.release();
          if (oldStatus === 200) {
            await denied.waitFor();
            assert.equal(await fallback(page).count(), 0, 'Fresh denial must conceal a successful older read');
          } else {
            await fallback(page).waitFor();
            await eventually(() => fallback(page).isEnabled(), true);
            assert.equal(await fallbackValue(page), 'No fallback');
          }
          assert.equal(writes(fixture).length, 0);
        },
      );
    }

    await scenario(
      'uncommitted lost response followed by definitive retry rejection unlocks the draft',
      async (page, fixture) => {
        await ready(page);
        fixture.nextSave = 'lose-uncommitted';
        await chooseFallback(page);
        await primary(page)
          .getByText(/No saved result is visible/)
          .waitFor();
        const command = structuredClone(writes(fixture)[0].body);
        fixture.nextSave = 'family-unavailable';
        await primary(page).getByRole('button', { name: 'Retry same save', exact: true }).click();
        await primary(page)
          .getByText(/This model pair is no longer available/)
          .waitFor();
        assert.equal(writes(fixture).length, 2);
        assert.deepEqual(writes(fixture)[1].body, command);
        assert.equal(fixture.receipts.size, 0);
        assert.equal(await fallback(page).isEnabled(), true);
        assert.equal(await fallbackValue(page), 'Secondary family');
        assert.equal(await primary(page).getByRole('button', { name: 'Retry same save', exact: true }).count(), 0);
        await saveButton(page).click();
        await saved(page, fixture, 'secondary', 1);
        assert.equal(writes(fixture).length, 3);
        assert.notEqual(writes(fixture)[2].body.requestId, command.requestId);
      },
    );

    for (const committed of [true, false]) {
      await scenario(
        `lost ${committed ? 'committed' : 'uncommitted'} response recovers through receipt GET`,
        async (page, fixture) => {
          await ready(page);
          fixture.nextSave = committed ? 'lose-committed' : 'lose-uncommitted';
          fixture.receiptGate = gate();
          await chooseFallback(page);
          await primary(page)
            .getByText(/We could not confirm the fallback change/)
            .waitFor();
          assert.equal(await fallback(page).isDisabled(), true);
          assert.equal(writes(fixture).length, 1);
          const command = structuredClone(writes(fixture)[0].body);
          await eventually(
            () =>
              fixture.requests.some(
                request =>
                  request.method === 'GET' && request.path === `${base}/model-policy/commands/${command.requestId}`,
              ),
            true,
          );
          fixture.receiptGate.release();
          if (!committed) {
            await primary(page)
              .getByText(/No saved result is visible/)
              .waitFor();
            assert.equal(fixture.receipts.size, 0);
            assert.equal(await primary(page).getByText('Saved', { exact: true }).count(), 0);
            await primary(page).getByRole('button', { name: 'Retry same save', exact: true }).click();
          }
          await saved(page, fixture, 'secondary', 1);
          assert.equal(writes(fixture).length, committed ? 1 : 2);
          if (!committed)
            assert.deepEqual(
              writes(fixture)[1].body,
              command,
              'Retry preserves every command field, including requestId',
            );
          assert.equal(fixture.receipts.size, 1);
        },
      );
    }

    for (const committed of [false, true])
      await scenario(
        `fallback recovery survives navigation and reload with ${committed ? 'committed' : 'uncommitted'} response`,
        async (page, fixture) => {
          await ready(page);
          fixture.nextSave = committed ? 'lose-committed' : 'lose-uncommitted';
          fixture.receiptGate = gate();
          await chooseFallback(page);
          await primary(page)
            .getByText(/We could not confirm the fallback change/)
            .waitFor();
          const command = structuredClone(writes(fixture)[0].body);
          await primary(page).getByRole('link', { name: 'Recover workspace changes' }).click();
          await page.getByRole('heading', { name: /Acme · Model fallback/ }).waitFor();
          await page.reload();
          await page.getByRole('button', { name: 'Check command status' }).waitFor();
          assert.equal(writes(fixture).length, 1);
          fixture.receiptGate.release();
          await page.getByRole('button', { name: 'Check command status' }).click();
          if (committed) await page.getByText('Model fallback saved.', { exact: true }).waitFor();
          else {
            await page.getByText(/No saved result is visible/).waitFor();
            await models(page);
            await primary(page).getByRole('button', { name: 'Retry same save' }).click();
            await saved(page, fixture, 'secondary', 1);
            assert.deepEqual(writes(fixture)[1].body, command);
          }
          assert.equal(writes(fixture).length, committed ? 1 : 2);
          assert.equal(
            await page.evaluate(
              () => Object.keys(sessionStorage).filter(key => key.startsWith('tulipfarm.pending-command.')).length,
            ),
            0,
          );
        },
      );

    await scenario(
      'conflict reload retains the choice and requires a deliberate save against the new revision',
      async (page, fixture) => {
        await ready(page);
        fixture.rules.set('primary', {
          ...initialRule('primary'),
          revision: 7,
          editorMembershipId: membershipId,
          updatedAt: timestamp,
        });
        await chooseFallback(page);
        await primary(page)
          .getByText(/Another admin changed this rule/)
          .waitFor();
        assert.equal(await saveButton(page).count(), 0);
        await primary(page).getByRole('button', { name: 'Reload latest rule', exact: true }).click();
        await primary(page)
          .getByText(/Another admin changed this rule/)
          .waitFor({ state: 'hidden' });
        assert.equal(await fallbackValue(page), 'Secondary family');
        assert.equal(writes(fixture).length, 1, 'Reload must not write');
        await saveButton(page).click();
        await saved(page, fixture, 'secondary', 8);
        assert.equal(writes(fixture)[1].body.expectedRevision, 7);
        assert.notEqual(writes(fixture)[1].body.requestId, writes(fixture)[0].body.requestId);
      },
    );

    await scenario(
      'failed background refresh retains catalog and saved choice until recovery',
      async (page, fixture) => {
        await ready(page);
        await chooseFallback(page);
        await saved(page, fixture, 'secondary', 1);
        fixture.catalogStatus = 503;
        await notifyChange(page, workspaceId, 'ada', 'models');
        await page.getByRole('button', { name: 'Reload workspace models', exact: true }).waitFor();
        await eventually(() => fallback(page).isDisabled(), true);
        assert.equal(await fallbackValue(page), 'Secondary family');
        fixture.catalogStatus = 200;
        await page.getByRole('button', { name: 'Reload workspace models', exact: true }).click();
        await eventually(() => fallback(page).isEnabled(), true);
        assert.equal(await fallbackValue(page), 'Secondary family');
        assert.equal(writes(fixture).length, 1);
      },
    );

    for (const status of [401, 403, 404]) {
      await scenario(
        `catalog ${status} conceals models and ${status === 401 ? 'recovers through a new session admission' : 'restores the saved choice'}`,
        async (page, fixture) => {
          await ready(page);
          await chooseFallback(page);
          await saved(page, fixture, 'secondary', 1);
          fixture.catalogStatus = status;
          await notifyChange(page, workspaceId, 'ada', 'models');
          await page.getByRole('heading', { name: 'workspace models unavailable', exact: true }).waitFor();
          assert.equal(await primary(page).count(), 0);
          assert.equal(await page.getByRole('combobox').count(), 0);
          assert.equal(writes(fixture).length, 1);
          if (status === 401) {
            fixture.catalogStatus = 200;
            await page.reload();
            await fallback(page).waitFor();
            assert.equal(await fallbackValue(page), 'Secondary family');
            assert.equal(writes(fixture).length, 1, 'Session recovery never saves again');
            return;
          }
          await recoveryLink(page, page, status);
          fixture.catalogStatus = 200;
          await page.getByRole('button', { name: 'Reload workspace models', exact: true }).click();
          await fallback(page).waitFor();
          assert.equal(await fallbackValue(page), 'Secondary family');
          assert.equal(writes(fixture).length, 1, 'Restoring access must not save again');
        },
      );
    }

    for (const status of [401, 403, 404]) {
      for (const operation of ['read', 'save']) {
        await scenario(
          `rule ${operation} denied with ${status} conceals saved data and ${status === 401 ? 'requires session admission' : 'restores the choice'}`,
          async (page, fixture) => {
            await ready(page);
            const region = primary(page);
            if (operation === 'save') {
              fixture.ruleStatus.set('primary', status);
              fixture.nextSave = status;
              await chooseFallback(page);
            } else {
              await chooseFallback(page);
              await saved(page, fixture, 'secondary', 1);
              fixture.ruleStatus.set('primary', status);
              await notifyChange(page, workspaceId, 'ada', 'models');
            }
            const savedReceipts = operation === 'save' ? 0 : 1;
            if (status === 401) {
              if (operation === 'save')
                await region.getByRole('button', { name: 'Reload fallback rule', exact: true }).click();
              await page.getByRole('heading', { name: 'workspace models unavailable', exact: true }).waitFor();
              assert.equal(await primary(page).count(), 0);
              assert.equal(await page.getByRole('combobox').count(), 0);
              assert.equal(writes(fixture).length, 1);
              fixture.ruleStatus.delete('primary');
              await page.reload();
              await fallback(page).waitFor();
              assert.equal(await fallbackValue(page), operation === 'save' ? 'No fallback' : 'Secondary family');
              assert.equal(writes(fixture).length, 1);
              return;
            }
            await region.getByRole('heading', { name: 'fallback rule unavailable', exact: true }).waitFor();
            await recoveryLink(page, region, status);
            assert.equal(await region.getByRole('combobox').count(), 0);
            assert.equal(await saveButton(page).count(), 0);
            assert.equal(writes(fixture).length, 1);
            assert.equal(fixture.receipts.size, savedReceipts);
            await Promise.all([
              page.waitForResponse(response => response.url().endsWith('/model-catalog') && response.status() === 200),
              page.waitForResponse(response => response.url().endsWith('/governance/me') && response.status() === 200),
              page.waitForResponse(
                response => response.url().endsWith('/model-policy/rules/primary') && response.status() === status,
              ),
              region.getByRole('button', { name: 'Reload fallback rule', exact: true }).click(),
            ]);
            await region.getByRole('heading', { name: 'fallback rule unavailable', exact: true }).waitFor();
            assert.equal(
              await region.getByRole('combobox').count(),
              0,
              'A denied reload must not reveal stale rule data',
            );
            fixture.ruleStatus.delete('primary');
            await Promise.all([
              page.waitForResponse(response => response.url().endsWith('/model-catalog') && response.status() === 200),
              page.waitForResponse(response => response.url().endsWith('/governance/me') && response.status() === 200),
              region.getByRole('button', { name: 'Reload fallback rule', exact: true }).click(),
            ]);
            await fallback(page).waitFor();
            assert.equal(await fallbackValue(page), 'Secondary family');
            assert.equal(writes(fixture).length, 1, 'Reloading must not save the retained choice');
            if (operation === 'save') {
              await saveButton(page).click();
              await saved(page, fixture, 'secondary', 1);
              assert.equal(writes(fixture).length, 2);
              assert.equal(writes(fixture)[1].body.expectedRevision, 0);
              assert.notEqual(
                writes(fixture)[0].body.requestId,
                writes(fixture)[1].body.requestId,
                'A deliberate save after confirmed denial is a new command',
              );
            }
            assert.equal(fixture.receipts.size, 1);
          },
        );
      }
    }

    await scenario(
      'denied save reload revalidates a role downgrade before showing read-only rules',
      async (page, fixture) => {
        await ready(page);
        fixture.nextSave = 403;
        await chooseFallback(page);
        const region = primary(page);
        await region.getByRole('heading', { name: 'fallback rule unavailable', exact: true }).waitFor();
        fixture.role = 'member';
        await Promise.all([
          page.waitForResponse(response => response.url().endsWith('/model-catalog') && response.status() === 200),
          page.waitForResponse(response => response.url().endsWith('/governance/me') && response.status() === 200),
          region.getByRole('button', { name: 'Reload fallback rule', exact: true }).click(),
        ]);
        await page.getByText(/You have read-only access/).waitFor();
        await region.getByText('No fallback', { exact: true }).waitFor();
        assert.equal(await page.getByRole('combobox').count(), 0);
        assert.equal(await saveButton(page).count(), 0);
        assert.equal(writes(fixture).length, 1);
        assert.equal(fixture.receipts.size, 0);
        fixture.role = 'admin';
        await notifyChange(page, workspaceId, 'ada', 'models');
        await fallback(page).waitFor();
        assert.equal(await fallbackValue(page), 'Secondary family');
        assert.equal(writes(fixture).length, 1);
      },
    );

    await scenario(
      'committed save retains its uncertain command after a concealed receipt and denied retry',
      async (page, fixture) => {
        await ready(page);
        fixture.nextSave = 'lose-committed';
        fixture.receiptGate = gate();
        await chooseFallback(page);
        await primary(page)
          .getByText(/We could not confirm the fallback change/)
          .waitFor();
        const command = structuredClone(writes(fixture)[0].body);
        const receiptPath = `${base}/model-policy/commands/${command.requestId}`;
        await eventually(
          () => fixture.requests.some(request => request.method === 'GET' && request.path === receiptPath),
          true,
        );
        assert.equal(fixture.receipts.size, 1);
        fixture.role = 'member';
        const missingReceipt = page.waitForResponse(
          response => new URL(response.url()).pathname === receiptPath && response.status() === 404,
        );
        fixture.receiptGate.release();
        await missingReceipt;
        await primary(page)
          .getByText(/No saved result is visible/)
          .waitFor();
        assert.equal(
          await page.getByText(/You have read-only access/).count(),
          0,
          'Parent still holds its earlier admin membership',
        );
        await Promise.all([
          page.waitForResponse(
            response =>
              response.request().method() === 'PUT' &&
              response.url().endsWith('/model-policy') &&
              response.status() === 404,
          ),
          primary(page).getByRole('button', { name: 'Retry same save', exact: true }).click(),
        ]);
        const region = primary(page);
        await region.getByRole('heading', { name: 'fallback rule unavailable', exact: true }).waitFor();
        assert.equal(writes(fixture).length, 2);
        assert.deepEqual(writes(fixture)[1].body, command, 'Denied retry must use the original committed command');
        await Promise.all([
          page.waitForResponse(response => response.url().endsWith('/model-catalog') && response.status() === 200),
          page.waitForResponse(response => response.url().endsWith('/governance/me') && response.status() === 200),
          region.getByRole('button', { name: 'Reload fallback rule', exact: true }).click(),
        ]);
        await page.getByText(/You have read-only access/).waitFor();
        await region.getByText('Secondary family', { exact: true }).waitFor();
        assert.equal(await page.getByRole('combobox').count(), 0);
        assert.equal(await saveButton(page).count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Retry same save', exact: true }).count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Check save status', exact: true }).count(), 0);
        fixture.role = 'admin';
        await Promise.all([
          page.waitForResponse(
            response => new URL(response.url()).pathname === receiptPath && response.status() === 200,
          ),
          notifyChange(page, workspaceId, 'ada', 'models'),
        ]);
        await saved(page, fixture, 'secondary', 1);
        assert.deepEqual(
          writes(fixture).map(request => request.body),
          [command, command],
          'Restored admin must reconcile the receipt, not create another command',
        );
        assert.equal(fixture.receipts.size, 1);
        assert.equal(await saveButton(page).count(), 0);
      },
    );

    await scenario(
      'committed uncertain save survives concealed access and restores through receipt GET only',
      async (page, fixture) => {
        await ready(page);
        fixture.nextSave = 'lose-committed';
        fixture.receiptGate = gate();
        await chooseFallback(page);
        await primary(page)
          .getByText(/We could not confirm the fallback change/)
          .waitFor();
        const command = structuredClone(writes(fixture)[0].body);
        const receiptPath = `${base}/model-policy/commands/${command.requestId}`;
        const receiptReads = () =>
          fixture.requests.filter(request => request.method === 'GET' && request.path === receiptPath).length;
        await eventually(() => receiptReads() > 0, true);
        fixture.catalogStatus = 403;
        await notifyChange(page, workspaceId, 'ada', 'models');
        await page.getByRole('heading', { name: 'workspace models unavailable', exact: true }).waitFor();
        assert.equal(await primary(page).count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Retry same save', exact: true }).count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Check save status', exact: true }).count(), 0);
        const readsBeforeRestore = receiptReads();
        fixture.receiptGate.release();
        await Promise.all([
          page.waitForResponse(response => response.url().endsWith('/model-catalog') && response.status() === 403),
          page.getByRole('button', { name: 'Reload workspace models', exact: true }).click(),
        ]);
        await page.getByRole('heading', { name: 'workspace models unavailable', exact: true }).waitFor();
        assert.equal(receiptReads(), readsBeforeRestore, 'Concealed access must not restart receipt reads');
        assert.equal(await page.getByText('Saved', { exact: true }).count(), 0);
        assert.equal(fixture.receipts.size, 1);
        assert.equal(writes(fixture).length, 1);
        fixture.catalogStatus = 200;
        await page.getByRole('button', { name: 'Reload workspace models', exact: true }).click();
        await saved(page, fixture, 'secondary', 1);
        assert.ok(receiptReads() > readsBeforeRestore, 'Restoration must issue a new GET for the retained request ID');
        assert.equal(writes(fixture).length, 1, 'Receipt recovery must not repeat the committed PUT');
        assert.deepEqual(writes(fixture)[0].body, command);
      },
    );

    await scenario(
      'admin downgrade removes edit controls and restoring admin brings them back',
      async (page, fixture) => {
        await ready(page);
        await chooseFallback(page);
        await saved(page, fixture, 'secondary', 1);
        fixture.role = 'member';
        await notifyChange(page, workspaceId, 'ada', 'models');
        await page.getByText(/You have read-only access/).waitFor();
        await primary(page).getByText('Secondary family', { exact: true }).waitFor();
        assert.equal(await page.getByRole('combobox').count(), 0);
        assert.equal(await saveButton(page).count(), 0);
        fixture.role = 'admin';
        await notifyChange(page, workspaceId, 'ada', 'models');
        await fallback(page).waitFor();
        assert.equal(await fallbackValue(page), 'Secondary family');
        assert.equal(writes(fixture).length, 1);
      },
    );

    await scenario(
      'agent without a preference saves normally without a default model family',
      async (page, fixture) => {
        delete fixture.agent.definition.modelFamilyId;
        await page.goto(`${origin}/acme/agents/${agentId}`);
        await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
        const select = modelPreference(page);
        await select.waitFor();
        // An empty preference reads as the workspace default (cloud 3e124b0f #1004, features/models/agent-model-picker.tsx:25).
        assert.equal(await modelPreferenceValue(page), 'Workspace default');
        await page.getByText('Leave empty to let the workspace choose.', { exact: true }).waitFor();
        assert.equal(await page.getByRole('region', { name: 'Inherited workspace fallback', exact: true }).count(), 0);
        await page
          .getByRole('textbox', { name: 'Instructions', exact: true })
          .fill('Read rows and summarize outstanding work.');
        await page.getByRole('button', { name: 'Save agent', exact: true }).click();
        await page.getByText('Agent saved.', { exact: true }).waitFor();
        assert.equal(writes(fixture).length, 1);
        assert.equal(writes(fixture)[0].path, `${base}/agents/${agentId}`);
        assert.deepEqual(writes(fixture)[0].body.definition, {
          name: 'Research assistant',
          instructions: 'Read rows and summarize outstanding work.',
          tools: ['schema.inspect'],
          skills: [],
          responseRule: 'tag',
        });
        assert.equal(Object.hasOwn(writes(fixture)[0].body.definition, 'modelFamilyId'), false);
        await page.reload();
        await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
        await select.waitFor();
        assert.equal(await modelPreferenceValue(page), 'Workspace default');
        assert.equal(
          await page.getByRole('textbox', { name: 'Instructions', exact: true }).inputValue(),
          'Read rows and summarize outstanding work.',
        );
        assert.equal(
          fixture.requests.some(request => request.path.includes('/model-policy/')),
          false,
          'Absent preference must not load or create an inherited fallback',
        );
      },
    );

    await scenario(
      'fixture-only instructions save keeps a hidden agent preference, not backend acceptance proof',
      async (page, fixture) => {
        await page.goto(`${origin}/acme/agents/${agentId}`);
        await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
        // An unavailable saved preference stays visible and unreplaced (cloud 3e124b0f #1004, features/models/agent-model-picker.tsx:20,25,28).
        await page
          .getByText(
            'Your saved preference is unavailable and has not been replaced. Choose an available family or clear it.',
            { exact: true },
          )
          .waitFor();
        assert.equal(await modelPreferenceValue(page), 'retired-family (unavailable)');
        await page
          .getByRole('textbox', { name: 'Instructions', exact: true })
          .fill('Summarize the supplied rows without changing model preference.');
        await page.getByRole('button', { name: 'Save agent', exact: true }).click();
        await page.getByText('Agent saved.', { exact: true }).waitFor();
        assert.equal(writes(fixture).length, 1);
        assert.equal(writes(fixture)[0].path, `${base}/agents/${agentId}`);
        assert.deepEqual(writes(fixture)[0].body.definition, {
          name: 'Research assistant',
          instructions: 'Summarize the supplied rows without changing model preference.',
          tools: ['schema.inspect'],
          modelFamilyId: 'retired-family',
          skills: [],
          responseRule: 'tag',
        });
        await page.reload();
        await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
        await page
          .getByText(
            'Your saved preference is unavailable and has not been replaced. Choose an available family or clear it.',
            { exact: true },
          )
          .waitFor();
        assert.equal(await modelPreferenceValue(page), 'retired-family (unavailable)');
        assert.equal(
          await page.getByRole('textbox', { name: 'Instructions', exact: true }).inputValue(),
          'Summarize the supplied rows without changing model preference.',
        );
      },
    );

    await scenario(
      'agent with a hidden preference saves an available choice in its normal definition',
      async (page, fixture) => {
        fixture.rules.set('primary', {
          ...initialRule('primary'),
          targetFamilyId: 'secondary',
          revision: 2,
          editorMembershipId: membershipId,
          updatedAt: timestamp,
        });
        await page.goto(`${origin}/acme/agents/${agentId}`);
        await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
        const select = modelPreference(page);
        await select.waitFor();
        assert.equal(await modelPreferenceValue(page), 'retired-family (unavailable)');
        await select.click();
        assert.equal(
          await page
            .getByRole('option', { name: 'retired-family (unavailable)', exact: true })
            .getAttribute('aria-disabled'),
          'true',
        );
        assert.equal(writes(fixture).length, 0);
        // Agent family options carry their credit rates (cloud 3e124b0f #1004, features/models/agent-model-picker.tsx:29, model-option.tsx:11-13).
        await page.getByRole('option', { name: /^Primary family / }).click();
        const inherited = page.getByRole('region', { name: 'Inherited workspace fallback', exact: true });
        await inherited.getByText('Inherited fallback: secondary. Rule revision 2.', { exact: true }).waitFor();
        assert.equal(await inherited.getByRole('combobox').count(), 0);
        await page.getByRole('button', { name: 'Save agent', exact: true }).click();
        await page.getByText('Agent saved.', { exact: true }).waitFor();
        assert.equal(writes(fixture).length, 1);
        const write = writes(fixture)[0];
        assert.equal(write.path, `${base}/agents/${agentId}`);
        assert.deepEqual(write.body.definition, {
          name: 'Research assistant',
          instructions: 'Read the supplied business rows.',
          tools: ['schema.inspect'],
          modelFamilyId: 'primary',
          skills: [],
          responseRule: 'tag',
        });
        assert.equal(write.body.expectedSavedRevision, 'a'.repeat(40));
        await page.reload();
        await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
        await modelPreference(page).waitFor();
        assert.equal(await modelPreferenceValue(page), 'Primary family');
      },
    );

    await scenario(
      'agent conflict exposes newer definition and deliberately adopts its model preference',
      async (page, fixture) => {
        await page.goto(`${origin}/acme/agents/${agentId}`);
        await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
        await pickModel(page, 'Primary family');
        fixture.agent = {
          ...fixture.agent,
          savedRevision: 'e'.repeat(40),
          definitionRevision: 'f'.repeat(64),
          definition: { ...definition, instructions: 'Newer saved instructions.', modelFamilyId: 'secondary' },
        };
        await page.getByRole('button', { name: 'Save agent', exact: true }).click();
        await page.getByText(/An agent, policy, or workspace definition changed/).waitFor();
        assert.equal(await modelPreferenceValue(page), 'Primary family');
        await page.getByRole('button', { name: 'Check status again', exact: true }).click();
        const newer = page.getByRole('region', { name: 'Newer saved definition', exact: true });
        await newer.getByText('Model preference: secondary', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Save agent', exact: true }).isDisabled(), true);
        assert.equal(await modelPreferenceValue(page), 'Primary family');
        assert.equal(writes(fixture).length, 1);
        await newer.getByRole('button', { name: 'Use newer saved text', exact: true }).click();
        assert.equal(await modelPreferenceValue(page), 'Secondary family');
        assert.equal(
          await page.getByRole('textbox', { name: 'Instructions', exact: true }).inputValue(),
          'Newer saved instructions.',
        );
        assert.equal(writes(fixture).length, 1);
        await page.getByRole('button', { name: 'Save agent', exact: true }).click();
        await page.getByText('Agent saved.', { exact: true }).waitFor();
        assert.equal(writes(fixture)[1].body.expectedSavedRevision, 'e'.repeat(40));
        assert.equal(writes(fixture)[1].body.definition.modelFamilyId, 'secondary');
      },
    );

    for (const theme of ['light', 'dark']) {
      await scenario(
        `narrow ${theme} layout, keyboard save, and reduced motion`,
        async (page, fixture) => {
          await page.addInitScript(value => localStorage.setItem('tulipfarm.theme', value), theme);
          await ready(page);
          assert.equal(await page.evaluate(value => document.documentElement.classList.contains(value), theme), true);
          assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
          await fallback(page).focus();
          await page.keyboard.press('Enter');
          await page.getByRole('option', { name: 'Secondary family', exact: true }).waitFor();
          await page.keyboard.press('s');
          await page.keyboard.press('Enter');
          await saved(page, fixture, 'secondary', 1);
          assert.equal(writes(fixture).length, 1);
          for (const path of ['/acme/settings/models', `/acme/agents/${agentId}`]) {
            await page.goto(`${origin}${path}`);
            await page
              .getByRole('heading', { name: path.includes('/agents/') ? 'Research assistant' : 'Models', exact: true })
              .waitFor();
            if (path.includes('/agents/')) await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
            await page.getByRole('combobox').first().waitFor();
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              true,
              'Document must not overflow horizontally',
            );
            assert.equal(
              await page
                .locator('[data-slot="page-content"]')
                .locator('..')
                .evaluate(element => element.scrollWidth <= element.clientWidth + 1),
              true,
              'View must not hide horizontal overflow',
            );
          }
        },
        { viewport: { width: 390, height: 844 }, colorScheme: theme, reducedMotion: 'reduce' },
      );
    }
    assert.ok(matchedScenario, `No Models scenario matches ${selectedScenario}`);
    t.diagnostic(
      'Proof uses the actual Vite UI and node:http fixtures only. It does not prove production authorization, persistence, provider execution, or deployment readiness.',
    );
  } finally {
    await browser?.close();
    if (vite && vite.exitCode === null) {
      vite.kill('SIGTERM');
      await Promise.race([once(vite, 'exit'), delay(3000)]);
      if (vite.exitCode === null) vite.kill('SIGKILL');
    }
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
});
