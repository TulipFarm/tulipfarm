import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';

test(
  'live sidebar reads lazily, links real items and recovers without leaking old access',
  { timeout: 120000 },
  async () => {
    const origin = 'http://127.0.0.1:5776';
    const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5776', '--strictPort'], {
      cwd: new URL('..', import.meta.url),
      stdio: 'ignore',
    });
    let browser;
    try {
      for (
        let attempt = 0;
        !(await fetch(origin).then(
          response => response.ok,
          () => false,
        ));
        attempt++
      ) {
        assert.ok(attempt < 150 && server.exitCode === null, 'server starts');
        await delay(100);
      }
      browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, reducedMotion: 'reduce' });
      await page.clock.install();
      const id = randomUUID(),
        slug = 'recent-sidebar',
        now = '2026-10-11T00:00:00Z';
      const workspace = {
        id,
        slug,
        name: 'Recent sidebar',
        status: 'ready',
        createdAt: now,
        soulCommit: 'a'.repeat(40),
      };
      // Chats and Agents are plain core links with eager Recents groups; these sections sit under More.
      const sections = { Workflows: 'workflows', Tables: 'tables', Files: 'files' };
      const items = Object.fromEntries(
        ['conversations', 'agents', ...Object.values(sections)].map(domain => [
          domain,
          Array.from({ length: 4 }, (_, i) => ({ id: randomUUID(), name: `${domain} ${i}` })),
        ]),
      );
      const pinned = new Set();
      const counts = {},
        status = {},
        errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      const summary = item => ({
        ...item,
        kind: 'file',
        parentId: null,
        creatorMembershipId: id,
        mediaType: 'text/plain',
        size: 12,
        trashed: false,
        role: 'manager',
      });
      await page.route('**/v1/**', async route => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname;
        const send = (body, code = 200) =>
          route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
        if (path === '/v1/auth/get-session')
          return send({
            session: { id: 'recent-test', userId: 'recent-test' },
            user: { id: 'recent-test', name: 'Local test', email: 'test@example.test' },
          });
        if (path === '/v1/user/visit') return send({ firstSession: false });
        if (path === '/v1/workspaces') return send([workspace]);
        if (path === `/v1/workspaces/${slug}`) return send(workspace);
        if (path.endsWith('/governance/me'))
          return send({
            membershipId: id,
            role: 'admin',
            teams: [],
            capabilities: { manageGovernance: true, canLeave: false },
          });
        if (path.endsWith('/credits'))
          return send({ available: 555, granted: 600, used: 45, held: 0, days: [], breakdown: [], series: [] });
        const base = `/v1/workspaces/${id}/`;
        const chat = item => ({
          id: item.id,
          title: item.name,
          titleRevision: 1,
          archived: false,
          pinned: pinned.has(item.id),
          activityAt: now,
          createdAt: now,
        });
        if (path === `${base}conversations/pinned`)
          return send({ chats: items.conversations.filter(item => pinned.has(item.id)).map(chat) });
        if (request.method() === 'PATCH' && path.startsWith(`${base}conversations/`)) {
          const body = request.postDataJSON();
          pinned[body.pinned ? 'add' : 'delete'](path.split('/').at(-1));
          return send({ pinned: body.pinned });
        }
        const domain = path.slice(base.length).split('/')[0];
        if (!path.startsWith(base) || !items[domain] || ![base + domain, base + domain + '/recent'].includes(path))
          return send({ error: 'not-found' }, 404);
        counts[domain] = (counts[domain] ?? 0) + 1;
        await delay(100);
        if (status[domain]) return send({ error: 'unavailable' }, status[domain]);
        if (domain === 'conversations') {
          assert.equal(url.searchParams.get('archived'), 'false');
          return send({ chats: items[domain].map(chat), nextCursor: null });
        }
        if (domain === 'tables') {
          assert.equal(url.searchParams.get('sort'), 'changed');
          assert.equal(url.searchParams.get('direction'), 'desc');
          return send({
            tables: items[domain].map(item => ({
              id: item.id,
              revision: 'a'.repeat(40),
              appliedAt: now,
              recordCount: '0',
              definition: {
                formatVersion: 2,
                id: item.id,
                owningTeamId: id,
                label: item.name,
                fields: [],
                uniqueKeys: [],
              },
            })),
            nextCursor: null,
          });
        }
        if (domain === 'files')
          return send(
            url.searchParams.has('after')
              ? { items: items.files.slice(1, 3).map(summary), next: null }
              : { items: [summary(items.files[0])], next: items.files[0].id },
          );
        return send(items[domain].slice(0, 3));
      });
      await page.goto(`${origin}/${slug}/integrations`);
      const nav = page.getByRole('navigation', { name: 'Workspace navigation', exact: true });
      // Chats and agents read their Recents groups as soon as the sidebar shows them.
      const group = label =>
        nav
          .locator('.sprout-sidebar-group')
          .filter({ has: page.locator('.sprout-sidebar-group-label', { hasText: new RegExp(`^${label}$`) }) })
          .getByRole('list');
      // Sprout's section list is unnamed, so find it inside the menu item that owns the section's toggle.
      const list = label =>
        nav
          .getByRole('listitem')
          .filter({ has: page.getByRole('button', { name: new RegExp(`^(Collapse|Expand) ${label}$`) }) })
          .getByRole('list');
      await nav.getByRole('button', { name: 'Expand Workflows', exact: true }).waitFor();
      await group('Recents').getByRole('link').nth(3).waitFor();
      await group('Recent agents').getByRole('link').nth(2).waitFor();
      assert.deepEqual(
        await group('Recents').getByRole('link').allTextContents(),
        items.conversations.map(item => item.name),
      );
      assert.equal(
        await group('Recents').getByRole('link').first().getAttribute('href'),
        `/${slug}/chat/${items.conversations[0].id}`,
      );
      assert.deepEqual(
        await group('Recent agents').getByRole('link').allTextContents(),
        items.agents.slice(0, 3).map(item => item.name),
      );
      assert.equal(
        await group('Recent agents').getByRole('link').first().getAttribute('href'),
        `/${slug}/agents/${items.agents[0].id}`,
      );
      assert.deepEqual(Object.keys(counts).sort(), ['agents', 'conversations'], 'closed sections do not fetch');
      for (const [label, domain] of Object.entries(sections)) {
        await nav.getByRole('button', { name: `Expand ${label}`, exact: true }).click();
        await list(label).getByRole('status').waitFor();
        await list(label).getByRole('link').nth(2).waitFor();
        assert.equal(await list(label).getByRole('link').count(), 3);
        assert.deepEqual(
          await list(label).getByRole('link').allTextContents(),
          items[domain].slice(0, 3).map(item => item.name),
        );
        assert.equal(
          await list(label).getByRole('link').first().getAttribute('href'),
          `/${slug}/${domain}/${items[domain][0].id}`,
        );
      }
      assert.equal(counts.files, 2, 'fills three entries across source-filtered file pages');
      for (const label of ['Chats', 'Agents', 'Integrations'])
        assert.equal(await nav.getByRole('button', { name: new RegExp(label) }).count(), 0);

      const pinnedChat = items.conversations[3];
      await nav.getByRole('link', { name: 'Chats', exact: true }).click();
      await page.getByRole('button', { name: `More actions for ${pinnedChat.name}`, exact: true }).click();
      await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
      await group('Pinned').getByRole('link', { name: pinnedChat.name, exact: true }).waitFor();
      assert.equal(await group('Pinned').getByRole('link').count(), 1, 'mutation updates the sidebar list');
      await group('Recents').getByRole('link', { name: pinnedChat.name, exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await group('Recents').getByRole('link').count(), 3, 'a pinned chat leaves Recents');
      await group('Pinned').getByRole('link').first().click();
      await page.waitForURL(`${origin}/${slug}/chat/${pinnedChat.id}`);
      assert.equal(await group('Pinned').getByRole('link').first().getAttribute('aria-current'), 'page');

      status.workflows = 503;
      await nav.getByRole('button', { name: 'Collapse Workflows', exact: true }).click();
      await page.clock.fastForward(61000);
      await nav.getByRole('button', { name: 'Expand Workflows', exact: true }).click();
      await list('Workflows').getByRole('alert').waitFor();
      assert.equal(await list('Workflows').getByRole('link').count(), 3, 'failed refresh retains useful entries');
      delete status.workflows;
      await list('Workflows').getByRole('button', { name: 'Try again', exact: true }).click();
      await list('Workflows').getByRole('alert').waitFor({ state: 'hidden' });
      status.workflows = 404;
      await nav.getByRole('button', { name: 'Collapse Workflows', exact: true }).click();
      await page.clock.fastForward(61000);
      await nav.getByRole('button', { name: 'Expand Workflows', exact: true }).click();
      await list('Workflows').getByText('Recent items are unavailable.', { exact: false }).waitFor();
      assert.equal(await list('Workflows').getByRole('link').count(), 0, 'denied reads remove protected names');
      status.agents = 404;
      const toggle = page.getByRole('button', { name: 'Toggle sidebar', exact: true });
      await toggle.click();
      await page.locator('[data-sprout-sidebar][data-state="collapsed"]').waitFor();
      await page.clock.fastForward(61000);
      await toggle.click();
      await page.locator('[data-sprout-sidebar][data-state="expanded"]').waitFor();
      await group('Recent agents').waitFor({ state: 'detached' });
      assert.equal(await nav.getByRole('link', { name: items.agents[0].name }).count(), 0, 'denied agents leave');

      delete status.workflows;
      status.tables = 503;
      items.workflows = [];
      await page.reload();
      await nav.getByRole('button', { name: 'More', exact: true }).click();
      await nav.getByRole('button', { name: 'Expand Tables', exact: true }).click();
      await list('Tables').getByRole('alert').waitFor();
      assert.equal(
        await list('Tables').getByRole('link').count(),
        3,
        'a reload keeps the saved entries beside the error',
      );
      delete status.tables;
      await list('Tables').getByRole('button', { name: 'Try again', exact: true }).click();
      await list('Tables').getByRole('link').nth(2).waitFor();
      await nav.getByRole('button', { name: 'Expand Workflows', exact: true }).click();
      await list('Workflows').getByText('No recent items yet.', { exact: false }).waitFor();
      assert.equal(await list('Workflows').getByRole('link').count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      server.kill('SIGTERM');
    }
  },
);
