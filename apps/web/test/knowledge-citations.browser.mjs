import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { createWorkspaceFixture, serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';

const port = Number(process.env.KNOWLEDGE_CITATION_PORT ?? 5398);
const origin = `http://127.0.0.1:${port}`;
const screenshots = process.env.KNOWLEDGE_CITATION_SCREENSHOTS;
const cdp = process.env.KNOWLEDGE_CITATION_CDP_PORT;
const id = '11111111-1111-4111-8111-111111111111';
const answerId = '22222222-2222-4222-8222-222222222222';
const revokedId = '33333333-3333-4333-8333-333333333333';
const citation = '44444444-4444-4444-8444-444444444444:0';
const addId = '55555555-5555-4555-8555-555555555555';
const removeId = '66666666-6666-4666-8666-666666666666';
const documentId = '77777777-7777-4777-8777-777777777777';
const narratedId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const narration = 'Using source: Suppliers are paid within 30 days.';
const recovery =
  'This reply is unavailable because a knowledge source it cited changed or your access to it ended. Search knowledge again to make a new request.';
const removedReply =
  'This reply is unavailable because a Knowledge source it used was removed or replaced by you. Make a new request to use current Knowledge.';
const { workspace, session } = createWorkspaceFixture({ slug: 'knowledge-demo', name: 'Knowledge demo' });
const chat = {
  id,
  title: 'Supplier terms',
  titleRevision: 1,
  archived: false,
  activityAt: workspace.createdAt,
  createdAt: workspace.createdAt,
};

test(
  'chat answers render checked knowledge citations with loading, revoked, error and retained-answer recovery states',
  { timeout: 180000 },
  async t => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port, strictPort: true },
    });
    await server.listen();
    let browser;
    try {
      if (screenshots) await mkdir(screenshots, { recursive: true });
      browser = await chromium.launch({
        headless: process.env.KNOWLEDGE_CITATION_HEADED !== '1',
        args: cdp ? [`--remote-debugging-port=${cdp}`] : [],
      });
      for (const mobile of [false, true])
        await t.test(mobile ? 'mobile dark' : 'desktop light', async () => {
          const context = await browser.newContext({
            viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
            isMobile: mobile,
            hasTouch: mobile,
            colorScheme: mobile ? 'dark' : 'light',
            reducedMotion: 'reduce',
          });
          const page = await context.newPage();
          const capture = async name => {
            if (!screenshots) return;
            const path = join(screenshots, `${name}.png`);
            if (cdp)
              execFileSync(
                'agent-browser',
                ['--session', `knowledge-citation-${cdp}`, '--cdp', cdp, 'screenshot', path],
                { stdio: 'pipe', timeout: 15000 },
              );
            else await page.screenshot({ path });
          };
          page.setDefaultTimeout(30000);
          const errors = [];
          page.on('pageerror', error => errors.push(String(error)));
          const state = { citation: 'ready', source: 'note', gate: null, reads: [], removed: false };
          const failures = [];
          page.on('response', response => {
            if (/\/conversations\/[^/]+\/(messages|drafts\/)/.test(response.url()) && response.status() >= 400)
              failures.push([response.status(), new URL(response.url()).pathname]);
          });
          await context.route('**/v1/**', async route => {
            const path = new URL(route.request().url()).pathname;
            if (await serveWorkspaceShellEvent(route, workspace)) return;
            const shell = workspaceShellReads(workspace.id).find(([url]) => url === path);
            if (shell) return route.fulfill({ json: shell[1] });
            let json;
            if (path === '/v1/auth/get-session') json = session;
            else if (path === '/v1/workspaces') json = [workspace];
            else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
            else if (path.endsWith('/governance/me'))
              json = {
                membershipId: id,
                role: 'member',
                teams: [],
                capabilities: { manageGovernance: false, canLeave: true },
              };
            else if (path.endsWith('/model-catalog')) json = chatCatalog;
            else if (path.endsWith('/google-workspace/availability')) json = { configured: false };
            else if (path.endsWith('/github/accounts')) json = { configured: true, accounts: [] };
            else if (path.endsWith('/slack/status'))
              json = { state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] };
            else if (path.endsWith('/atlassian/accounts')) json = { accounts: [], providers: [] };
            else if (path.endsWith('/system-package-installations')) json = { installations: [], nextCursor: null };
            else if (path.includes('/knowledge/citations/')) {
              state.reads.push(decodeURIComponent(path.split('/').at(-1)));
              await state.gate?.promise;
              if (state.citation === 'revoked')
                return route.fulfill({ status: 404, json: { error: 'knowledge-not-found' } });
              if (state.citation === 'error')
                return route.fulfill({ status: 503, json: { error: 'knowledge-unavailable' } });
              json = {
                citationId: citation,
                title: 'Supplier policy',
                heading: 'Payments',
                text: 'Suppliers are paid within 30 days of delivery.',
                truncated: false,
                source: state.source,
              };
            } else if (path.endsWith(`/drafts/${removeId}/decision`)) {
              assert.equal(route.request().method(), 'PUT');
              assert.equal(route.request().postDataJSON().decision, 'save');
              state.removed = true;
              json = { kind: 'knowledge', operation: 'remove', documentId };
            } else if (path.endsWith(`/drafts/${addId}`) || path.endsWith(`/drafts/${removeId}`)) {
              const added = path.endsWith(addId);
              const operation = added ? 'add' : 'remove';
              const settled = added || state.removed;
              json = {
                id: added ? addId : removeId,
                digest: 'd'.repeat(64),
                status: settled ? 'saved' : 'pending',
                outcome: settled ? { kind: 'knowledge', operation, documentId } : null,
                proposal: settled
                  ? { kind: 'knowledge-receipt', targetId: documentId, input: { operation, entry: 'note' } }
                  : {
                      kind: 'knowledge',
                      targetId: documentId,
                      input: {
                        operation: 'remove',
                        expectedRevisionId: addId,
                        title: 'Supplier policy',
                        entry: 'note',
                      },
                    },
              };
            } else if (path.endsWith('/messages'))
              json = {
                messages: [
                  {
                    id: '88888888-8888-4888-8888-888888888888',
                    sequence: 1,
                    author: 'assistant',
                    createdAt: workspace.createdAt,
                    parts: [{ kind: 'text', text: 'Good morning. This reply predates the Knowledge source.' }],
                    turn: null,
                    tools: [],
                  },
                  {
                    id,
                    sequence: 2,
                    author: 'human',
                    createdAt: workspace.createdAt,
                    parts: [{ kind: 'text', text: 'When do we pay suppliers?' }],
                    turn: { id, status: 'completed', generation: 0 },
                    tools: [
                      { id: addId, tool: 'knowledge.add', status: 'completed' },
                      { id, tool: 'knowledge.search', status: 'completed' },
                    ],
                  },
                  {
                    id: answerId,
                    sequence: 3,
                    author: 'assistant',
                    createdAt: workspace.createdAt,
                    parts: [
                      {
                        kind: 'text',
                        text: state.removed
                          ? removedReply
                          : `Suppliers are paid within 30 days [Supplier policy](#knowledge-citation=${citation}).`,
                      },
                    ],
                    turn: null,
                    tools: [],
                  },
                  {
                    id: revokedId,
                    sequence: 4,
                    author: 'assistant',
                    createdAt: workspace.createdAt,
                    parts: [{ kind: 'text', text: recovery }],
                    turn: null,
                    tools: [],
                  },
                  {
                    id: narratedId,
                    sequence: 5,
                    author: 'human',
                    createdAt: workspace.createdAt,
                    parts: [{ kind: 'text', text: 'Check the table definitions.' }],
                    turn: { id: narratedId, status: 'completed', generation: 0 },
                    tools: [
                      {
                        id: narratedId,
                        tool: 'tables.definitions',
                        status: 'completed',
                        narration: state.removed ? null : narration,
                        presentation: { label: state.removed ? 'Used a tool' : narration, brand: null },
                      },
                    ],
                  },
                  {
                    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                    sequence: 6,
                    author: 'assistant',
                    createdAt: workspace.createdAt,
                    parts: [
                      {
                        kind: 'text',
                        text: state.removed ? removedReply : 'Suppliers are paid within 30 days.',
                      },
                    ],
                    turn: null,
                    tools: [],
                  },
                  {
                    id: '99999999-9999-4999-8999-999999999999',
                    sequence: 7,
                    author: 'human',
                    createdAt: workspace.createdAt,
                    parts: [{ kind: 'text', text: 'Remove the old supplier note.' }],
                    turn: { id: removeId, status: 'completed', generation: 0 },
                    tools: [{ id: removeId, tool: 'knowledge.remove', status: 'completed' }],
                  },
                ],
                nextBefore: null,
                hasGitHubProposals: false,
              };
            else if (/\/conversations\/[\w-]+$/.test(path)) json = chat;
            else return route.fulfill({ status: 404, json: { error: 'not-found' } });
            return route.fulfill({ json });
          });
          try {
            await page.goto(`${origin}/${workspace.slug}/chat/${id}`, { waitUntil: 'domcontentloaded' });
            await page.getByText(recovery, { exact: true }).waitFor({ timeout: 60000 });
            const trigger = page.getByRole('button', { name: 'Source: Supplier policy', exact: true });
            await trigger.waitFor();
            assert.deepEqual(state.reads, [], 'evidence is not read until the citation opens');

            state.gate = Promise.withResolvers();
            await trigger.click();
            await page.getByRole('status').filter({ hasText: 'Checking access to this source…' }).waitFor();
            if (!mobile) {
              await delay(16_000);
              await page.getByRole('status').filter({ hasText: 'Checking access to this source…' }).waitFor();
              await capture('citation-loading-after-16s');
            }
            state.gate.resolve();
            state.gate = null;
            await page.getByText('Suppliers are paid within 30 days of delivery.', { exact: true }).waitFor();
            await page.getByText('Note · Payments', { exact: true }).waitFor();
            await capture(mobile ? 'citation-mobile-ready' : 'citation-desktop-ready');
            assert.deepEqual(state.reads, [citation]);
            await page.keyboard.press('Escape');

            state.source = 'conversation';
            await trigger.click();
            await page.getByText('Chat recap · Payments', { exact: true }).waitFor();
            await page.getByText('Suppliers are paid within 30 days of delivery.', { exact: true }).waitFor();
            await page.keyboard.press('Escape');

            state.citation = 'revoked';
            await trigger.click();
            await page.getByText('Source unavailable', { exact: true }).waitFor();
            await page
              .getByRole('alert')
              .filter({ hasText: 'This source changed, was removed, or your access ended.' })
              .waitFor();
            assert.equal(
              await page.getByText('Suppliers are paid within 30 days of delivery.', { exact: true }).count(),
              0,
              'a revoked passage is not kept as fallback',
            );
            assert.equal(await page.getByRole('button', { name: 'Load source again' }).count(), 0);
            await page.keyboard.press('Escape');

            state.citation = 'error';
            await trigger.click();
            await page.getByText('Couldn’t load this source', { exact: true }).waitFor();
            state.citation = 'ready';
            await page.getByRole('button', { name: 'Load source again', exact: true }).click();
            await page.getByText('Suppliers are paid within 30 days of delivery.', { exact: true }).waitFor();
            assert.equal(
              state.reads.length,
              5,
              'each open and retry rechecks access, including chat-derived Knowledge',
            );
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            await page.keyboard.press('Escape');
            await page.getByRole('region', { name: 'Knowledge added' }).getByText('Added', { exact: true }).waitFor();
            const toolActivity = page
              .getByRole('listitem')
              .filter({ hasText: 'Check the table definitions.' })
              .getByRole('button', { name: /Tool activity.*1 tool/ });
            await toolActivity.click();
            await page.getByText(narration, { exact: true }).first().waitFor();
            await capture(mobile ? 'source-removal-mobile-before' : 'source-removal-desktop-before');
            await page
              .getByRole('region', { name: 'Review Knowledge remove' })
              .getByRole('button', { name: 'Remove', exact: true })
              .click();
            for (let reload = 0; reload < 2; reload++) {
              await page.getByRole('region', { name: 'Knowledge added' }).getByText('Added', { exact: true }).waitFor();
              await page
                .getByRole('region', { name: 'Knowledge removed' })
                .getByText('Removed', { exact: true })
                .waitFor();
              await page.getByText(removedReply, { exact: true }).first().waitFor();
              assert.equal(await page.getByText(removedReply, { exact: true }).count(), 2);
              assert.equal(await page.getByText('Suppliers are paid within 30 days.', { exact: true }).count(), 0);
              if ((await toolActivity.getAttribute('aria-expanded')) === 'false') await toolActivity.click();
              assert.equal(await page.getByText(narration, { exact: true }).count(), 0);
              await page.getByText('Used a tool', { exact: true }).waitFor();
              await page
                .getByText('Good morning. This reply predates the Knowledge source.', { exact: true })
                .waitFor();
              assert.equal(await page.getByRole('button', { name: 'Source: Supplier policy', exact: true }).count(), 0);
              if (!reload) await page.reload();
            }
            await capture(mobile ? 'source-removal-mobile-after' : 'source-removal-desktop-after');
            assert.deepEqual(failures, []);
            assert.deepEqual(errors, []);
          } catch (error) {
            await capture(mobile ? 'citation-mobile-failure' : 'citation-desktop-failure');
            console.error(errors);
            throw error;
          } finally {
            await context.close();
          }
        });
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);
