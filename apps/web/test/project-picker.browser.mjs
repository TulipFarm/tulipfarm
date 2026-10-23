import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';

test('composer project badge searches, recovers, and opens project creation', { timeout: 90000 }, async () => {
  const { workspace, session } = createWorkspaceFixture();
  const project = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Spring launch with a long project name for the whole team',
    instructions: '',
    revision: 1,
    archived: false,
    manager: true,
  };
  const archived = { ...project, id: '33333333-3333-4333-8333-333333333333', name: 'Previous launch', archived: true };
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const browser = await chromium.launch();
  try {
    for (const mobile of [false, true]) {
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
        hasTouch: mobile,
        isMobile: mobile,
        colorScheme: mobile ? 'dark' : 'light',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let gate = Promise.withResolvers();
      let status = 400;
      let projects = [];
      let creates = 0;
      let createStatus = 400;
      let createdProject = project;
      await page.route('**/v1/**', async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
        if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
        if (path === '/v1/feature-flags') return route.fulfill({ json: {} });
        if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
        if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
        if (path.endsWith('/governance/me')) return route.fulfill({ json: membership });
        if (path.endsWith('/credits')) return route.fulfill({ json: credits });
        if (path.endsWith('/model-catalog')) return route.fulfill({ json: chatCatalog });
        if (path.endsWith('/google-workspace/availability')) return route.fulfill({ json: { configured: false } });
        if (path.endsWith('/google-workspace')) return route.fulfill({ json: { status: 'disconnected' } });
        if (path.endsWith('/projects')) {
          await gate.promise;
          return route.fulfill({ status, json: status === 200 ? projects : { error: 'unavailable' } });
        }
        if (/\/projects\/[\w-]+$/.test(path)) {
          if (request.method() === 'PUT') {
            creates++;
            createdProject = { ...project, id: path.split('/').at(-1), name: request.postDataJSON().name };
            return route.fulfill({
              status: createStatus,
              json: createStatus === 200 ? createdProject : { error: 'invalid-project-name' },
            });
          }
          return route.fulfill({ json: { project: createdProject, members: [], files: [] } });
        }
        if (path.endsWith('/conversations')) return route.fulfill({ json: { chats: [], nextCursor: null } });
        if (path.endsWith('/candidates')) return route.fulfill({ json: [] });
        if (path.endsWith('/governance/directory')) return route.fulfill({ json: { members: [] } });
        if (path.endsWith('/last-used')) return route.fulfill({ status: 204 });
        if (path.endsWith('/bud'))
          return route.fulfill({
            json: {
              conversationId: null,
              onboarding: 'skipped',
              bubblesEnabled: false,
              snoozedUntil: null,
              nudge: null,
              preferences: [],
            },
          });
        if (path.endsWith('/recommendations') || path.endsWith('/recommendations/events'))
          return route.fulfill({ status: 503, json: { error: 'recommendations-unavailable' } });
        if (path.endsWith('/workspace-mcp/capabilities'))
          return route.fulfill({ status: 404, json: { error: 'not-found' } });
        if (path.endsWith('/github/accounts')) return route.fulfill({ json: { configured: false, accounts: [] } });
        if (path.endsWith('/atlassian/accounts')) return route.fulfill({ json: { accounts: [], providers: [] } });
        if (path.endsWith('/integrations')) return route.fulfill({ json: { integrations: [] } });
        if (path.endsWith('/slack/status'))
          return route.fulfill({
            json: { state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] },
          });
        throw new Error(`Unexpected API request ${path}`);
      });
      try {
        const origin = server.resolvedUrls.local[0];
        await page.goto(`${origin}${workspace.slug}`);
        const trigger = page.getByRole('button', { name: 'Start this chat in: Personal chats', exact: true });
        assert.equal(
          (await trigger.textContent()).trim(),
          'Personal chat',
          'no project names the personal-chat boundary (DESIGN.md)',
        );
        if (process.env.PROJECT_PICKER_SCREENSHOTS)
          await page.screenshot({
            path: `${process.env.PROJECT_PICKER_SCREENSHOTS}/project-icon-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
            fullPage: true,
          });
        await trigger.click();
        await page.getByText('Loading projects…', { exact: true }).waitFor();
        assert.equal(await page.getByText('No active projects yet.', { exact: false }).count(), 0);
        gate.resolve();
        await page.getByText('Could not load projects.', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Retry loading projects' }).click();
        await page.getByText('Could not load projects.', { exact: true }).waitFor();
        status = 200;
        await page.getByRole('button', { name: 'Retry loading projects' }).click();
        await page.getByText('No active projects yet. Create one for shared chats.', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'New project', exact: true }).click();
        await page.getByRole('dialog', { name: 'New project' }).waitFor();
        assert.equal(new URL(page.url()).pathname, `/${workspace.slug}/projects`);
        assert.equal(new URL(page.url()).searchParams.get('new'), 'true');
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        assert.equal(new URL(page.url()).search, '');

        projects = [project, archived];
        await page.goto(`${origin}${workspace.slug}`);
        await trigger.click();
        const search = page.getByRole('combobox', { name: 'Search projects' });
        await search.fill('no such project');
        await page.getByText('No matching projects.', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'New project', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Clear search', exact: true }).click();
        assert.equal(await search.evaluate(element => element === document.activeElement), true);
        await page.getByRole('option', { name: project.name, exact: true }).waitFor();
        assert.equal(await page.getByRole('option', { name: 'Previous launch', exact: false }).count(), 0);
        await search.fill('spring launch');
        await search.press('ArrowDown');
        await search.press('Enter');
        const selected = page.getByRole('button', { name: `Start this chat in: ${project.name}`, exact: true });
        await selected.waitFor();
        assert.equal(new URL(page.url()).searchParams.get('project'), project.id);
        assert.equal(await page.locator('select#new-chat-project').count(), 0);
        const composer = page.getByRole('form', { name: 'Message composer' });
        assert.equal(
          await composer.getByRole('button', { name: `Start this chat in: ${project.name}`, exact: true }).count(),
          1,
        );
        const attachBox = await composer.getByRole('button', { name: 'Add files and more' }).boundingBox();
        const projectBox = await selected.boundingBox();
        assert.ok(
          attachBox && projectBox && projectBox.x > attachBox.x && Math.abs(projectBox.y - attachBox.y) < 12,
          'badge sits on the same row as Add',
        );
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (process.env.PROJECT_PICKER_SCREENSHOTS)
          await page.screenshot({
            path: `${process.env.PROJECT_PICKER_SCREENSHOTS}/project-badge-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
            fullPage: true,
          });
        await selected.click();
        await search.fill('private');
        await search.press('Enter');
        await trigger.waitFor();
        assert.equal(new URL(page.url()).searchParams.has('project'), false);
        await trigger.click();
        await search.press('Escape');
        await page.getByRole('combobox', { name: 'Search projects' }).waitFor({ state: 'hidden' });
        assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
        await trigger.click();
        if (process.env.PROJECT_PICKER_SCREENSHOTS)
          await page.screenshot({
            path: `${process.env.PROJECT_PICKER_SCREENSHOTS}/project-menu-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
            fullPage: true,
          });
        await page.getByRole('button', { name: 'New project', exact: true }).click();
        await page.getByRole('textbox', { name: 'Project name' }).fill('New launch');
        await page.getByRole('button', { name: 'Create project', exact: true }).click();
        await page.getByRole('alert').waitFor();
        assert.equal(await page.getByRole('textbox', { name: 'Project name' }).inputValue(), 'New launch');
        assert.equal(creates, 1);
        createStatus = 200;
        await page.getByRole('button', { name: 'Create project', exact: true }).click();
        await page.getByRole('heading', { name: 'New launch', exact: true }).waitFor();
        assert.equal(new URL(page.url()).pathname, `/${workspace.slug}/projects/${createdProject.id}`);
        assert.equal(creates, 2);
        await page.getByRole('link', { name: 'Back to projects', exact: true }).click();
        await page.getByRole('button', { name: 'New project', exact: true }).click();
        await page.getByRole('dialog', { name: 'New project' }).waitFor();
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.getByRole('button', { name: 'New project', exact: true }).click();
        await page.getByRole('dialog', { name: 'New project' }).waitFor();
        assert.deepEqual(errors, []);
      } finally {
        gate.resolve();
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
