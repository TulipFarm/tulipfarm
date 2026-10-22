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
      const sections = {
        Chats: 'conversations',
        Projects: 'projects',
        Agents: 'agents',
        'My agent tasks': 'agent-tasks',
        Workflows: 'workflows',
        Tables: 'tables',
        Files: 'files',
      };
      const items = Object.fromEntries(
        Object.values(sections).map(domain => [
          domain,
          Array.from({ length: 4 }, (_, i) => ({ id: randomUUID(), name: `${domain} ${i}` })),
        ]),
      );
      const projects = items.projects.map(item => ({
        ...item,
        instructions: '',
        revision: 1,
        archived: false,
        manager: true,
      }));
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
        if (path.startsWith(`${base}projects/`)) {
          const projectId = path.split('/').at(-1);
          if (request.method() === 'PUT') {
            const project = {
              id: projectId,
              name: request.postDataJSON().name,
              instructions: '',
              revision: 1,
              archived: false,
              manager: true,
            };
            projects.unshift(project);
            return send(project);
          }
          const project = projects.find(item => item.id === projectId);
          if (project) return send({ project, members: [], files: [] });
        }
        const domain = path.slice(base.length).split('/')[0];
        if (!path.startsWith(base) || !items[domain] || ![base + domain, base + domain + '/recent'].includes(path))
          return send({ error: 'not-found' }, 404);
        counts[domain] = (counts[domain] ?? 0) + 1;
        await delay(100);
        if (status[domain]) return send({ error: 'unavailable' }, status[domain]);
        if (domain === 'projects') return send(projects);
        if (domain === 'conversations') {
          assert.equal(url.searchParams.get('archived'), 'false');
          return send({
            chats: items[domain].map(item => ({
              id: item.id,
              title: item.name,
              titleRevision: 1,
              archived: false,
              activityAt: now,
              createdAt: now,
            })),
            nextCursor: null,
          });
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
      await nav.getByRole('button', { name: 'Expand Chats', exact: true }).waitFor();
      assert.deepEqual(counts, {}, 'closed sections do not fetch');
      const list = label => nav.getByRole('list', { name: `Recent ${label.toLowerCase()}`, exact: true });
      for (const [label, domain] of Object.entries(sections)) {
        await nav.getByRole('button', { name: `Expand ${label}`, exact: true }).click();
        await list(label).getByRole('status').waitFor();
        await list(label).getByRole('link').nth(2).waitFor();
        assert.equal(await list(label).getByRole('link').count(), 3);
        assert.deepEqual(
          await list(label).getByRole('link').allTextContents(),
          items[domain].slice(0, 3).map(item => item.name),
        );
        const path = domain === 'conversations' ? 'chat' : domain;
        const expected = `/${slug}/${path}${domain === 'workflows' ? '?workflow=' : '/'}${items[domain][0].id}`;
        assert.equal(await list(label).getByRole('link').first().getAttribute('href'), expected);
      }
      assert.equal(counts.files, 2, 'fills three entries across source-filtered file pages');
      for (const label of ['Skills', 'Integrations'])
        assert.equal(await nav.getByRole('button', { name: new RegExp(label) }).count(), 0);
      await nav.getByRole('link', { name: 'Projects', exact: true }).click();
      await page.getByRole('button', { name: 'New project', exact: true }).click();
      await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Newest project');
      await page.getByRole('button', { name: 'Create project', exact: true }).click();
      await list('Projects').getByRole('link', { name: 'Newest project', exact: true }).waitFor();
      assert.equal(await list('Projects').getByRole('link').count(), 3, 'mutation invalidates the sidebar list');
      assert.equal(await list('Projects').getByRole('link').first().getAttribute('aria-current'), 'page');

      status.agents = 503;
      await nav.getByRole('button', { name: 'Collapse Agents', exact: true }).click();
      await page.clock.fastForward(61000);
      await nav.getByRole('button', { name: 'Expand Agents', exact: true }).click();
      await list('Agents').getByRole('alert').waitFor();
      assert.equal(await list('Agents').getByRole('link').count(), 3, 'failed refresh retains useful entries');
      delete status.agents;
      await list('Agents').getByRole('button', { name: 'Try again', exact: true }).click();
      await list('Agents').getByRole('alert').waitFor({ state: 'hidden' });
      status.agents = 404;
      await nav.getByRole('button', { name: 'Collapse Agents', exact: true }).click();
      await page.clock.fastForward(61000);
      await nav.getByRole('button', { name: 'Expand Agents', exact: true }).click();
      await list('Agents').getByText('Recent items are unavailable.', { exact: false }).waitFor();
      assert.equal(await list('Agents').getByRole('link').count(), 0, 'denied reads remove protected names');
      status['agent-tasks'] = 503;
      items.workflows = [];
      await page.reload();
      await nav.getByRole('button', { name: 'Expand My agent tasks', exact: true }).click();
      await list('My agent tasks').getByRole('alert').waitFor();
      assert.equal(
        await list('My agent tasks').getByRole('link').count(),
        0,
        'initial error does not masquerade as empty',
      );
      delete status['agent-tasks'];
      await list('My agent tasks').getByRole('button', { name: 'Try again', exact: true }).click();
      await list('My agent tasks').getByRole('link').nth(2).waitFor();
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
