import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { notifyChange } from './chat-query.fixture.mjs';
import { workspaceChange } from './workspace-query.fixture.mjs';
import { governanceSnapshot } from './governance-snapshot.mjs';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const membershipId = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-09-29T00:00:00.000Z';
const base = `/v1/workspaces/${workspaceId}`;
const workspace = {
  id: workspaceId,
  name: 'Acme',
  slug: 'acme',
  createdAt: timestamp,
  status: 'ready',
  soulCommit: 'a'.repeat(40),
};
const family = {
  id: 'primary',
  displayName: 'Primary family',
  vendor: 'anthropic',
  currentVersion: 'v1',
  provider: 'anthropic',
  inputCreditsPerMillionTokens: 300,
  outputCreditsPerMillionTokens: 1500,
  available: true,
  unavailableReason: null,
  mappingRevision: 'mapping-1',
  pricingRevision: 'pricing-1',
  fallbackFor: [],
};
const platformFamily = {
  ...family,
  id: 'platform',
  displayName: 'Platform family',
  available: false,
  unavailableReason: 'model-family-unavailable',
  mappingRevision: null,
  pricingRevision: null,
};
const gate = () => {
  const { promise, resolve } = Promise.withResolvers();
  return { promise, release: resolve };
};
function fixture() {
  return {
    userId: 'ada',
    name: 'Acme',
    revision: 0,
    role: 'admin',
    canLeave: true,
    deleted: false,
    catalogStatus: 200,
    settingsStatus: 200,
    modelStatus: 200,
    receiptStatus: 200,
    nextWrite: 'commit',
    readGate: null,
    writeGate: null,
    receipts: new Map(),
    modelReceipts: new Map(),
    fallbackReceipts: new Map(),
    models: [
      { familyId: 'primary', enabled: true, revision: 0 },
      { familyId: 'platform', enabled: true, revision: 0 },
    ],
    writes: [],
    errors: [],
    requests: [],
  };
}
async function eventually(read, expected) {
  for (let i = 0; i < 100; i++) {
    if ((await read()) === expected) return;
    await delay(40);
  }
  assert.equal(await read(), expected);
}

