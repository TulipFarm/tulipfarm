import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { catalogFixture } from '../src/features/models/catalog-fixture.ts';
import { membership, credits } from './chat-query.fixture.mjs';

const port = Number(process.env.AGENT_REVISION_BROWSER_PORT ?? 5288);
const origin = `http://127.0.0.1:${port}`;
const id = '33333333-3333-4333-8333-333333333333';
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Acme',
  slug: 'acme',
  status: 'ready',
  createdAt: '2026-10-12T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
const scope = [{ assetId: '55555555-5555-4555-8555-555555555555', permissions: ['table.row.read'] }];

function fixture() {
  const definition = {
    name: 'Handbook helper',
    instructions: 'Answer handbook questions.',
    tools: [],
    responseRule: 'tag',
  };
  return {
    detail: {
      id,
      name: definition.name,
      definition,
      owningTeamId: null,
      savedRevision: 'a'.repeat(40),
      definitionRevision: 'b'.repeat(64),
      capabilities: ['read', 'edit', 'invoke', 'manage'],
      activations: [{ id: randomUUID(), revision: 'b'.repeat(64), scope }],
    },
    policy: {
      version: 1,
      owningTeamId: null,
      grants: [],
      personGrants: [],
      enrollment: [],
      enabled: true,
      limits: [...scope, { assetId: '66666666-6666-4666-8666-666666666666', permissions: ['table.row.update'] }],
      taskLimits: { toolCalls: 25, activeMilliseconds: 60000, credits: 20 },
      slackSender: 'user',
    },
    commands: new Map(),
    writes: [],
    polls: 0,
    saveStatus: 'accepted',
    queued: false,
    loseActivation: false,
    newerBeforeActivation: false,
    accepted: false,
  };
}

