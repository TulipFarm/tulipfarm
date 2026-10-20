import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

const port = Number(process.env.KNOWLEDGE_CITATION_PORT ?? 5398);
const origin = `http://127.0.0.1:${port}`;
const screenshots = process.env.KNOWLEDGE_CITATION_SCREENSHOTS;
const cdp = process.env.KNOWLEDGE_CITATION_CDP_PORT;
const id = '11111111-1111-4111-8111-111111111111';
const answerId = '22222222-2222-4222-8222-222222222222';
const revokedId = '33333333-3333-4333-8333-333333333333';
const citation = '44444444-4444-4444-8444-444444444444:0';
const recovery =
  'This reply is unavailable because a knowledge source it cited changed or your access to it ended. Search knowledge again to make a new request.';
const { workspace, session } = createWorkspaceFixture({ slug: 'knowledge-qa', name: 'Knowledge QA' });
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
  { timeout: 120000 },
  async t => {
    const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: new URL('..', import.meta.url),
      stdio: 'ignore',
    });
    let browser;
    try {
      if (screenshots) await mkdir(screenshots, { recursive: true });
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
                ['--session', 'tulipfarm-knowledge-timeout', '--cdp', cdp, 'screenshot', path],
                { stdio: 'pipe', timeout: 15000 },
              );
            else await page.screenshot({ path });
          };
          page.setDefaultTimeout(10000);
          const errors = [];
          page.on('pageerror', error => errors.push(String(error)));
          const state = { citation: 'ready', source: 'note', gate: null, reads: [] };
          await context.route('**/v1/**', async route => {
            const path = new URL(route.request().url()).pathname;
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
            } else if (path.endsWith('/messages'))
              json = {
                messages: [
                  {
                    id,
                    sequence: 1,
                    author: 'human',
                    createdAt: workspace.createdAt,
                    parts: [{ kind: 'text', text: 'When do we pay suppliers?' }],
                    turn: { id, status: 'completed', generation: 0 },
                    tools: [{ id, tool: 'knowledge.search', status: 'completed' }],
                  },
                  {
                    id: answerId,
                    sequence: 2,
                    author: 'assistant',
                    createdAt: workspace.createdAt,
                    parts: [
                      {
                        kind: 'text',
                        text: `Suppliers are paid within 30 days [Supplier policy](#knowledge-citation=${citation}).`,
                      },
                    ],
                    turn: null,
                    tools: [],
                  },
                  {
                    id: revokedId,
                    sequence: 3,
                    author: 'assistant',
                    createdAt: workspace.createdAt,
                    parts: [{ kind: 'text', text: recovery }],
                    turn: null,
                    tools: [],
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
            await page.goto(`${origin}/${workspace.slug}/chat/${id}`);
            await page.getByText(recovery, { exact: true }).waitFor();
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
            assert.deepEqual(errors, []);
          } finally {
            await context.close();
          }
        });
    } finally {
      await browser?.close();
      server.kill('SIGTERM');
    }
  },
);
