import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { proposalControlSchema, proposalViewSchema } from '@tulipfarm/tables/proposal-contracts';
import { workspaceMemberFields } from '@tulipfarm/tables/workspace-members';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { startWorkspaceMembersDemo } from './workspace-members-demo.mjs';

const id = n => `87654321-4321-4321-8321-${String(n).padStart(12, '0')}`;

test('member proposal failures explain rejected resumes and retain completed work', { timeout: 120000 }, async () => {
  const server = await startWorkspaceMembersDemo({ port: 5795 });
  const { origin } = server,
    workspaceId = id(1),
    chatId = id(60),
    proposalId = id(61),
    turnId = id(62);
  const root = `/v1/workspaces/${workspaceId}`,
    base = `${root}/conversations/${chatId}/table-changes/${proposalId}`;
  const date = '2026-10-14T00:00:00.000Z';
  const cdp = process.env.MEMBER_PROPOSAL_CDP_PORT;
  const session = `workspace-member-proposals-${process.pid}`;
  let browser,
    page,
    attached = false,
    view,
    effect;
  try {
    browser = await chromium.launch({ args: cdp ? [`--remote-debugging-port=${cdp}`] : [] });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(15000);
    const errors = [],
      external = [],
      commands = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', async route => {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname;
      if (url.origin !== origin) {
        external.push(url.href);
        return route.abort();
      }
      if (path.endsWith('/model-catalog')) return route.fulfill({ json: chatCatalog });
      if (path === `${root}/github/chats/${chatId}/batches`) return route.fulfill({ json: { batches: [] } });
      if (path.startsWith(base)) {
        if (request.method() === 'PUT') {
          assert.ok(path.endsWith('/control'));
          const command = proposalControlSchema.parse(request.postDataJSON());
          assert.equal(command.digest, view.digest);
          assert.equal(command.operation, 'resume');
          commands.push(command);
          return route.fulfill({ status: 409, json: { error: view.plans[0].receipt.code } });
        }
        if (path.endsWith('/outcome')) return route.fulfill({ json: { kind: 'proposal' } });
        if (path.endsWith('/effects'))
          return route.fulfill({
            json: {
              digest: view.digest,
              total: 1,
              items: [{ ordinal: 0, effect }],
              nextCursor: null,
            },
          });
        return route.fulfill({ json: proposalViewSchema.parse(view) });
      }
      if (path === `${root}/conversations/${chatId}/messages`)
        return route.fulfill({
          json: {
            messages: [
              {
                id: id(63),
                sequence: 1,
                author: 'assistant',
                createdAt: date,
                parts: [{ kind: 'text', text: 'Review the member changes below.' }],
                turn: { id: turnId, status: 'completed', generation: 0 },
                tools: [{ id: proposalId, tool: 'tables.propose', status: 'completed' }],
              },
            ],
            nextBefore: null,
          },
        });
      if (path === `${root}/conversations/${chatId}`)
        return route.fulfill({
          json: {
            id: chatId,
            title: 'Member change review',
            titleRevision: 1,
            archived: false,
            activityAt: date,
            createdAt: date,
          },
        });
      return route.continue();
    });
    for (const [code, message, tableId, fieldId, recordId, value] of [
      [
        'member-inactive',
        'An inactive member cannot receive a new link. Choose an active member, or keep the existing links unchanged.',
        id(11),
        id(14),
        id(40),
        { kind: 'relationship', tableId: id(10), recordIds: [id(24)] },
      ],
      [
        'member-field-protected',
        'This member field is protected. Account name and photo come from the linked personal profile. Use member photo controls for a person without access.',
        id(10),
        workspaceMemberFields.accountEmail,
        id(22),
        { kind: 'text', value: 'different@example.test' },
      ],
    ]) {
      const response = await fetch(`${origin}${root}/tables/${tableId}`);
      assert.equal(response.status, 200);
      const { applied } = await response.json(),
        definition = applied.definition;
      effect = { kind: 'update', recordId, before: { [fieldId]: null }, after: { [fieldId]: value } };
      const input = {
        kind: 'records',
        tableId,
        dependsOn: [],
        expectedRevision: applied.revision,
        changes: [{ kind: 'update', recordId, values: effect.after }],
      };
      view = proposalViewSchema.parse({
        content: 'available',
        id: proposalId,
        digest: 'd'.repeat(64),
        status: 'failed',
        decision: 'approve',
        cancelled: false,
        expired: false,
        freshness: 'current',
        plans: [{ tableId, receipt: { status: 'failed', executionId: id(64), code }, importProgress: null }],
        manifest: {
          version: 1,
          id: proposalId,
          workspaceId,
          requester: { kind: 'human', userId: id(3), membershipId: id(4) },
          conversationId: chatId,
          turnId,
          sources: [],
          expiresAt: '2099-10-14T00:00:00.000Z',
          plans: [
            {
              input,
              before: definition,
              after: definition,
              effectCount: 1,
              effectsDigest: 'e'.repeat(64),
              freshnessDigest: 'f'.repeat(64),
              audience: null,
              importSources: [],
            },
          ],
        },
      });
      await page.goto(`${origin}/members-table-mock/chat/${chatId}`);
      const card = page.getByRole('region', { name: 'Table change proposal' });
      await card.getByText(`Failed. ${message} Completed tables are unchanged.`, { exact: true }).waitFor();
      assert.equal(await page.getByText('GitHub approvals unavailable', { exact: true }).count(), 0);
      await card.getByRole('button', { name: 'Resume unfinished work' }).click();
      await card.getByText(message, { exact: true }).waitFor();
      assert.equal(view.status, 'failed');
      assert.equal(await card.getByRole('heading', { name: 'Outcome not confirmed', exact: true }).count(), 0);
      for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (cdp) {
          attached = true;
          await promisify(execFile)('agent-browser', [
            '--session',
            session,
            '--no-auto-dialog',
            '--cdp',
            cdp,
            'screenshot',
            `/tmp/workspace-member-proposal-${code}-${width}.png`,
          ]);
        }
      }
      view.freshness = 'stale';
      await card.getByRole('button', { name: 'Check proposal status' }).click();
      await card.getByText(/Affected data or permissions changed/).waitFor();
      assert.ok(await card.getByRole('button', { name: 'Resume unfinished work' }).isDisabled());
      assert.equal(
        await card.getByText(`Failed. ${message} Completed tables are unchanged.`, { exact: true }).count(),
        1,
      );
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    assert.equal(commands.length, 2);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, [], 'all browser requests stay in the local fixture');
  } catch (error) {
    await page?.screenshot({ path: '/tmp/workspace-member-proposal-failure.png', fullPage: true });
    throw error;
  } finally {
    await browser?.close();
    if (attached) await promisify(execFile)('agent-browser', ['--session', session, 'close']);
    await server.close();
  }
});