test('existing-agent instructions save and activation in the real app', { timeout: 240_000 }, async t => {
  const vite = spawn(
    process.execPath,
    [
      new URL('../node_modules/vite/bin/vite.js', import.meta.url).pathname,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: new URL('..', import.meta.url),
      stdio: 'ignore',
    },
  );
  let browser;
  try {
    for (let attempt = 0; ; attempt++) {
      if (vite.exitCode !== null) throw new Error('Vite exited before it became ready');
      try {
        if ((await fetch(origin)).ok) break;
      } catch {}
      if (attempt === 100) throw new Error('Vite did not start');
      await delay(100);
    }
    browser = await chromium.launch({
      args: process.env.AGENT_REVISION_SCREENSHOT ? ['--remote-debugging-port=9298'] : [],
    });
    let activeContext;
    async function open(state, tab = 'instructions') {
      await activeContext?.close();
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      activeContext = context;
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/v1/**', async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const method = request.method();
        let json;
        let status = 200;
        if (method === 'PUT' && path.endsWith(`/agents/${id}`)) {
          const input = request.postDataJSON();
          state.writes.push({ kind: 'save', input });
          assert.equal(input.expectedSavedRevision, state.detail.savedRevision);
          const command = {
            commandId: randomUUID(),
            agentId: id,
            status: state.queued ? 'preparing' : state.saveStatus,
            savedRevision: state.saveStatus === 'accepted' ? 'c'.repeat(40) : null,
          };
          state.commands.set(command.commandId, { command, input });
          json = command;
        } else if (method === 'GET' && path.includes('/agents/commands/')) {
          const { command, input } = state.commands.get(path.split('/').at(-1));
          state.polls++;
          const accepted = state.saveStatus === 'accepted' && (!state.queued || state.polls > 1);
          if (accepted) {
            command.status = 'accepted';
            state.detail = {
              ...state.detail,
              name: input.definition.name,
              definition: input.definition,
              savedRevision: command.savedRevision,
              definitionRevision: 'd'.repeat(64),
            };
            state.accepted = true;
          }
          json = command;
        } else if (method === 'POST' && path.endsWith(`/agents/${id}/activations/replace`)) {
          const input = request.postDataJSON();
          state.writes.push({ kind: 'activate', input });
          assert.equal(state.accepted || state.commands.size === 0, true);
          assert.equal(input.revision, state.detail.definitionRevision);
          assert.deepEqual(input.expectedActivationIds.sort(), state.detail.activations.map(item => item.id).sort());
          assert.equal(input.expectedSavedRevision, state.detail.savedRevision);
          state.detail.activations = state.detail.activations.map((activation, index) => ({
            ...activation,
            id: index === 0 ? input.requestId : randomUUID(),
            revision: input.revision,
          }));
          if (state.loseActivation) {
            state.loseActivation = false;
            await route.abort('failed');
            return;
          }
          json = { activationId: input.requestId };
        } else if (method === 'DELETE' && path.includes(`/agents/${id}/activations/`)) {
          const activationId = path.split('/').at(-1);
          state.writes.push({ kind: 'revoke', activationId });
          state.detail.replacedActivations = state.detail.replacedActivations.filter(
            activation => activation.id !== activationId,
          );
          json = { saved: true };
        } else if (path.endsWith('/auth/get-session'))
          json = {
            session: { id: 'demo', userId: 'owner' },
            user: { id: 'owner', name: 'Demo author', email: 'owner@example.test' },
          };
        else if (path === '/v1/workspaces') json = [workspace];
        else if (path === '/v1/workspaces/acme') json = workspace;
        else if (path.endsWith('/governance/me')) json = membership;
        else if (path.endsWith('/authoring-context'))
          json = {
            currentSoulRevision: state.detail.savedRevision,
            teams: [],
            builtinSkills: [],
          };
        else if (path.endsWith(`/agents/${id}`)) {
          if (state.accepted && state.newerBeforeActivation)
            state.detail = { ...state.detail, savedRevision: 'e'.repeat(40), definitionRevision: 'f'.repeat(64) };
          json = state.detail;
        } else if (path.endsWith(`/agents/${id}/policy`)) json = state.policy;
        else if (path.endsWith('/model-catalog')) json = catalogFixture();
        else if (path.endsWith('/skills')) json = { workspace: [], nextCursor: null };
        else if (path.endsWith('/agents')) json = { agents: [state.detail], nextCursor: null };
        else if (path.endsWith('/tables')) json = { tables: [], nextCursor: null };
        else if (path.includes('/tables/55555555-5555-4555-8555-555555555555'))
          json = { id: scope[0].assetId, name: 'Handbook', appliedRevision: 'a'.repeat(40), desiredRevision: null };
        else if (path.endsWith('/sharing-candidates'))
          json = { membershipId: membership.membershipId, people: [], teams: [] };
        else if (path.endsWith('/workspace-mcp/capabilities')) json = { enabled: false };
        else if (path.endsWith('/credits')) json = credits;
        else if (path.endsWith('/feature-flags')) json = {};
        else if (path.endsWith('/bud'))
          json = {
            conversationId: null,
            onboarding: 'ineligible',
            bubblesEnabled: false,
            snoozedUntil: null,
            nudge: null,
            preferences: [],
          };
        else {
          status = 404;
          json = { error: 'unavailable' };
        }
        await route.fulfill({ status, json });
      });
      await page.goto(`${origin}/acme/agents/${id}?tab=${tab}`);
      if (tab === 'instructions') await page.getByRole('textbox', { name: 'Instructions', exact: true }).waitFor();
      return { page, errors };
    }
    const instructions = page => page.getByRole('textbox', { name: 'Instructions', exact: true });
    const save = page =>
      page.locator('#agent-definition-form').getByRole('button', { name: 'Save and activate', exact: true });
    const live = page =>
      page.getByText('Saved and activated. Handbook helper now uses these instructions.', { exact: true });

    await t.test('open Instructions, edit, save and activate: no tab change or extra confirmation', async () => {
      const state = fixture();
      const { page, errors } = await open(state, 'overview');
      await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
      await instructions(page).fill('Answer with the latest handbook instructions.');
      await save(page).click();
      await live(page).waitFor();
      assert.deepEqual(
        state.writes.map(write => write.kind),
        ['save', 'activate'],
      );
      assert.deepEqual(state.writes[1].input.scope, scope);
      assert.match(page.url(), /tab=instructions/);
      assert.equal(await page.getByRole('alertdialog').count(), 0);
      assert.equal(await page.locator('#agent-definition-form [role="status"]').count(), 1);
      assert.deepEqual(errors, []);
      if (process.env.AGENT_REVISION_SCREENSHOT) {
        await live(page).scrollIntoViewIfNeeded();
        execFileSync('agent-browser', ['--cdp', '9298', 'screenshot', '/tmp/agent-revision-after.png']);
        await page.setViewportSize({ width: 390, height: 844 });
        await live(page).scrollIntoViewIfNeeded();
        await page.screenshot({ path: '/tmp/agent-revision-mobile.png' });
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.screenshot({ path: '/tmp/agent-revision-dark.png' });
      }
    });

    await t.test('draft save leaves the active version unchanged and places Activate beside its hint', async () => {
      const state = fixture();
      const { page } = await open(state);
      await instructions(page).fill('A draft revision.');
      await page.getByRole('button', { name: 'Save without activating', exact: true }).click();
      await page
        .getByText('This saved version is not active yet. Runs still use the earlier version.', { exact: true })
        .waitFor();
      assert.deepEqual(
        state.writes.map(write => write.kind),
        ['save'],
      );
      await page.getByRole('button', { name: 'Activate saved instructions', exact: true }).click();
      await page.getByRole('alertdialog').waitFor();
      await page.getByRole('button', { name: 'Activate this version', exact: true }).click();
      await live(page).waitFor();
      assert.deepEqual(
        state.writes.map(write => write.kind),
        ['save', 'activate'],
      );
    });

    await t.test('new actions require review in place; cancel keeps edits and makes no writes', async () => {
      const state = fixture();
      const { page } = await open(state);
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('button', { name: 'Knowledge and web', exact: false }).click();
      await page.getByRole('checkbox', { name: 'Read a web page', exact: false }).check();
      await save(page).click();
      const dialog = page.getByRole('alertdialog');
      await dialog.waitFor();
      await dialog.getByText('Permitted actions: Read a web page', { exact: true }).waitFor();
      assert.deepEqual(state.writes, []);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await save(page).evaluate(button => document.activeElement === button), true);
      assert.equal(await page.getByRole('button', { name: 'Remove Read a web page', exact: true }).count(), 1);
      await save(page).click();
      await dialog.getByRole('button', { name: 'Save and activate', exact: true }).click();
      await live(page).waitFor();
      assert.deepEqual(state.writes[0].input.definition.tools, ['web.fetch']);
      assert.deepEqual(state.writes[1].input.scope, scope);
      assert.match(page.url(), /tab=instructions/);
    });

    await t.test('queued saves are accepted before activation', async () => {
      const state = fixture();
      state.queued = true;
      const { page } = await open(state);
      await instructions(page).fill('Queued instructions.');
      await save(page).click();
      await live(page).waitFor();
      assert.ok(state.polls > 1);
      assert.deepEqual(
        state.writes.map(write => write.kind),
        ['save', 'activate'],
      );
    });

    await t.test('review lists every scope and replaced running activations remain revocable', async () => {
      const state = fixture();
      state.detail.activations.push({ id: randomUUID(), revision: state.detail.definitionRevision, scope: [] });
      const replacedId = randomUUID();
      state.detail.replacedActivations = [{ id: replacedId, revision: '0'.repeat(64), scope }];
      const { page } = await open(state);
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('button', { name: 'Knowledge and web', exact: false }).click();
      await page.getByRole('checkbox', { name: 'Read a web page', exact: false }).check();
      await save(page).click();
      const dialog = page.getByRole('alertdialog');
      await dialog.getByText('read rows', { exact: false }).waitFor();
      await dialog.getByText('No table access', { exact: true }).waitFor();
      assert.equal(await dialog.locator('li').count(), 2);
      if (process.env.AGENT_REVISION_SCREENSHOT) await page.screenshot({ path: '/tmp/agent-revision-scopes.png' });
      await dialog.getByRole('button', { name: 'Save and activate', exact: true }).click();
      await live(page).waitFor();
      assert.equal(state.detail.activations.length, 2);
      await page.getByRole('tab', { name: 'Execution', exact: true }).click();
      const replaced = page.getByText('Replaced. Running tasks may still use it.', { exact: true });
      await replaced.waitFor();
      if (process.env.AGENT_REVISION_SCREENSHOT) {
        await replaced.scrollIntoViewIfNeeded();
        await page.screenshot({ path: '/tmp/agent-revision-replaced.png' });
      }
      await replaced.locator('..').getByRole('button', { name: 'Revoke activation', exact: true }).click();
      await page.getByText('Activation revoked.', { exact: true }).waitFor();
      assert.equal(state.writes.at(-1).activationId, replacedId);
    });

    await t.test('an inactive saved version is reviewed even when only its instructions change', async () => {
      const state = fixture();
      state.detail.definition.tools = ['web.fetch'];
      state.detail.definitionRevision = 'f'.repeat(64);
      const { page } = await open(state);
      await instructions(page).fill('Use the newly saved actions.');
      await save(page).click();
      const dialog = page.getByRole('alertdialog');
      await dialog.getByText('Permitted actions: Read a web page', { exact: true }).waitFor();
      assert.deepEqual(state.writes, []);
      await dialog.getByRole('button', { name: 'Save and activate', exact: true }).click();
      await live(page).waitFor();
    });

    await t.test('a save conflict never activates', async () => {
      const state = fixture();
      state.saveStatus = 'conflict';
      const { page } = await open(state);
      await instructions(page).fill('Conflicting instructions.');
      await save(page).click();
      await page
        .getByText('Another save finished first. Your input is retained. Refresh the definition before trying again.', {
          exact: true,
        })
        .waitFor();
      assert.deepEqual(
        state.writes.map(write => write.kind),
        ['save'],
      );
      assert.equal(await instructions(page).inputValue(), 'Conflicting instructions.');
    });

    await t.test('a newer revision cannot be activated by an earlier save', async () => {
      const state = fixture();
      state.newerBeforeActivation = true;
      const { page } = await open(state);
      await instructions(page).fill('My instructions.');
      await save(page).click();
      await page.getByText('A newer version was saved. Review it before activating.', { exact: true }).waitFor();
      assert.deepEqual(
        state.writes.map(write => write.kind),
        ['save'],
      );
      assert.equal(await live(page).count(), 0);
    });

    await t.test('an unconfirmed activation is recovered without a second write', async () => {
      const state = fixture();
      state.loseActivation = true;
      const { page } = await open(state);
      await instructions(page).fill('Instructions with a lost activation response.');
      await save(page).click();
      await page
        .getByText('Could not confirm activation. Check status before activating again.', { exact: true })
        .first()
        .waitFor();
      assert.equal(await live(page).count(), 0);
      await page.getByRole('button', { name: 'Check activation status', exact: true }).click();
      await live(page).waitFor();
      assert.deepEqual(
        state.writes.map(write => write.kind),
        ['save', 'activate'],
      );
    });

    await t.test('editors without manage permission can save, but cannot activate', async () => {
      const state = fixture();
      state.detail.capabilities = ['read', 'edit'];
      const { page } = await open(state);
      assert.equal(await save(page).count(), 0);
      await instructions(page).fill('Editor draft.');
      await page.getByRole('button', { name: 'Save agent', exact: true }).click();
      await page.getByText('A manager needs to activate this version.', { exact: true }).first().waitFor();
      assert.equal(await page.getByRole('button', { name: 'Activate saved instructions', exact: true }).count(), 0);
      assert.deepEqual(
        state.writes.map(write => write.kind),
        ['save'],
      );
    });
  } finally {
    await browser?.close();
    if (vite.exitCode === null && vite.signalCode === null) {
      const stopped = once(vite, 'exit');
      vite.kill('SIGTERM');
      await stopped;
    }
  }
});
