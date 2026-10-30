import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { systemPackageInstallationSchema } from '../../../packages/agents/src/system-package-contracts.ts';
import { packageInstallationLayout } from '../../../packages/conversations/src/layout-contracts.ts';
import { fallbackRecommendations } from '../../../packages/recommendations/src/rules.ts';
import { captureBrowserFailure, startBuiltApp } from './built-app.fixture.mjs';
import { createWorkspaceFixture, workspaceShellReads, serveWorkspaceShellEvent } from './workspace.fixture.mjs';

async function packageFixture(browser, { legacy = false } = {}) {
  const { workspace, session } = createWorkspaceFixture({ slug: 'packages-qa', name: 'Packages QA' });
  const teamId = randomUUID();
  const membershipId = randomUUID();
  const pkg = JSON.parse(
    await readFile(
      new URL('../../../packages/config/examples/system-packages/leave-management.json', import.meta.url),
      'utf8',
    ),
  );
  const assets = structuredClone(pkg.assets);
  assets[1].encoding = 'base64';
  assets[1].content = Buffer.from(assets[1].content).toString('base64');
  if (legacy) {
    assets[0].content += `\n${'Exact procedure line. '.repeat(1200)}END OF EXACT PACKAGE FILE`;
    assets[0].size = Buffer.byteLength(assets[0].content);
    assets[0].sha256 = createHash('sha256').update(assets[0].content).digest('hex');
  }
  const installation = systemPackageInstallationSchema.parse({
    id: randomUUID(),
    workspaceId: workspace.id,
    chatId: legacy ? randomUUID() : null,
    package: pkg.package,
    packageDigest: 'a'.repeat(64),
    inputDigest: 'b'.repeat(64),
    bindings: {
      'owning-team': { kind: 'team', id: teamId },
      'package-manager': { kind: 'member', id: membershipId },
    },
    packageApproved: !legacy,
    assets,
    version: 1,
    status: legacy ? 'waiting-review' : 'running',
    nodes: [
      ...pkg.resources.map(resource => ({
        key: resource.key,
        kind: resource.kind,
        title: resource.key,
        dependsOn: [],
        state: resource.kind === 'skill' ? (legacy ? 'waiting-review' : 'running') : 'completed',
        attempt: resource.kind === 'skill' ? 1 : 0,
        resourceId: randomUUID(),
        revision: '1',
        error: null,
        review: { digest: 'c'.repeat(64), description: 'Saved resource review.', href: null },
        definition: resource,
      })),
      {
        key: '$verify',
        kind: 'verify',
        title: 'Verify every installed resource',
        dependsOn: pkg.resources.map(resource => resource.key),
        state: 'pending',
        resourceId: null,
        revision: null,
        error: null,
        review: null,
        definition: null,
      },
    ],
    createdAt: workspace.createdAt,
    updatedAt: workspace.createdAt,
  });
  const chatRecord = id => ({
    id,
    title: pkg.package.title,
    titleRevision: 1,
    archived: false,
    activityAt: workspace.createdAt,
    createdAt: workspace.createdAt,
  });
  const state = {
    chat: legacy ? chatRecord(installation.chatId) : null,
    saved: legacy,
    failRead: false,
    imports: [],
    approvals: [],
    reviews: [],
    validations: [],
    chatCreates: [],
    sends: [],
    messages: [],
    errors: [],
    unexpected: [],
  };
  const packageUrl = `https://packages.tulipfarm.ai/packages/${pkg.package.name}/${pkg.package.version}/package.json`;
  function saveMessages(id, parts) {
    const turn = { id: randomUUID(), status: 'completed', generation: 0 };
    const responseId = randomUUID();
    const layout = packageInstallationLayout(
      { name: pkg.package.name, version: pkg.package.version, url: packageUrl },
      responseId,
    );
    const human = {
      id,
      sequence: 1,
      author: 'human',
      createdAt: workspace.createdAt,
      parts,
      turn,
      tools: [],
      calendarResults: [],
    };
    state.messages.push(human, {
      ...human,
      id: responseId,
      sequence: 2,
      author: 'assistant',
      parts: [{ kind: 'layout', text: layout.summary, layout }],
    });
    return human;
  }
  if (legacy) saveMessages(randomUUID(), [{ kind: 'text', text: `Help me install ${packageUrl}` }]);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => state.errors.push(String(error)));
  page.on('dialog', dialog => dialog.accept());
  await context.route('https://packages.tulipfarm.ai/**', route =>
    route.fulfill({
      json:
        new URL(route.request().url()).pathname === '/catalog.json'
          ? {
              schema: 'https://tulipfarm.ai/schemas/system-package.v1.json',
              packages: [
                {
                  ...pkg.package,
                  category: 'People',
                  tags: ['leave'],
                  url: packageUrl,
                  page: packageUrl.replace('package.json', ''),
                },
              ],
            }
          : pkg,
    }),
  );
  const shell = new Map(workspaceShellReads(workspace.id));
  const history = () => ({ messages: state.messages, nextBefore: null, hasGitHubProposals: false });
  await context.route('**/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (await serveWorkspaceShellEvent(route, workspace)) return;
    if (shell.has(path)) return route.fulfill({ json: shell.get(path) });
    if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
    if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
    if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
    if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
    if (path.endsWith('/model-catalog'))
      return route.fulfill({ status: 503, json: { error: 'model-catalog-unavailable' } });
    if (path.endsWith('/projects')) return route.fulfill({ json: [] });
    if (path.endsWith('/google-workspace/availability')) return route.fulfill({ json: { configured: false } });
    if (path.endsWith('/google-workspace')) return route.fulfill({ json: { status: 'disconnected' } });
    if (path.endsWith('/google-workspace/operations/proposals'))
      return route.fulfill({ json: { proposals: [], nextCursor: null } });
    if (path.endsWith('/integrations')) return route.fulfill({ json: { integrations: [] } });
    if (path.endsWith('/recommendations'))
      return route.fulfill({
        json: { onboarding: false, items: fallbackRecommendations, status: 'ready', version: 1 },
      });
    if (path.endsWith('/credits'))
      return route.fulfill({
        json: { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] },
      });
    if (/\/conversations\/[\w-]+\/events$/.test(path)) return route.fulfill({ status: 204 });
    if (/\/conversations\/[\w-]+$/.test(path)) {
      if (request.method() === 'PUT') {
        state.chatCreates.push(request.postDataJSON());
        state.chat = chatRecord(path.split('/').at(-1));
        installation.chatId = state.chat.id;
        return route.fulfill({ json: { id: state.chat.id } });
      }
      return route.fulfill({ json: state.chat });
    }
    if (path.endsWith('/conversations'))
      return route.fulfill({ json: { chats: state.chat ? [state.chat] : [], nextCursor: null } });
    if (/\/messages\/[\w-]+$/.test(path) && request.method() === 'PUT') {
      const input = request.postDataJSON();
      state.sends.push(input);
      const message = saveMessages(path.split('/').at(-1), input.parts);
      return route.fulfill({
        json: { messageId: message.id, turnId: message.turn.id, sequence: message.sequence },
      });
    }
    if (path.endsWith('/messages')) return route.fulfill({ json: history() });
    if (path.endsWith('/messages/pages'))
      return route.fulfill({
        json: { chat: state.chat, pages: [{ digest: 'd'.repeat(64), value: history() }] },
      });
    if (path.endsWith('/plans')) return route.fulfill({ json: { plans: [], nextCursor: null } });
    if (path.endsWith('/governance/me'))
      return route.fulfill({
        json: {
          membershipId,
          role: 'member',
          teams: [{ id: teamId, name: 'Operations', role: 'manager' }],
          capabilities: { manageGovernance: false, canLeave: true },
        },
      });
    if (path.endsWith('/governance/directory'))
      return route.fulfill({
        json: { members: [{ id: membershipId, name: 'Importer', email: 'importer@example.test', image: null }] },
      });
    if (path.endsWith('/system-packages/validate')) {
      state.validations.push(request.postDataJSON());
      return route.fulfill({
        json: {
          valid: true,
          packageDigest: installation.packageDigest,
          inputDigest: installation.inputDigest,
          issues: [],
          order: pkg.resources.map(resource => resource.key),
        },
      });
    }
    if (path.endsWith('/system-package-installations')) {
      if (request.method() === 'GET') {
        assert.equal(new URL(request.url()).searchParams.get('chatId'), state.chat.id);
        if (state.failRead) return route.fulfill({ status: 500, json: { error: 'temporarily-unavailable' } });
        return route.fulfill({ json: { installations: state.saved ? [installation] : [], nextCursor: null } });
      }
      state.imports.push(request.postDataJSON());
      if (state.imports.length === 1) return route.abort();
      state.saved = true;
      return route.fulfill({ json: installation });
    }
    if (path.endsWith(`/system-package-installations/${installation.id}/approve`)) {
      state.approvals.push(request.postDataJSON());
      if (state.approvals.length === 1) return route.abort();
      installation.packageApproved = true;
      installation.status = 'running';
      installation.nodes.find(node => node.kind === 'skill').state = 'running';
      installation.version++;
      return route.fulfill({ json: installation });
    }
    if (path.endsWith(`/system-package-installations/${installation.id}/review`)) {
      state.reviews.push(request.postDataJSON());
      return route.fulfill({ status: 409, json: { error: 'unexpected-resource-review' } });
    }
    if (path.endsWith(`/system-package-installations/${installation.id}`)) {
      if (state.failRead) return route.fulfill({ status: 500, json: { error: 'temporarily-unavailable' } });
      return route.fulfill({ json: installation });
    }
    state.unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: 'not-found' } });
  });
  return { page, context, workspace, pkg, installation, state, packageUrl };
}

