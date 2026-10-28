import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { systemPackageInstallationSchema } from '../../../packages/agents/src/system-package-contracts.ts';
import { startBuiltApp } from './built-app.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { createWorkspaceFixture, workspaceShellReads, serveWorkspaceShellEvent } from './workspace.fixture.mjs';

test(
  'marketplace opens chat and native canvas; installation retries, reviews and final verification persist',
  { timeout: 120000 },
  async () => {
    const server = await startBuiltApp();
    const browser = await chromium.launch();
    try {
      const { workspace, session } = createWorkspaceFixture({ slug: 'packages-qa', name: 'Packages QA' });
      const teamId = randomUUID();
      const membershipId = randomUUID();
      const pkg = JSON.parse(
        await readFile(
          new URL('../../../packages/config/examples/system-packages/leave-management.json', import.meta.url),
          'utf8',
        ),
      );
      const savedAssets = structuredClone(pkg.assets);
      savedAssets[1].encoding = 'base64';
      savedAssets[1].content = Buffer.from(savedAssets[1].content).toString('base64');
      const review = {
        digest: 'c'.repeat(64),
        description: 'Create this exact skill and approve its files for use.',
        href: null,
      };
      const installation = systemPackageInstallationSchema.parse({
        id: randomUUID(),
        workspaceId: workspace.id,
        chatId: null,
        package: pkg.package,
        packageDigest: 'a'.repeat(64),
        inputDigest: 'b'.repeat(64),
        bindings: {
          'owning-team': { kind: 'team', id: teamId },
          'package-manager': { kind: 'member', id: membershipId },
        },
        assets: savedAssets,
        version: 1,
        status: 'waiting-review',
        nodes: [
          ...pkg.resources.map(resource => ({
            key: resource.key,
            kind: resource.kind,
            title: resource.key,
            dependsOn: [],
            state: resource.kind === 'skill' ? 'waiting-review' : 'completed',
            attempt: resource.kind === 'skill' ? 1 : 0,
            resourceId: randomUUID(),
            revision: '1',
            error: null,
            review,
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
      const imports = [],
        decisions = [],
        errors = [];
      let failedImport = false;
      let failedReview = false;
      let failRead = false;
      let saved = false;
      let chat = null;
      let validations = 0;
      const chatCreates = [];
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(String(error)));
      const shell = new Map(workspaceShellReads(workspace.id));
      await context.route('**/v1/**', async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (await serveWorkspaceShellEvent(route, workspace)) return;
        if (shell.has(path)) return route.fulfill({ json: shell.get(path) });
        if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
        if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
        if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
        if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
        if (path.endsWith('/model-catalog')) return route.fulfill({ json: chatCatalog });
        if (/\/conversations\/[\w-]+$/.test(path)) {
          if (request.method() === 'PUT') {
            chatCreates.push(request.postDataJSON());
            chat = {
              id: path.split('/').at(-1),
              title: 'Leave management',
              titleRevision: 1,
              archived: false,
              activityAt: workspace.createdAt,
              createdAt: workspace.createdAt,
            };
            installation.chatId = chat.id;
            return route.fulfill({ json: { id: chat.id } });
          }
          return route.fulfill({ json: chat });
        }
        if (path.endsWith('/conversations'))
          return route.fulfill({ json: { chats: chat ? [chat] : [], nextCursor: null } });
        if (path.endsWith('/messages'))
          return route.fulfill({ json: { messages: [], nextBefore: null, hasGitHubProposals: false } });
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
        if (path.endsWith('/workspace-mcp/capabilities')) return route.fulfill({ json: { enabled: false } });
        if (path.endsWith('/system-packages/validate')) {
          validations++;
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
            assert.equal(new URL(request.url()).searchParams.get('chatId'), chat.id);
            if (failRead) return route.fulfill({ status: 500, json: { error: 'temporarily-unavailable' } });
            return route.fulfill({ json: { installations: saved ? [installation] : [], nextCursor: null } });
          }
          imports.push(request.postDataJSON());
          if (!failedImport) {
            failedImport = true;
            return route.abort();
          }
          saved = true;
          return route.fulfill({ json: installation });
        }
        if (path.endsWith(`/system-package-installations/${installation.id}/review`)) {
          decisions.push(request.postDataJSON());
          if (!failedReview) {
            failedReview = true;
            return route.abort();
          }
          installation.nodes.find(node => node.kind === 'skill').state = 'completed';
          installation.nodes.at(-1).state = 'failed';
          installation.nodes.at(-1).error = 'Saved skill revision no longer matches.';
          installation.status = 'failed';
          installation.version++;
          return route.fulfill({ json: installation });
        }
        if (path.endsWith(`/system-package-installations/${installation.id}`)) {
          if (failRead) return route.fulfill({ status: 500, json: { error: 'temporarily-unavailable' } });
          return route.fulfill({ json: installation });
        }
        return route.fulfill({ status: 404, json: { error: 'not-found' } });
      });
      await page.goto(`${server.origin}/${workspace.slug}/packages`);
      await page.getByRole('button', { name: 'Open Leave Management in chat' }).click();
      const conversation = page.getByRole('region', { name: 'Conversation', exact: true });
      await conversation.getByRole('region', { name: 'Package offer' }).waitFor();
      assert.equal(chatCreates.length, 1);
      assert.equal(new URL(page.url()).pathname, `/${workspace.slug}/chat/${chat.id}`);
      const canvas = page.getByRole('region', { name: 'Canvas', exact: true });
      const preview = canvas.getByRole('region', { name: 'Installation plan', exact: true });
      await preview.waitFor();
      assert.equal(await preview.getAttribute('data-slot'), 'plan-outline');
      assert.deepEqual(
        await preview.getByRole('img').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))),
        ['Table', 'Starter record', 'Table', 'Starter record', 'Skill', 'Agent', 'Workflow'],
      );
      for (const [type, navigation] of [
        ['Table', 'Tables'],
        ['Skill', 'Skills'],
        ['Agent', 'Agents'],
        ['Workflow', 'Workflows'],
      ]) {
        const paths = locator =>
          locator.locator('svg path').evaluateAll(nodes => nodes.map(node => node.getAttribute('d')));
        assert.deepEqual(
          await paths(preview.getByRole('img', { name: type, exact: true }).first()),
          await paths(
            page
              .getByRole('navigation', { name: 'Workspace navigation' })
              .getByRole('link', { name: navigation, exact: true }),
          ),
          `${type} uses the canonical navigation icon`,
        );
      }
      assert.equal(await conversation.locator('[data-slot="plan-outline"], [data-slot="task-tree"]').count(), 0);
      await preview.getByText(/Shown in file order, not execution order/).waitFor();
      await page.reload();
      await conversation.getByRole('region', { name: 'Package offer' }).waitFor();
      assert.equal(imports.length, 0);
      assert.equal(validations, 0);
      assert.equal(decisions.length, 0);
      await page.getByRole('combobox', { name: 'Owning team' }).click();
      await page.getByRole('option', { name: 'Operations' }).click();
      await page.getByRole('combobox', { name: 'Importing person (skill manager)' }).click();
      await page.getByRole('option', { name: 'You (installation owner)' }).click();
      await page.getByRole('button', { name: 'Check package and access' }).click();
      await page.getByText('Ready to install', { exact: true }).waitFor();
      assert.equal(validations, 1);
      assert.equal(imports.length, 0, 'validation alone does not install');
      await page.getByRole('button', { name: 'Install', exact: true }).click();
      const retry = page.getByRole('button', { name: 'Retry same operation' });
      await retry.waitFor();
      assert.equal(await page.getByRole('button', { name: 'Install', exact: true }).isDisabled(), true);
      await retry.click();
      await canvas.getByRole('region', { name: 'Installation progress', exact: true }).waitFor();
      assert.equal(imports.length, 2);
      assert.deepEqual(imports[1], imports[0], 'uncertain import reuses its exact request ID and bindings');
      assert.equal(imports[0].chatId, chat.id);
      assert.equal(imports[0].requestId, chat.id);
      assert.equal(imports[0].bindings['owning-team'].id, teamId);
      assert.equal(imports[0].bindings['package-manager'].id, membershipId);
      await page.getByRole('textbox', { name: 'Message' }).waitFor();
      await page.getByText('Needs fresh review (attempt 2)', { exact: true }).first().waitFor();
      assert.equal(
        await conversation.locator('section[aria-label^="Review "]').count(),
        1,
        'completed nodes with retained reviews cannot be approved twice',
      );
      assert.equal(await canvas.locator('section[aria-label^="Review "]').count(), 0, 'approvals remain in chat');
      await page.getByRole('button', { name: 'Skill file: SKILL.md', exact: true }).click();
      await page.getByText(pkg.assets[0].content, { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Skill file: references/review.md', exact: true }).click();
      await page.getByText(/Binary content is not rendered/).waitFor();
      assert.equal(await page.getByText(savedAssets[1].content, { exact: true }).count(), 0);
      const approve = page.getByRole('button', { name: 'Approve leave-management-procedure', exact: true });
      failRead = true;
      await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
      await canvas.getByText(/Showing the last loaded installation/).waitFor();
      assert.equal(await approve.isDisabled(), true, 'stale data cannot authorize a review');
      failRead = false;
      await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
      await canvas.getByText(/Showing the last loaded installation/).waitFor({ state: 'detached' });
      await approve.click();
      await retry.waitFor();
      assert.equal(await approve.isDisabled(), true);
      await retry.click();
      await page.getByText('Saved skill revision no longer matches.', { exact: true }).last().waitFor();
      assert.deepEqual(decisions[1], decisions[0], 'review retries reuse the original digest, version and request ID');
      assert.equal(
        await page.getByText('All requested resources were read back and verified.', { exact: true }).count(),
        0,
      );
      assert.equal(
        await page
          .locator('button')
          .filter({ hasText: /^Approve / })
          .count(),
        0,
      );
      const tree = canvas.getByRole('region', { name: 'Installation progress', exact: true });
      await tree.getByText('7 of 8 steps complete', { exact: true }).waitFor();
      assert.equal(await tree.getAttribute('data-slot'), 'plan-outline');
      assert.equal(await tree.getByRole('img', { name: 'Table', exact: true }).count(), 2);
      await tree.getByRole('button', { name: 'Final verification Needs attention', exact: true }).click();
      await tree
        .getByText('The server reads back every installed resource and verifies its requested configuration.')
        .waitFor();
      installation.status = 'completed';
      installation.version++;
      await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
      await tree.getByText('Verification missing', { exact: true }).waitFor();
      assert.equal(
        await page.getByText('All requested resources were read back and verified.', { exact: true }).count(),
        0,
        'a completed status without successful final verification is not success',
      );
      installation.nodes.at(-1).state = 'completed';
      installation.nodes.at(-1).error = null;
      installation.version++;
      await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
      await page.getByText('All requested resources were read back and verified.', { exact: true }).waitFor();
      await tree.getByText('8 of 8 steps complete', { exact: true }).waitFor();
      await page.goto(`${server.origin}/${workspace.slug}/chat/${chat.id}`);
      await page.getByText('All requested resources were read back and verified.', { exact: true }).waitFor();
      await page.reload();
      await page.getByText('All requested resources were read back and verified.', { exact: true }).waitFor();
      assert.equal(imports.length, 2, 'restoring without the offer query must not start another installation');
      assert.equal(decisions.length, 2, 'restoring does not repeat approvals');
      await page.getByRole('button', { name: 'Open installation' }).click();
      await tree.getByText('8 of 8 steps complete', { exact: true }).waitFor();
      installation.nodes.pop();
      await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
      await page.getByText('Verification step missing', { exact: true }).waitFor();
      await tree.getByText('7 of 8 steps complete', { exact: true }).waitFor();
      assert.equal(
        await page.getByText('All requested resources were read back and verified.', { exact: true }).count(),
        0,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
