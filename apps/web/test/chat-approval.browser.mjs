import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { proposalViewSchema, proposalDecisionSchema } from '@tulipfarm/tables/proposal-contracts';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';

test(
  'chat approval dock retains exact decisions, visible progress, and multiple proposal access',
  { timeout: 120000 },
  async () => {
    const port = 5766;
    const origin = `http://127.0.0.1:${port}`;
    const { workspace, session } = createWorkspaceFixture({ slug: 'approval-qa', name: 'Approval QA' });
    const membershipId = randomUUID(),
      chatId = randomUUID();
    const views = ['Customers', 'Contacts'].map(label => {
      const id = randomUUID(),
        tableId = randomUUID();
      const definition = {
        formatVersion: 2,
        id: tableId,
        owningTeamId: randomUUID(),
        label,
        fields: [
          { id: randomUUID(), label: 'Name', kind: 'text', required: true, maxLength: 200 },
          { id: randomUUID(), label: 'Email', kind: 'text', required: false, maxLength: 200 },
        ],
        uniqueKeys: [],
      };
      return proposalViewSchema.parse({
        content: 'available',
        id,
        digest: 'd'.repeat(64),
        status: 'pending',
        decision: null,
        cancelled: false,
        expired: false,
        freshness: 'current',
        plans: [{ tableId, receipt: null, importProgress: null }],
        manifest: {
          version: 1,
          id,
          workspaceId: workspace.id,
          conversationId: chatId,
          turnId: randomUUID(),
          sources: [],
          expiresAt: '2099-10-11T00:00:00Z',
          requester: { kind: 'human', userId: session.user.id, membershipId },
          plans: [
            {
              input: {
                kind: 'schema',
                tableId,
                dependsOn: [],
                expectedRevision: null,
                target: definition,
                transforms: { outputs: [] },
              },
              before: null,
              after: definition,
              effectCount: 0,
              effectsDigest: 'e'.repeat(64),
              freshnessDigest: 'f'.repeat(64),
              audience: null,
              importSources: [],
            },
          ],
        },
      });
    });
    const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: new URL('..', import.meta.url),
      stdio: 'ignore',
    });
    let browser;
    let page;
    try {
      for (
        let attempt = 0;
        !(await fetch(origin).then(
          response => response.ok,
          () => false,
        ));
        attempt++
      ) {
        assert.ok(attempt < 150 && server.exitCode === null, 'Vite starts');
        await delay(100);
      }
      browser = await chromium.launch({
        args: process.env.APPROVAL_CDP_PORT ? [`--remote-debugging-port=${process.env.APPROVAL_CDP_PORT}`] : [],
      });
      page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
        colorScheme: 'light',
        reducedMotion: 'reduce',
      });
      const errors = [],
        decisions = [];
      let count = 1;
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/v1/**', async route => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        let json;
        if (path === '/v1/auth/get-session') json = session;
        else if (path === '/v1/user/visit') json = { firstSession: false };
        else if (path === '/v1/workspaces') json = [workspace];
        else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
        else if (path.endsWith('/governance/me'))
          json = { membershipId, role: 'member', teams: [], capabilities: { manageGovernance: false, canLeave: true } };
        else if (path.endsWith('/model-catalog')) json = chatCatalog;
        else if (path.includes('/table-changes/')) {
          const view = views.find(value => path.includes(value.id));
          assert.ok(view, 'known proposal identity');
          if (request.method() === 'PUT') {
            const body = proposalDecisionSchema.parse(request.postDataJSON());
            assert.equal(body.digest, view.digest);
            decisions.push(body);
            await delay(600);
            view.decision = body.decision;
            view.status = body.decision === 'approve' ? 'approved' : 'rejected';
            json = view;
          } else json = path.endsWith('/outcome') ? { kind: 'proposal' } : view;
        } else if (path.endsWith('/messages'))
          json = {
            messages: views.slice(0, count).map((view, index) => ({
              id: view.id,
              sequence: index + 1,
              author: 'assistant',
              createdAt: workspace.createdAt,
              parts: [{ kind: 'text', text: `Review the ${view.manifest.plans[0].after.label} table changes.` }],
              turn: { id: view.manifest.turnId, status: 'completed', generation: 0 },
              tools: [{ id: view.id, tool: 'tables.propose', status: 'completed' }],
            })),
            nextBefore: null,
            hasGitHubProposals: false,
          };
        else if (path.endsWith(`/conversations/${chatId}`))
          json = {
            id: chatId,
            title: 'Create customer tables',
            titleRevision: 1,
            archived: false,
            activityAt: workspace.createdAt,
            createdAt: workspace.createdAt,
          };
        else if (path.endsWith('/tables')) json = { tables: [], nextCursor: null };
        else return route.fulfill({ status: 404, json: { error: 'not-found' } });
        return route.fulfill({ json });
      });
      const card = page.getByRole('region', { name: 'Table change proposal', exact: true });
      const dock = page.getByRole('region', { name: 'Table approval', exact: true });
      const load = () => page.goto(`${origin}/${workspace.slug}/chat/${chatId}`);
      const check = () => card.getByRole('button', { name: 'Check proposal status', exact: true }).click();
      const capture = async name => {
        if (!process.env.APPROVAL_SCREENSHOTS) return;
        const path = `${process.env.APPROVAL_SCREENSHOTS}/${name}.png`;
        if (process.env.APPROVAL_CDP_PORT)
          await promisify(execFile)('agent-browser', ['--cdp', process.env.APPROVAL_CDP_PORT, 'screenshot', path]);
        else await page.screenshot({ path });
      };
      await load();
      await card.getByRole('button', { name: 'Approve & create', exact: true }).waitFor();
      assert.equal(await dock.getByRole('button', { name: 'Approve & create', exact: true }).count(), 1);
      assert.equal(
        await page
          .getByRole('region', { name: 'Conversation', exact: true })
          .getByRole('button', { name: /Approve/ })
          .count(),
        0,
      );
      await card.getByRole('button', { name: 'Open schema', exact: true }).click();
      await page.getByRole('figure', { name: 'Schema diagram for Create Customers table' }).waitFor();
      await page
        .getByRole('figure', { name: 'Schema diagram for Create Customers table' })
        .getByText('Email', { exact: true })
        .waitFor();
      await capture('approval-ready');
      await card.getByRole('button', { name: 'Approve & create', exact: true }).dblclick();
      await card.getByRole('button', { name: 'Approving...', exact: true }).waitFor();
      assert.ok(await card.getByRole('button', { name: 'Approving...', exact: true }).isDisabled());
      await capture('approval-sending');
      await card.getByRole('heading', { name: 'Approval recorded', exact: true }).waitFor();
      assert.equal(decisions.length, 1);
      assert.equal(
        await card.locator('a').filter({ hasText: 'View table' }).count(),
        0,
        'approval acceptance is not completion',
      );
      views[0].status = 'running';
      await check();
      await card.getByRole('heading', { name: 'Applying changes', exact: true }).waitFor();
      await capture('approval-running');
      views[0].status = 'completed';
      views[0].plans[0].receipt = { status: 'completed', executionId: randomUUID(), revision: 'a'.repeat(40) };
      await check();
      await card.getByRole('heading', { name: 'Customers table created', exact: true }).waitFor();
      assert.equal(
        await card.locator('a').filter({ hasText: 'View table' }).getAttribute('href'),
        `/${workspace.slug}/tables/${views[0].plans[0].tableId}`,
      );
      await capture('approval-completed');
      await load();
      await card.getByRole('heading', { name: 'Customers table created', exact: true }).waitFor();

      count = 2;
      await load();
      await card.getByText('Contacts', { exact: true }).waitFor();
      await page.getByRole('combobox', { name: 'Choose proposal' }).click();
      await page.getByRole('option', { name: /Create Customers table/ }).click();
      await card.getByRole('heading', { name: 'Customers table created', exact: true }).waitFor();
      await page.getByRole('combobox', { name: 'Choose proposal' }).click();
      await page.getByRole('option', { name: /Create Contacts table/ }).click();

      for (const width of [320, 375, 414, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await load();
        await card.getByRole('button', { name: 'Approve & create', exact: true }).waitFor();
        const before = await dock.boundingBox();
        assert.ok(before, `dock is visible at ${width}`);
        await page.getByRole('region', { name: 'Conversation', exact: true }).evaluate(element => {
          const spacer = document.createElement('div');
          spacer.dataset.approvalTest = 'true';
          spacer.style.height = '1500px';
          element.append(spacer);
          element.scrollTop = element.scrollHeight;
        });
        assert.equal((await dock.boundingBox()).y, before.y, `dock does not scroll at ${width}`);
        const button = await card.getByRole('button', { name: 'Approve & create', exact: true }).boundingBox();
        assert.ok(button && button.y >= 0 && button.y + button.height < 900, `approval is reachable at ${width}`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.getByRole('region', { name: 'Conversation', exact: true }).evaluate(element => {
          element.querySelector('[data-approval-test]')?.remove();
          element.scrollTop = 0;
        });
        if (width === 375) await capture('approval-mobile');
      }
      views[1].manifest.requester.membershipId = randomUUID();
      await check();
      await card.getByText(/Only the person who requested/).waitFor();
      assert.equal(
        await card.getByRole('button', { name: 'Approve & create', exact: true }).count(),
        0,
        'a new membership does not inherit earlier approval authority',
      );
      assert.deepEqual(errors, []);
    } catch (error) {
      await page?.screenshot({ path: '/tmp/chat-approval-failure.png' });
      throw error;
    } finally {
      await browser?.close();
      server.kill('SIGTERM');
    }
  },
);