async function refreshInstallation(installed) {
  const refresh = installed.getByRole('button', { name: 'Refresh status', exact: true });
  if (!(await refresh.isVisible()))
    await installed.getByRole('button', { name: 'Installation details', exact: true }).click();
  await refresh.click();
}

test(
  'catalog handoff sends once without a model; one package approval, safe retry and verified progress persist',
  { timeout: 120000 },
  async () => {
    const server = await startBuiltApp();
    const browser = await chromium.launch();
    let fixture;
    try {
      fixture = await packageFixture(browser);
      const { page, workspace, pkg, installation, state, packageUrl } = fixture;
      const modelUnavailable = page.waitForResponse(
        response => new URL(response.url()).pathname.endsWith('/model-catalog') && response.status() === 503,
      );
      await page.goto(`${server.origin}/${workspace.slug}`);
      await modelUnavailable;
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Tell me about leave policies.');
      assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
      assert.equal(state.chatCreates.length, 0, 'ordinary chat still requires an available model');
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill('');
      await page.goto(`${server.origin}/${workspace.slug}/packages`);
      await page.getByRole('link', { name: new RegExp(pkg.package.title) }).click();
      assert.equal(
        new URL(page.url()).pathname,
        `/${workspace.slug}/packages/catalog/${pkg.package.name}/${pkg.package.version}`,
      );
      assert.equal(await page.locator('a[href^="https://packages.tulipfarm.ai"]').count(), 0);
      await page.getByRole('link', { name: 'Install', exact: true }).click();
      const conversation = page.getByRole('region', { name: 'Conversation', exact: true });
      const offer = conversation.getByRole('region', { name: 'Package offer', exact: true });
      await conversation.locator('[data-layout="chat"]').getByRole('region', { name: 'Package offer' }).waitFor();
      assert.equal(await offer.count(), 1, 'the saved layout replaces the fallback offer rather than duplicating it');
      await conversation.getByText(`Package: ${pkg.package.title}`, { exact: true }).waitFor();
      const pill = conversation.getByRole('link', {
        name: `Open ${pkg.package.title}, version ${pkg.package.version}, in a new tab`,
      });
      assert.equal(await pill.getAttribute('target'), '_blank');
      assert.equal(await pill.locator('img[src="/favicon.svg"]').count(), 1);
      assert.equal(state.chatCreates.length, 1);
      assert.equal(state.sends.length, 1, 'install handoff sends automatically, without clicking Send');
      assert.equal(Object.hasOwn(state.sends[0], 'model'), false, 'model-free installation omits the model field');
      assert.ok(state.sends[0].parts.some(part => part.kind === 'text' && part.text.includes(packageUrl)));
      assert.equal(new URL(page.url()).pathname, `/${workspace.slug}/chat/${state.chat.id}`);
      assert.equal(state.imports.length, 0);
      assert.equal(state.validations.length, 0);
      const canvas = page.getByRole('region', { name: 'Canvas', exact: true });
      assert.equal(await canvas.count(), 0, 'opening the installer does not force the canvas open');
      await offer.getByRole('button', { name: `${pkg.resources.length} resources to install`, exact: true }).click();
      await offer.getByRole('button', { name: 'Open installation', exact: true }).click();
      const preview = canvas.getByRole('region', { name: 'Installation plan', exact: true });
      await preview.waitFor();
      assert.equal(await preview.getAttribute('data-slot'), 'plan-outline');
      assert.deepEqual(
        await preview.getByRole('img').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))),
        ['Table', 'Starter record', 'Table', 'Starter record', 'Skill', 'Agent', 'Workflow'],
      );
      assert.equal(await conversation.locator('[data-slot="plan-outline"], [data-slot="task-tree"]').count(), 0);
      await preview.getByText(/Shown in file order, not execution order/).waitFor();
      await page.reload();
      await offer.waitFor();
      assert.equal(state.chatCreates.length, 1);
      assert.equal(state.sends.length, 1, 'reloading the saved reply does not resend the installation prompt');
      await offer.getByRole('button', { name: 'Continue', exact: true }).click();
      await offer.getByText('Question 1 of 2', { exact: true }).waitFor();
      assert.equal(await offer.getByRole('combobox').count(), 1);
      assert.equal(await offer.getByRole('button', { name: 'Continue', exact: true }).isDisabled(), true);
      assert.equal(await offer.getByRole('combobox', { name: 'Importing person (skill manager)' }).count(), 0);
      await offer.getByRole('combobox', { name: 'Owning team' }).click();
      await page.getByRole('option', { name: 'Operations', exact: true }).click();
      await offer.getByRole('button', { name: 'Continue', exact: true }).click();
      await offer.getByText('Question 2 of 2', { exact: true }).waitFor();
      assert.equal(await offer.getByRole('combobox').count(), 1);
      assert.equal(await offer.getByRole('combobox', { name: 'Owning team' }).count(), 0);
      assert.equal(state.validations.length, 0, 'validation waits for all required answers');
      await offer.getByRole('combobox', { name: 'Importing person (skill manager)' }).click();
      await page.getByRole('option', { name: 'You (installation owner)', exact: true }).click();
      await offer.getByRole('button', { name: 'Continue', exact: true }).click();
      await offer.getByText('Ready for your approval', { exact: true }).waitFor();
      assert.deepEqual(state.validations, [{ package: pkg, bindings: installation.bindings }]);
      assert.equal(state.imports.length, 0, 'checking access is not approval');
      await offer.getByRole('button', { name: 'Install package', exact: true }).click();
      const retry = conversation.getByRole('button', { name: 'Retry same operation', exact: true });
      await retry.waitFor();
      assert.equal(await offer.getByRole('button', { name: 'Install package', exact: true }).isDisabled(), true);
      assert.equal(await offer.getByRole('button', { name: 'Change Owning team', exact: true }).isDisabled(), true);
      await retry.click();
      const installed = conversation.getByRole('region', { name: `${pkg.package.title} installation`, exact: true });
      await installed.waitFor();
      assert.equal(state.imports.length, 2);
      assert.deepEqual(state.imports[1], state.imports[0], 'uncertain create retries the exact request and approval');
      assert.deepEqual(state.imports[0].approval, {
        packageDigest: installation.packageDigest,
        inputDigest: installation.inputDigest,
      });
      assert.deepEqual(state.imports[0].bindings, installation.bindings);
      assert.deepEqual(state.imports[0].package, pkg);
      assert.equal(state.imports[0].chatId, state.chat.id);
      assert.match(state.imports[0].requestId, /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      assert.notEqual(state.imports[0].requestId, state.chat.id);
      assert.equal(await conversation.locator('section[aria-label^="Review "]').count(), 0);
      assert.equal(await conversation.getByRole('button', { name: /^Approve / }).count(), 0);
      await installed.getByRole('button', { name: 'Open installation', exact: true }).click();
      const tree = canvas.getByRole('region', { name: 'Installation progress', exact: true });
      await tree.getByText('6 of 8 steps complete', { exact: true }).waitFor();
      assert.equal(await tree.getAttribute('data-slot'), 'plan-outline');
      state.failRead = true;
      await refreshInstallation(installed);
      await tree.getByText(/Showing the last loaded installation/).waitFor();
      state.failRead = false;
      installation.nodes.find(node => node.kind === 'skill').state = 'completed';
      installation.nodes.at(-1).state = 'failed';
      installation.nodes.at(-1).error = 'Saved skill revision no longer matches.';
      installation.status = 'failed';
      installation.version++;
      await refreshInstallation(installed);
      await installed.getByText('Saved skill revision no longer matches.', { exact: true }).waitFor();
      await tree.getByText('7 of 8 steps complete', { exact: true }).waitFor();
      assert.equal(await conversation.getByText('Installation complete', { exact: true }).count(), 0);
      await tree.getByRole('button', { name: 'Final verification Needs attention', exact: true }).click();
      await tree
        .getByText('The server reads back every installed resource and verifies its requested configuration.')
        .waitFor();
      installation.status = 'completed';
      installation.version++;
      await refreshInstallation(installed);
      await tree.getByText('Verification missing', { exact: true }).waitFor();
      assert.equal(
        await conversation.getByText('Installation complete', { exact: true }).count(),
        0,
        'completed status with failed verification must not claim success',
      );
      installation.nodes.at(-1).state = 'completed';
      installation.nodes.at(-1).error = null;
      installation.version++;
      await refreshInstallation(installed);
      await installed.getByRole('heading', { name: `${pkg.package.title} installed`, exact: true }).waitFor();
      await installed.getByText('Setup is complete. No further approval is needed.', { exact: true }).waitFor();
      assert.equal(await installed.getByRole('button', { name: 'Refresh status', exact: true }).isVisible(), false);
      assert.equal(await tree.isVisible(), false, 'verified canvas details collapse with the success result');
      for (const reload of [false, true]) {
        if (reload) await page.reload();
        else await page.goto(`${server.origin}/${workspace.slug}/chat/${state.chat.id}`);
        await installed.getByText('Installation complete', { exact: true }).waitFor();
        assert.equal(
          await installed.getByRole('button', { name: 'Open installation', exact: true }).isVisible(),
          false,
        );
        assert.equal(await conversation.getByRole('button', { name: /^Approve |^Install package$/ }).count(), 0);
      }
      await installed.getByRole('button', { name: 'Installation details', exact: true }).click();
      await installed.getByRole('button', { name: 'Open installation', exact: true }).click();
      await canvas.getByRole('button', { name: 'Installation details', exact: true }).click();
      await tree.getByText('8 of 8 steps complete', { exact: true }).waitFor();
      installation.nodes.pop();
      installation.version++;
      await refreshInstallation(installed);
      await installed.getByText(/The verification step is missing/).waitFor();
      await tree.getByText('7 of 8 steps complete', { exact: true }).waitFor();
      assert.equal(await conversation.getByText('Installation complete', { exact: true }).count(), 0);
      assert.equal(state.imports.length, 2);
      assert.equal(state.chatCreates.length, 1);
      assert.equal(state.sends.length, 1);
      assert.deepEqual(state.approvals, [], 'create already carries the only whole-package approval');
      assert.deepEqual(state.reviews, [], 'resource reviews are never submitted');
      assert.deepEqual(state.unexpected, []);
      assert.deepEqual(state.errors, []);
    } catch (error) {
      await captureBrowserFailure(fixture?.page, 'system-packages-handoff');
      throw error;
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test(
  'legacy installation shows full definitions and safely retries one whole-package approval',
  { timeout: 60000 },
  async () => {
    const server = await startBuiltApp();
    const browser = await chromium.launch();
    let fixture;
    try {
      fixture = await packageFixture(browser, { legacy: true });
      const { page, workspace, pkg, installation, state } = fixture;
      await page.goto(`${server.origin}/${workspace.slug}/chat/${state.chat.id}`);
      const conversation = page.getByRole('region', { name: 'Conversation', exact: true });
      const installed = conversation.getByRole('region', { name: `${pkg.package.title} installation`, exact: true });
      const approve = installed.getByRole('button', { name: 'Approve package and install', exact: true });
      await approve.waitFor();
      assert.equal(await conversation.getByRole('region', { name: 'Package offer', exact: true }).count(), 0);
      assert.equal(await conversation.locator('[data-package-surface^="package-installation-"]').count(), 1);
      await installed.getByRole('button', { name: 'Exact package definitions and files', exact: true }).click();
      const definitions = JSON.stringify(
        {
          resources: installation.nodes.flatMap(node => (node.definition ? [node.definition] : [])),
          assets: installation.assets,
          bindings: installation.bindings,
        },
        null,
        2,
      );
      assert.ok(definitions.length > 20000, 'the exact review exceeds the A2UI literal limit');
      const code = installed.locator('pre').filter({ hasText: 'END OF EXACT PACKAGE FILE' });
      await code.waitFor();
      assert.equal(
        await code.textContent(),
        definitions,
        'the native code block exposes every definition and file byte',
      );
      assert.equal(await conversation.locator('section[aria-label^="Review "]').count(), 0);
      await installed.getByRole('button', { name: 'Open installation', exact: true }).click();
      const canvas = page.getByRole('region', { name: 'Canvas', exact: true });
      await canvas.getByText('Needs fresh review (attempt 2)', { exact: true }).waitFor();
      assert.equal(await canvas.getByRole('button', { name: /^Approve / }).count(), 0);
      state.failRead = true;
      await refreshInstallation(installed);
      await canvas.getByText(/Showing the last loaded installation/).waitFor();
      assert.equal(await approve.isDisabled(), true, 'stale saved definitions cannot authorize approval');
      state.failRead = false;
      await refreshInstallation(installed);
      await canvas.getByText(/Showing the last loaded installation/).waitFor({ state: 'detached' });
      await approve.click();
      const retry = installed.getByRole('button', { name: 'Retry same operation', exact: true });
      await retry.waitFor();
      assert.equal(await approve.isDisabled(), true);
      await retry.click();
      await approve.waitFor({ state: 'detached' });
      assert.equal(state.approvals.length, 2);
      assert.deepEqual(state.approvals[1], state.approvals[0], 'approval retries preserve both checked digests');
      assert.deepEqual(state.approvals[0], {
        packageDigest: installation.packageDigest,
        inputDigest: installation.inputDigest,
      });
      await page.reload();
      await installed.getByText('Installing', { exact: true }).waitFor();
      assert.equal(await conversation.getByRole('button', { name: /^Approve / }).count(), 0);
      assert.equal(state.approvals.length, 2);
      assert.deepEqual(state.imports, []);
      assert.deepEqual(state.reviews, []);
      assert.deepEqual(state.chatCreates, []);
      assert.deepEqual(state.sends, []);
      assert.deepEqual(state.unexpected, []);
      assert.deepEqual(state.errors, []);
    } catch (error) {
      await captureBrowserFailure(fixture?.page, 'system-packages-legacy');
      throw error;
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