test('workspace settings in the real Vite app with HTTP fixtures', { timeout: 240_000 }, async t => {
  const port = Number(process.env.SETTINGS_BROWSER_PORT ?? 5203);
  const origin = `http://127.0.0.1:${port}`;
  let state = fixture();
  let vite;
  let browser;
  let output = '';
  const server = createServer(async (request, response) => {
    const current = state;
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Cache-Control', 'no-store');
    const send = (body, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
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
      const input = raw ? JSON.parse(raw) : undefined;
      current.requests.push({ method: request.method, path, input });
      if (request.method === 'POST' && path === '/v1/user/visit') return send({ firstSession: false });
      // Opening a workspace records it as last used (cloud a5272032 #972, lib/workspaces.ts:33).
      if (request.method === 'PUT' && path === '/v1/workspaces/acme/last-used') {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'GET') {
        if (path === '/v1/feature-flags') return send({});
        if (path === '/v1/auth/options') return send({ turnstileSiteKey: null, google: true, magicLink: true });
        // The workspace shell's background reads, answered as cloud's own mock does (cloud 866ec800 #1080, features/tables/workspace-members-mock-api.ts:267-273).
        if (path === '/v1/google-workspace/availability') return send({ configured: false });
        if (path === `${base}/google-workspace`) return send({ status: 'disconnected' });
        if (path === `${base}/slack/status`)
          return send({ state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] });
        if (path === `${base}/github/accounts`) return send({ configured: false, accounts: [] });
        if (path === `${base}/atlassian/accounts`) return send({ accounts: [], providers: [] });
        if (path === `${base}/bud`)
          return send({
            conversationId: null,
            onboarding: 'ineligible',
            bubblesEnabled: false,
            snoozedUntil: null,
            nudge: null,
            preferences: [],
          });
        if (path === `${base}/workspace-mcp/capabilities`) return send({ enabled: false });
        if (path === `${base}/recommendations/events`) {
          response.writeHead(204);
          response.end();
          return;
        }
        if (path === `${base}/personal-memory`)
          return send({ content: 'Use concise answers and include next steps.', revision: 1 });
        if (path === `${base}/compaction-policy`)
          return send({
            automatic: true,
            triggerPercent: 70,
            targetPercent: 30,
            modelFamilyId: 'primary',
            fallbackFamilyId: null,
            outputPrompt: null,
            revision: 0,
            editorMembershipId: null,
            updatedAt: null,
            budgetFamilies: [],
          });
        if (path === `${base}/credits`) {
          await current.creditGate?.promise;
          if (current.creditStatus && current.creditStatus !== 200)
            return send({ error: 'credits-unavailable' }, current.creditStatus);
          return send(
            current.credits ?? {
              available: 1000,
              granted: 1000,
              used: 0,
              held: 0,
              days: [{ date: '2026-09-29', credits: 0 }],
              breakdown: [],
              series: [],
            },
          );
        }
        if (path === '/v1/auth/get-session')
          return send(
            current.userId
              ? {
                  session: {
                    id: `session-${current.userId}`,
                    userId: current.userId,
                    expiresAt: '2099-01-01T00:00:00.000Z',
                  },
                  user: {
                    id: current.userId,
                    name: 'Ada',
                    email: 'ada@example.com',
                    emailVerified: true,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                  },
                }
              : null,
          );
        if (path === '/v1/workspaces') return send(current.deleted ? [] : [{ ...workspace, name: current.name }]);
        if (path === '/v1/workspaces/acme')
          return current.deleted ? send({ error: 'not-found' }, 404) : send({ ...workspace, name: current.name });
        if (path === `${base}/governance/me`)
          return current.deleted
            ? send({ error: 'not-found' }, 404)
            : send({
                membershipId,
                role: current.role,
                teams: [],
                capabilities: { manageGovernance: current.role === 'admin', canLeave: current.canLeave },
              });
        if (path === `${base}/governance`)
          return send(
            governanceSnapshot({
              actorMembershipId: membershipId,
              members: [{ id: membershipId, userId: 'ada', name: 'Ada', email: 'ada@example.com', role: current.role }],
              teams: [],
              resources: [],
              grants: [],
            }),
          );
        if (path === `${base}/governance/invitations`) return send({ items: [], nextCursor: null });
        if (path === `${base}/governance/person-grants`) return send({ grants: [] });
        if (path === `${base}/settings`) {
          await current.readGate?.promise;
          if (current.settingsStatus !== 200) return send({ error: 'settings-unavailable' }, current.settingsStatus);
          return send({
            workspaceId,
            name: current.name,
            slug: 'acme',
            revision: current.revision,
            canManage: current.role === 'admin',
          });
        }
        if (path.startsWith(`/v1/workspace-settings/${workspaceId}/commands/`)) {
          if (current.receiptStatus !== 200) return send({ error: 'receipt-unavailable' }, current.receiptStatus);
          const receipt = current.receipts.get(path.split('/').at(-1));
          return receipt ? send(receipt) : send({ error: 'command-not-found' }, 404);
        }
        if (path === `${base}/model-catalog`)
          return current.catalogStatus !== 200
            ? send({ error: 'unavailable' }, current.catalogStatus)
            : send({
                families: [
                  current.models[0]?.enabled === false
                    ? {
                        ...family,
                        available: false,
                        unavailableReason: 'workspace-disabled',
                        mappingRevision: null,
                        pricingRevision: null,
                      }
                    : family,
                  platformFamily,
                ],
              });
        if (path === `${base}/model-policy/availability`)
          return current.modelStatus === 200
            ? send({ items: current.models })
            : send({ error: 'unavailable' }, current.modelStatus);
        if (path.startsWith(`/v1/workspace-settings/${workspaceId}/model-availability/commands/`)) {
          if (current.receiptStatus !== 200) return send({ error: 'receipt-unavailable' }, current.receiptStatus);
          const receipt = current.modelReceipts.get(path.split('/').at(-1));
          return receipt ? send(receipt) : send({ error: 'command-not-found' }, 404);
        }
        if (path.startsWith(`${base}/model-policy/commands/`)) {
          if (current.receiptStatus !== 200) return send({ error: 'receipt-unavailable' }, current.receiptStatus);
          const receipt = current.fallbackReceipts.get(path.split('/').at(-1));
          return receipt ? send(receipt) : send({ error: 'command-not-found' }, 404);
        }
        if (path.startsWith(`${base}/model-policy/rules/`))
          return send({
            sourceFamilyId: path.split('/').at(-1),
            targetFamilyId: null,
            revision: 0,
            editorMembershipId: null,
            updatedAt: null,
          });
      }
      if (path === '/v1/user/visit') return send({ firstSession: false });
      if (request.method === 'PUT' || request.method === 'POST') {
        current.writes.push({ path, input });
        await current.writeGate?.promise;
        if (path === `${base}/governance/leave`) {
          if (!current.canLeave) return send({ error: 'final-admin' }, 409);
          current.deleted = true;
          return send({ ok: true });
        }
        if (current.role !== 'admin') return send({ error: 'forbidden' }, 403);
        const mode = current.nextWrite;
        current.nextWrite = 'commit';
        const model = path === `${base}/model-policy/availability`;
        const receipts = model ? current.modelReceipts : current.receipts;
        const previous = receipts.get(input.requestId);
        if (previous) return send(previous);
        const row = current.models.find(row => row.familyId === input.familyId);
        if (input.expectedRevision !== (model ? row.revision : current.revision))
          return send({ error: 'settings-revision-conflict' }, 409);
        let receipt;
        if (model)
          receipt = {
            familyId: input.familyId,
            enabled: input.enabled,
            revision: row.revision + 1,
            requestId: input.requestId,
          };
        else if (path.endsWith('/name'))
          receipt = { requestId: input.requestId, name: input.name, revision: current.revision + 1 };
        else if (path.endsWith('/delete')) {
          assert.equal(input.confirmationName, current.name);
          assert.equal(input.acknowledgeRetainedData, true);
          receipt = { requestId: input.requestId, workspaceId, status: 'deleted', dataDisposition: 'retained' };
        } else throw new Error(`Unexpected write ${path}`);
        if (mode !== 'lose-uncommitted') {
          receipts.set(input.requestId, receipt);
          if (model) Object.assign(row, { enabled: receipt.enabled, revision: receipt.revision });
          else if (path.endsWith('/name')) {
            current.name = input.name;
            current.revision++;
          } else current.deleted = true;
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
      throw new Error(`Unexpected ${request.method} ${path}`);
    } catch (error) {
      current.errors.push(String(error));
      if (!response.headersSent) send({ error: 'fixture-error' }, 500);
      else response.destroy();
    }
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, VITE_API_URL: `http://127.0.0.1:${server.address().port}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    vite.stdout.on('data', data => {
      output = (output + data).slice(-16000);
    });
    vite.stderr.on('data', data => {
      output = (output + data).slice(-16000);
    });
    for (let i = 0; ; i++) {
      assert.equal(vite.exitCode, null, output);
      if (
        output.includes(origin) &&
        (await fetch(origin).then(
          r => r.ok,
          () => false,
        ))
      )
        break;
      assert.ok(i < 150, output);
      await delay(100);
    }
    browser = await chromium.launch({ headless: true });
    async function scenario(name, run, options = {}) {
      if (process.env.SETTINGS_SCENARIO && !name.includes(process.env.SETTINGS_SCENARIO)) return;
      await t.test(name, { timeout: 25_000 }, async () => {
        state = fixture();
        const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, ...options });
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        page.setDefaultNavigationTimeout(30000);
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        try {
          await run(page, state);
          assert.deepEqual(state.errors, []);
          assert.deepEqual(errors, []);
        } catch (error) {
          t.diagnostic(
            JSON.stringify({
              errors,
              fixtureErrors: state.errors,
              body: await page.locator('body').innerText(),
              vite: output,
            }),
          );
          throw error;
        } finally {
          state.readGate?.release();
          state.writeGate?.release();
          await context.close();
        }
      });
    }
    async function general(page) {
      await page.goto(`${origin}/acme/settings`);
      await page.getByLabel('Workspace name', { exact: true }).waitFor();
    }
    const saveName = page => page.getByRole('button', { name: 'Save name', exact: true });
    const nav = page => page.getByRole('navigation', { name: 'Settings', exact: true });
    for (const channel of ['settings', 'availability', 'fallback'])
      await scenario(
        `account ${channel} receipt checks never automatically read or replay a retained command`,
        async (page, f) => {
          const requestId = '33333333-3333-4333-8333-333333333333';
          const command =
            channel === 'settings'
              ? { kind: 'rename', requestId, expectedRevision: 0, name: 'Retained name' }
              : channel === 'availability'
                ? { requestId, expectedRevision: 0, familyId: 'primary', enabled: false }
                : { requestId, expectedRevision: 0, sourceFamilyId: 'primary', targetFamilyId: null };
          const pending = {
            userId: 'ada',
            workspaceId,
            channel,
            command,
            ...(channel === 'fallback' ? { scope: 'primary' } : {}),
          };
          await page.addInitScript(pending => {
            sessionStorage.setItem(
              `tulipfarm.pending-command.${JSON.stringify(['ada', pending.workspaceId, pending.channel, ...(pending.channel === 'fallback' ? ['primary'] : [])])}`,
              JSON.stringify(pending),
            );
          }, pending);
          f.deleted = true;
          f.receiptStatus = 503;
          await page.goto(`${origin}/account/workspace-recovery`);
          const check = page.getByRole('button', { name: 'Check command status', exact: true });
          await check.waitFor();
          const reads = () =>
            f.requests.filter(request => request.method === 'GET' && request.path.includes('/commands/'));
          assert.equal(reads().length, 0, 'Restoration must wait for a deliberate check');
          await check.click();
          await page.getByText(/Could not check whether your change was saved/).waitFor();
          await page.evaluate(() => {
            window.dispatchEvent(new Event('focus'));
            window.dispatchEvent(new Event('online'));
          });
          await delay(3500);
          assert.equal(reads().length, 1, 'Failed receipt checks do not retry on timers, focus or reconnect');
          assert.equal(f.writes.length, 0);
          f.receiptStatus = 404;
          await check.click();
          await page.getByText(/No saved result is visible/).waitFor();
          assert.equal(reads().length, 2);
          assert.equal(await page.getByRole('button', { name: 'Retry same request' }).count(), 0);
          const retained = await page.evaluate(() =>
            Object.keys(sessionStorage)
              .filter(key => key.startsWith('tulipfarm.pending-command.'))
              .map(key => JSON.parse(sessionStorage.getItem(key))),
          );
          assert.deepEqual(retained, [pending]);
          f.receiptStatus = 200;
          const receipts =
            channel === 'settings' ? f.receipts : channel === 'availability' ? f.modelReceipts : f.fallbackReceipts;
          receipts.set(
            requestId,
            channel === 'settings'
              ? { requestId, name: 'Retained name', revision: 1 }
              : channel === 'availability'
                ? { requestId, familyId: 'primary', enabled: false, revision: 1 }
                : {
                    requestId,
                    sourceFamilyId: 'primary',
                    targetFamilyId: null,
                    revision: 1,
                    editorMembershipId: membershipId,
                    updatedAt: timestamp,
                  },
          );
          await check.click();
          await page
            .getByText(
              channel === 'settings'
                ? 'Workspace name saved.'
                : channel === 'availability'
                  ? 'Model access saved.'
                  : 'Model fallback saved.',
              { exact: true },
            )
            .waitFor();
          assert.equal(reads().length, 3, 'Each deliberate check reaches the server');
          assert.ok(reads().every(request => request.path.endsWith(`/${requestId}`)));
          assert.equal(f.writes.length, 0);
          assert.equal(
            await page.evaluate(
              () => Object.keys(sessionStorage).filter(key => key.startsWith('tulipfarm.pending-command.')).length,
            ),
            0,
          );
        },
      );
    async function models(page) {
      await page.goto(`${origin}/acme/settings/models`);
      await page.getByRole('switch', { name: 'Allow Primary family', checked: true }).waitFor();
    }

    await scenario('loading keeps navigation visible, then read-only identity and reset work', async (page, f) => {
      f.readGate = gate();
      await page.goto(`${origin}/acme/settings`);
      await page.getByRole('status', { name: 'Loading workspace settings', exact: true }).waitFor();
      assert.equal(await nav(page).getByRole('link').count(), 6);
      f.readGate.release();
      await page.getByLabel('Workspace name', { exact: true }).waitFor();
      assert.equal(
        await page
          .locator('code')
          .filter({ hasText: `${origin}/acme` })
          .innerText(),
        `${origin}/acme`,
      );
      assert.equal(await page.locator('code').filter({ hasText: workspaceId }).innerText(), workspaceId);
      await page.getByLabel('Workspace name', { exact: true }).fill('Draft');
      await page.getByRole('button', { name: 'Reset name', exact: true }).click();
      assert.equal(await page.getByLabel('Workspace name', { exact: true }).inputValue(), 'Acme');
      assert.equal(f.writes.length, 0);
    });
    await scenario('initial error, failed retry and successful retry', async (page, f) => {
      f.settingsStatus = 503;
      await page.goto(`${origin}/acme/settings`);
      await page.getByRole('heading', { name: 'Could not load workspace settings' }).waitFor();
      await page.getByRole('button', { name: 'Reload workspace settings' }).click();
      await page.getByRole('heading', { name: 'Could not load workspace settings' }).waitFor({ state: 'hidden' });
      await page.getByRole('heading', { name: 'Could not load workspace settings' }).waitFor();
      f.settingsStatus = 200;
      await page.getByRole('button', { name: 'Reload workspace settings' }).click();
      await page.getByLabel('Workspace name', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Workspace name', { exact: true }).inputValue(), 'Acme');
    });
    await scenario('double submit writes once and rename persists through reload', async (page, f) => {
      await general(page);
      await page.getByLabel('Workspace name', { exact: true }).fill('New Acme');
      f.writeGate = gate();
      await saveName(page).dblclick();
      await page.getByRole('button', { name: 'Saving name…', exact: true }).waitFor();
      assert.equal(f.writes.length, 1);
      f.writeGate.release();
      await page.getByText('Workspace name saved.', { exact: true }).waitFor();
      assert.deepEqual(f.writes[0].input, {
        requestId: f.writes[0].input.requestId,
        expectedRevision: 0,
        name: 'New Acme',
      });
      await page.reload();
      await page.getByLabel('Workspace name', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Workspace name', { exact: true }).inputValue(), 'New Acme');
    });
    await scenario('conflict retains draft and rebases only after deliberate reload', async (page, f) => {
      await general(page);
      await page.getByLabel('Workspace name', { exact: true }).fill('My draft');
      f.name = 'Other admin';
      f.revision = 4;
      await saveName(page).click();
      await page.getByText(/Workspace settings changed/).waitFor();
      assert.equal(
        await page.evaluate(
          () => Object.keys(sessionStorage).filter(key => key.startsWith('tulipfarm.pending-command.')).length,
        ),
        0,
      );
      assert.equal(await saveName(page).isDisabled(), true);
      await page.getByRole('button', { name: 'Reload latest settings' }).click();
      await eventually(() => saveName(page).isEnabled(), true);
      assert.equal(await page.getByLabel('Workspace name', { exact: true }).inputValue(), 'My draft');
      assert.equal(f.writes.length, 1);
      await saveName(page).click();
      await page.getByText('Workspace name saved.', { exact: true }).waitFor();
      assert.equal(f.writes[1].input.expectedRevision, 4);
      assert.notEqual(f.writes[0].input.requestId, f.writes[1].input.requestId);
    });
    for (const committed of [true, false])
      await scenario(
        `lost ${committed ? 'committed' : 'uncommitted'} rename recovers with original command`,
        async (page, f) => {
          await general(page);
          await page.getByLabel('Workspace name', { exact: true }).fill('Retained name');
          f.nextWrite = committed ? 'lose-committed' : 'lose-uncommitted';
          await saveName(page).click();
          await page.getByText(/We could not confirm your change/).waitFor();
          assert.equal(await page.getByLabel('Workspace name', { exact: true }).getAttribute('readonly'), '');
          await page.getByRole('button', { name: 'Check command status' }).click();
          if (!committed) {
            await page.getByText(/No saved result is visible/).waitFor();
            await page.getByRole('button', { name: 'Retry same request' }).click();
          }
          await page.getByText('Workspace name saved.', { exact: true }).waitFor();
          assert.equal(f.writes.length, committed ? 1 : 2);
          if (!committed) assert.deepEqual(f.writes[1], f.writes[0]);
        },
      );
    await scenario(
      'failed refresh retains draft, demotion hides writes, restoration restores draft',
      async (page, f) => {
        await general(page);
        await page.getByLabel('Workspace name', { exact: true }).fill('Retained');
        f.settingsStatus = 503;
        await workspaceChange(page, workspaceId, f.userId, [['settings']]);
        await page.getByRole('button', { name: 'Reload workspace settings' }).waitFor();
        assert.equal(await page.getByLabel('Workspace name', { exact: true }).inputValue(), 'Retained');
        assert.equal(await saveName(page).isDisabled(), true);
        f.settingsStatus = 200;
        f.role = 'member';
        await page.getByRole('button', { name: 'Reload workspace settings' }).click();
        await page.getByText('Only workspace admins can rename or close this workspace.', { exact: true }).waitFor();
        assert.equal(await saveName(page).count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Close workspace', exact: true }).count(), 0);
        assert.equal(await page.getByRole('textbox', { name: 'Workspace name', exact: true }).count(), 0);
        assert.equal(await page.locator('#workspace-name-help').count(), 0);
        assert.equal(
          await page
            .locator('p')
            .filter({ hasText: /^Acme$/ })
            .innerText(),
          'Acme',
        );
        f.role = 'admin';
        await workspaceChange(page, workspaceId, f.userId, [['governance', 'membership'], ['settings']]);
        await saveName(page).waitFor();
        assert.equal(await page.getByLabel('Workspace name', { exact: true }).inputValue(), 'Retained');
      },
    );
    await scenario('unsaved navigation asks before discarding and common sections remain linked', async page => {
      await general(page);
      await page.getByLabel('Workspace name', { exact: true }).fill('Unsaved');
      await nav(page).getByRole('link', { name: 'Teams', exact: true }).click();
      await page.getByRole('heading', { name: 'Leave these edits?' }).waitFor();
      await page.getByRole('button', { name: 'Keep editing' }).click();
      assert.equal(await page.getByLabel('Workspace name', { exact: true }).inputValue(), 'Unsaved');
      await page.getByRole('button', { name: 'Reset name' }).click();
      for (const [label, heading] of [
        ['Teams', 'Teams'],
        ['Table access', 'Table access'],
        ['Members', 'Members'],
        ['General', 'General'],
      ]) {
        await nav(page).getByRole('link', { name: label, exact: true }).click();
        await page.getByRole('heading', { name: heading, exact: true, level: 1 }).waitFor();
        assert.equal(
          await nav(page).getByRole('link', { name: label, exact: true }).getAttribute('aria-current'),
          'page',
        );
      }
    });
    await scenario('access denial conceals workspace identity and recovery preserves the draft', async (page, f) => {
      await general(page);
      await page.getByLabel('Workspace name', { exact: true }).fill('Private draft');
      f.settingsStatus = 403;
      await workspaceChange(page, workspaceId, f.userId, [['settings']]);
      await page.getByRole('heading', { name: 'workspace settings unavailable', exact: true }).waitFor();
      assert.equal(await page.getByLabel('Workspace name', { exact: true }).count(), 0);
      assert.equal(await page.getByLabel('Workspace ID', { exact: true }).count(), 0);
      assert.equal(await nav(page).getByRole('link').count(), 6);
      f.settingsStatus = 200;
      await page.getByRole('button', { name: 'Reload workspace settings' }).click();
      await page.getByLabel('Workspace name', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Workspace name', { exact: true }).inputValue(), 'Private draft');
      assert.equal(f.writes.length, 0);
    });
    await scenario('server demotion rejects a rename and removes admin controls', async (page, f) => {
      await general(page);
      await page.getByLabel('Workspace name', { exact: true }).fill('Rejected draft');
      f.role = 'member';
      await saveName(page).click();
      await page.getByText('Only workspace admins can rename or close this workspace.', { exact: true }).waitFor();
      assert.equal(await saveName(page).count(), 0);
      assert.equal(await page.getByRole('textbox', { name: 'Workspace name', exact: true }).count(), 0);
      assert.equal(await page.locator('#workspace-name-help').count(), 0);
      assert.equal(
        await page
          .locator('p')
          .filter({ hasText: /^Acme$/ })
          .innerText(),
        'Acme',
      );
      f.role = 'admin';
      await workspaceChange(page, workspaceId, f.userId, [['governance', 'membership'], ['settings']]);
      await saveName(page).waitFor();
      assert.equal(await page.getByLabel('Workspace name', { exact: true }).inputValue(), 'Rejected draft');
      assert.equal(f.receipts.size, 0);
      assert.equal(
        await page.evaluate(
          () => Object.keys(sessionStorage).filter(key => key.startsWith('tulipfarm.pending-command.')).length,
        ),
        0,
      );
    });
    await scenario('last admin cannot leave; member leave uses existing governance service', async (page, f) => {
      f.canLeave = false;
      await general(page);
      await page.getByText(/You are the last admin/).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Leave workspace', exact: true }).isDisabled(), true);
      f.canLeave = true;
      f.role = 'member';
      await workspaceChange(page, workspaceId, f.userId, [['governance', 'membership'], ['settings']]);
      await eventually(() => page.getByRole('button', { name: 'Leave workspace', exact: true }).isEnabled(), true);
      await page.getByRole('button', { name: 'Leave workspace', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm leave workspace', exact: true }).click();
      await page.waitForURL('**/create-workspace');
      assert.equal(f.writes[0].path, `${base}/governance/leave`);
    });
    for (const lost of [false, true])
      await scenario(
        `deletion exact name and retained-data acknowledgment${lost ? ' with lost response receipt recovery' : ''}`,
        async (page, f) => {
          await general(page);
          await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
          const dialog = page.getByRole('dialog');
          await dialog.getByText(/Rows, files, and backups are retained/).waitFor();
          const remove = dialog.getByRole('button', { name: 'Close workspace for everyone' });
          await dialog.getByLabel('Type the exact workspace name').fill('acme');
          await dialog
            .getByRole('checkbox', { name: 'I understand that workspace data is retained, not erased.' })
            .check();
          assert.equal(await remove.isDisabled(), true);
          await dialog.getByLabel('Type the exact workspace name').fill('Acme');
          if (lost) f.nextWrite = 'lose-committed';
          await remove.click();
          if (lost) {
            await page.getByText(/We could not confirm your change/).waitFor();
            await page.getByRole('button', { name: 'Check command status' }).click();
          }
          await page.waitForURL('**/create-workspace');
          assert.equal(f.writes.length, 1);
          assert.deepEqual(f.writes[0].input, {
            requestId: f.writes[0].input.requestId,
            expectedRevision: 0,
            confirmationName: 'Acme',
            acknowledgeRetainedData: true,
          });
        },
      );
    await scenario('model disable hides platform-unavailable families, all-disabled and re-enable', async (page, f) => {
      await models(page);
      assert.equal(await page.getByRole('row', { name: 'Platform family', exact: true }).count(), 0);
      assert.equal(await page.getByText(/Platform family|Platform unavailable/).count(), 0);
      await page.getByRole('switch', { name: 'Allow Primary family', checked: true }).click();
      await page.getByText('Model access saved.', { exact: true }).waitFor();
      await page.getByRole('switch', { name: 'Allow Primary family', checked: false }).waitFor();
      await page.getByText(/All model families are disabled/).waitFor();
      await page.getByRole('switch', { name: 'Allow Primary family', checked: false }).click();
      await eventually(
        () => page.getByRole('switch', { name: 'Allow Primary family', checked: true }).isEnabled(),
        true,
      );
      assert.equal(f.writes.length, 2);
      assert.deepEqual(
        f.writes.map(write => write.input.enabled),
        [false, true],
      );
    });
    await scenario('model conflict requires review and a new revision; demotion removes controls', async (page, f) => {
      await models(page);
      f.models[0].revision = 3;
      await page.getByRole('switch', { name: 'Allow Primary family', checked: true }).click();
      await page.getByText(/Another admin changed model access/).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Apply retained change' }).isDisabled(), true);
      await notifyChange(page, workspaceId, f.userId, 'models');
      await eventually(() => page.getByRole('button', { name: 'Apply retained change' }).isEnabled(), true);
      await page.getByRole('button', { name: 'Apply retained change' }).click();
      await page.getByText('Model access saved.', { exact: true }).waitFor();
      assert.equal(f.writes[1].input.expectedRevision, 3);
      f.role = 'member';
      await notifyChange(page, workspaceId, f.userId, 'models');
      await page.getByText(/You have read-only access/).waitFor();
      assert.equal(await page.getByRole('switch', { name: 'Allow Primary family', checked: false }).count(), 0);
    });
    await scenario('model access failure retries into an honest empty state', async (page, f) => {
      f.modelStatus = 503;
      await page.goto(`${origin}/acme/settings/models`);
      await page.getByRole('heading', { name: 'Could not load model access', exact: true }).waitFor();
      assert.equal(
        await page.getByRole('heading', { name: 'No model access policies listed', exact: true }).count(),
        0,
      );
      f.modelStatus = 200;
      f.models = [];
      await page.getByRole('button', { name: 'Reload model access', exact: true }).click();
      await page.getByRole('heading', { name: 'No model access policies listed', exact: true }).waitFor();
      f.models = [{ familyId: 'primary', enabled: true, revision: 0 }];
      await notifyChange(page, workspaceId, f.userId, 'models');
      await page.getByRole('switch', { name: 'Allow Primary family', checked: true }).waitFor();
      assert.equal(f.writes.length, 0);
    });
    for (const committed of [true, false])
      await scenario(
        `model availability lost ${committed ? 'committed' : 'uncommitted'} response recovery`,
        async (page, f) => {
          await models(page);
          f.nextWrite = committed ? 'lose-committed' : 'lose-uncommitted';
          await page.getByRole('switch', { name: 'Allow Primary family', checked: true }).click();
          await page.getByText(/We could not confirm your change/).waitFor();
          await page.getByRole('button', { name: 'Check command status' }).click();
          if (!committed) {
            await page.getByText(/No saved result is visible/).waitFor();
            await page.getByRole('button', { name: 'Retry same request' }).click();
          }
          await page.getByText('Model access saved.', { exact: true }).waitFor();
          await page.getByRole('switch', { name: 'Allow Primary family', checked: false }).waitFor();
          assert.equal(f.writes.length, committed ? 1 : 2);
          if (!committed) assert.deepEqual(f.writes[0], f.writes[1]);
        },
      );
    for (const denied of ['demotion', 'list', 'catalog'])
      await scenario(`lost model response stays recoverable after ${denied}`, async (page, f) => {
        await models(page);
        f.nextWrite = 'lose-committed';
        await page.getByRole('switch', { name: 'Allow Primary family', checked: true }).click();
        await page.getByText(/We could not confirm your change/).waitFor();
        f.role = 'member';
        if (denied === 'list') f.modelStatus = 403;
        if (denied === 'catalog') f.catalogStatus = 403;
        await notifyChange(page, workspaceId, f.userId, 'models');
        if (denied === 'catalog')
          await page.getByRole('heading', { name: 'workspace models unavailable', exact: true }).waitFor();
        else if (denied === 'list')
          await page.getByRole('heading', { name: 'model access unavailable', exact: true }).waitFor();
        else await page.getByText(/You have read-only access/).waitFor();
        await page.getByRole('button', { name: 'Check command status' }).click();
        await page.getByText('Model access saved.', { exact: true }).waitFor();
        assert.equal(f.writes.length, 1);
        assert.equal(await page.getByRole('switch', { name: 'Allow Primary family', checked: false }).count(), 0);
      });
    for (const kind of ['rename', 'availability'])
      await scenario(`${kind} reload restores lookup without replaying writes`, async (page, f) => {
        f.nextWrite = 'lose-committed';
        if (kind === 'rename') {
          await general(page);
          await page.getByLabel('Workspace name', { exact: true }).fill('Recovered name');
          await saveName(page).click();
        } else {
          await models(page);
          await page.getByRole('switch', { name: 'Allow Primary family', checked: true }).click();
        }
        await page.getByText(/We could not confirm your change/).waitFor();
        page.on('dialog', dialog => dialog.accept());
        await page.reload();
        await page.getByRole('button', { name: 'Check command status' }).click();
        await page
          .getByText(kind === 'rename' ? 'Workspace name saved.' : 'Model access saved.', { exact: true })
          .waitFor();
        assert.equal(f.writes.length, 1);
        assert.equal(
          await page.evaluate(
            () => Object.keys(sessionStorage).filter(key => key.startsWith('tulipfarm.pending-command.')).length,
          ),
          0,
        );
      });
    await scenario(
      'lost deletion survives reload of missing workspace and confirms outside workspace',
      async (page, f) => {
        await general(page);
        await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('Type the exact workspace name').fill('Acme');
        await dialog.getByRole('checkbox').check();
        f.nextWrite = 'lose-committed';
        await dialog.getByRole('button', { name: 'Close workspace for everyone' }).click();
        await page.getByText(/We could not confirm your change/).waitFor();
        page.on('dialog', dialog => dialog.accept());
        await page.reload();
        await page.getByRole('link', { name: 'Recover workspace changes', exact: true }).first().click();
        await page.getByRole('button', { name: 'Check command status' }).click();
        await page.getByText('Workspace closed. Rows, files, and backups are retained.', { exact: true }).waitFor();
        assert.equal(f.writes.length, 1);
        await page.reload();
        await page.getByRole('heading', { name: 'No unconfirmed changes', exact: true }).waitFor();
      },
    );
    await scenario('login navigation preserves recovery without exposing another account commands', async (page, f) => {
      await general(page);
      await page.getByLabel('Workspace name', { exact: true }).fill('Private command');
      f.nextWrite = 'lose-committed';
      await saveName(page).click();
      await page.getByText(/We could not confirm your change/).waitFor();
      page.on('dialog', dialog => dialog.accept());
      f.userId = null;
      await page.goto(`${origin}/account/workspace-recovery`);
      await page.waitForURL('**/login?**');
      f.userId = 'other';
      await page.goto(`${origin}/account/workspace-recovery`);
      await page.getByRole('heading', { name: 'No unconfirmed changes', exact: true }).waitFor();
      assert.equal(await page.getByText('Private command', { exact: true }).count(), 0);
      f.userId = 'ada';
      await page.reload();
      await page.getByRole('button', { name: 'Check command status' }).click();
      await page.getByText('Workspace name saved.', { exact: true }).waitFor();
      assert.equal(f.writes.length, 1);
    });
    await scenario('reload during submission retains the command before a response exists', async (page, f) => {
      await general(page);
      await page.getByLabel('Workspace name', { exact: true }).fill('In flight');
      f.writeGate = gate();
      await saveName(page).click();
      await eventually(() => f.writes.length, 1);
      const pending = await page.evaluate(() =>
        Object.keys(sessionStorage)
          .filter(key => key.startsWith('tulipfarm.pending-command.'))
          .map(key => JSON.parse(sessionStorage.getItem(key))),
      );
      assert.equal(pending.length, 1);
      assert.equal(pending[0].userId, 'ada');
      assert.equal(pending[0].workspaceId, workspaceId);
      assert.deepEqual(pending[0].command, { kind: 'rename', ...f.writes[0].input });
      await page.reload();
      await page.getByRole('button', { name: 'Check command status' }).waitFor();
      assert.equal(f.writes.length, 1);
      f.writeGate.release();
      await eventually(() => f.receipts.size, 1);
      await page.getByRole('button', { name: 'Check command status' }).click();
      await page.getByText('Workspace name saved.', { exact: true }).waitFor();
      assert.equal(f.writes.length, 1);
    });
    await scenario('uncommitted reload retries only deliberately with the identical request', async (page, f) => {
      await models(page);
      f.nextWrite = 'lose-uncommitted';
      await page.getByRole('switch', { name: 'Allow Primary family', checked: true }).click();
      await page.getByText(/We could not confirm your change/).waitFor();
      await page.reload();
      await page.getByRole('button', { name: 'Check command status' }).click();
      await page.getByText(/No saved result is visible/).waitFor();
      assert.equal(f.writes.length, 1);
      f.role = 'member';
      await notifyChange(page, workspaceId, f.userId, 'models');
      await page.getByText(/You have read-only access/).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Retry same request' }).isDisabled(), true);
      f.role = 'admin';
      await notifyChange(page, workspaceId, f.userId, 'models');
      await eventually(() => page.getByRole('button', { name: 'Retry same request' }).isEnabled(), true);
      await page.getByRole('button', { name: 'Retry same request' }).click();
      await page.getByText('Model access saved.', { exact: true }).waitFor();
      assert.deepEqual(f.writes[1], f.writes[0]);
    });
    await scenario('mismatched receipt cannot resolve the persisted command', async (page, f) => {
      await general(page);
      await page.getByLabel('Workspace name', { exact: true }).fill('Exact name');
      f.nextWrite = 'lose-committed';
      await saveName(page).click();
      await page.getByText(/We could not confirm your change/).waitFor();
      const requestId = f.writes[0].input.requestId;
      const receipt = f.receipts.get(requestId);
      f.receipts.set(requestId, { ...receipt, name: 'Wrong name' });
      await page.reload();
      await page.getByRole('button', { name: 'Check command status' }).click();
      await page.getByText(/Could not check whether your change was saved/).waitFor();
      assert.equal(await page.getByText('Workspace name saved.', { exact: true }).count(), 0);
      f.receipts.set(requestId, receipt);
      await page.reload();
      await page.getByRole('button', { name: 'Check command status' }).click();
      await page.getByText('Workspace name saved.', { exact: true }).waitFor();
      assert.equal(f.writes.length, 1);
    });
    await scenario('denied catalog after reload does not hide restored model recovery', async (page, f) => {
      await models(page);
      f.nextWrite = 'lose-committed';
      await page.getByRole('switch', { name: 'Allow Primary family', checked: true }).click();
      await page.getByText(/We could not confirm your change/).waitFor();
      f.catalogStatus = 403;
      f.role = 'member';
      await page.reload();
      await page.getByRole('button', { name: 'Check command status' }).waitFor();
      await notifyChange(page, workspaceId, f.userId, 'catalog');
      await page.getByRole('heading', { name: 'workspace models unavailable', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Check command status' }).click();
      await page.getByText('Model access saved.', { exact: true }).waitFor();
      assert.equal(f.writes.length, 1);
    });
    await scenario('storage unavailable prevents submission rather than losing recovery', async (page, f) => {
      await page.addInitScript(() => {
        Storage.prototype.setItem = () => {
          throw new DOMException('Blocked', 'SecurityError');
        };
      });
      await general(page);
      await page.getByLabel('Workspace name', { exact: true }).fill('Not sent');
      await saveName(page).click();
      await page.getByText(/No request was sent/).waitFor();
      assert.equal(f.writes.length, 0);
      assert.equal(await page.getByLabel('Workspace name', { exact: true }).inputValue(), 'Not sent');
    });
    for (const kind of ['rename', 'availability'])
      await scenario(`restored ${kind} conflict retains intended change for deliberate rebase`, async (page, f) => {
        f.nextWrite = 'lose-uncommitted';
        if (kind === 'rename') {
          await general(page);
          await page.getByLabel('Workspace name', { exact: true }).fill('Retained intent');
          await saveName(page).click();
        } else {
          await models(page);
          await page.getByRole('switch', { name: 'Allow Primary family', checked: true }).click();
        }
        await page.getByText(/We could not confirm your change/).waitFor();
        await page.reload();
        await page.getByRole('button', { name: 'Check command status' }).click();
        await page.getByText(/No saved result is visible/).waitFor();
        if (kind === 'rename') {
          f.revision = 3;
          f.name = 'Concurrent rename';
        } else f.models[0].revision = 3;
        await page.getByRole('button', { name: 'Retry same request' }).click();
        if (kind === 'rename') {
          await page.getByRole('button', { name: 'Reload latest settings' }).click();
          await eventually(() => saveName(page).isEnabled(), true);
          assert.equal(await page.getByLabel('Workspace name', { exact: true }).inputValue(), 'Retained intent');
          await saveName(page).click();
          await page.getByText('Workspace name saved.', { exact: true }).waitFor();
        } else {
          await page.getByText('Requested change: disable Primary family.', { exact: true }).waitFor();
          await notifyChange(page, workspaceId, f.userId, 'models');
          await eventually(() => page.getByRole('button', { name: 'Apply retained change' }).isEnabled(), true);
          await page.getByRole('button', { name: 'Apply retained change' }).click();
          await page.getByText('Model access saved.', { exact: true }).waitFor();
        }
        assert.equal(f.writes.length, 3);
        assert.equal(f.writes[2].input.expectedRevision, 3);
        assert.notEqual(f.writes[0].input.requestId, f.writes[2].input.requestId);
      });
    for (const theme of ['light', 'dark'])
      await scenario(
        `mobile ${theme}, keyboard rename and reduced motion`,
        async (page, f) => {
          await page.addInitScript(theme => localStorage.setItem('tulipfarm.theme', theme), theme);
          await general(page);
          const input = page.getByLabel('Workspace name', { exact: true });
          await input.fill('Keyboard workspace');
          await input.focus();
          await page.keyboard.press('Tab');
          assert.equal(await saveName(page).evaluate(element => element === document.activeElement), true);
          await page.keyboard.press('Enter');
          await page.getByText('Workspace name saved.', { exact: true }).waitFor();
          assert.equal(f.writes.length, 1);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          assert.equal(
            await page
              .locator('[data-slot="page-content"]')
              .locator('..')
              .evaluate(element => element.scrollWidth <= element.clientWidth + 1),
            true,
          );
          assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
          if (process.env.SETTINGS_SCREENSHOTS)
            await page.screenshot({
              path: `${process.env.SETTINGS_SCREENSHOTS}/settings-${theme}.png`,
              fullPage: true,
            });
          await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click();
          await page.getByRole('link', { name: 'Models', exact: true }).click();
          await page.getByRole('switch', { name: 'Allow Primary family', checked: true }).waitFor();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          if (process.env.SETTINGS_SCREENSHOTS)
            await page.screenshot({ path: `${process.env.SETTINGS_SCREENSHOTS}/models-${theme}.png`, fullPage: true });
        },
        {
          viewport: { width: 390, height: 844 },
          colorScheme: theme,
          reducedMotion: 'reduce',
          isMobile: true,
          hasTouch: true,
        },
      );
    t.diagnostic(
      'Runs the actual Vite UI with a local HTTP fixture. Backend persistence, authorization and runtime model enforcement require integration proofs.',
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
