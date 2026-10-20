import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { shellRead } from './shell-reads.mjs';

const skillId = '44444444-4444-4444-8444-444444444444';
const agentId = '55555555-5555-4555-8555-555555555555';
const coordinatorId = '66666666-6666-4666-8666-666666666666';
const missingId = '77777777-7777-4777-8777-777777777777';
const flakyId = '88888888-8888-4888-8888-888888888888';
const teamId = '33333333-3333-4333-8333-333333333333';
const membershipId = '22222222-2222-4222-8222-222222222222';
const revision = 'a'.repeat(64);
const procedure = { name: 'Qualify lead', instructions: 'Ask for company size, then budget.' };
const coordinator =
  'Regional renewal coordinator for enterprise accounts across North America, Europe, and Asia Pacific';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function skillServer() {
  const skill = { lifecycle: 'active', version: 2 };
  const receipts = new Map();
  const plans = [];
  const state = { deletion: 'deletable', writes: [], views: [] };
  const receipt = () => ({
    id: skillId,
    version: skill.version,
    savedRevision: revision,
    activeRevision: revision,
    enabled: skill.lifecycle !== 'deleted',
    ...(skill.lifecycle === 'active' ? {} : { lifecycle: skill.lifecycle }),
  });
  const item = { id: skillId, revision, name: procedure.name };
  return {
    state,
    plan: step => plans.push(step),
    list(view, search) {
      state.views.push(view);
      view ??= 'visible';
      const listed =
        (view === 'archived' ? skill.lifecycle === 'archived' : skill.lifecycle === 'active') &&
        procedure.name.toLowerCase().includes(search.toLowerCase());
      // Lists carry each skill's status, which defaults to enabled (cloud packages/agents/src/workspace-skill-contracts.ts:22).
      return {
        workspace: listed ? [{ ...item, status: skill.lifecycle === 'archived' ? 'archived' : 'enabled' }] : [],
        nextCursor: null,
      };
    },
    detail: () =>
      skill.lifecycle === 'deleted'
        ? null
        : {
            id: skillId,
            revision,
            definition: procedure,
            reviewedDefinition: procedure,
            source: 'workspace',
            management: receipt(),
            canReview: true,
            lifecycle: skill.lifecycle,
            canManageLifecycle: true,
          },
    deletion() {
      if (skill.lifecycle === 'deleted') return { status: 404, json: { error: 'skill-not-found' } };
      if (state.deletion === 'error') return { status: 500, json: { error: 'skill-operation-unavailable' } };
      const blocked = state.deletion === 'blocked';
      return {
        status: 200,
        json: {
          id: skillId,
          name: procedure.name,
          version: skill.version,
          lifecycle: skill.lifecycle,
          blockers: blocked
            ? [
                { agentId, name: 'Sales assistant', uses: ['active-revision'] },
                { agentId: coordinatorId, name: coordinator, uses: ['open-run', 'saved-definition'] },
              ]
            : [],
          hiddenAgents: blocked ? 1 : 0,
          blockerCount: blocked ? 5 : 0,
        },
      };
    },
    async lifecycle(body) {
      state.writes.push(body);
      const step = plans.shift();
      if (step?.gate) await step.gate;
      if (receipts.has(body.requestId)) return { status: 200, json: receipts.get(body.requestId) };
      if (step === 'in-use') {
        state.deletion = 'blocked';
        return { status: 409, json: { error: 'skill-in-use' } };
      }
      if (body.expectedVersion !== skill.version) return { status: 409, json: { error: 'version-conflict' } };
      skill.lifecycle = body.lifecycle;
      skill.version++;
      receipts.set(body.requestId, receipt());
      return { status: 200, json: receipts.get(body.requestId), lost: step === 'lost' };
    },
  };
}

test('people archive, restore, and delete a skill, and agents name an archived pin', { timeout: 240000 }, async () => {
  const { workspace, session } = createWorkspaceFixture();
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  const browser = await chromium.launch();
  const shots = process.env.SKILL_LIFECYCLE_SCREENSHOTS;
  if (shots) await mkdir(shots, { recursive: true });
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
      page.setDefaultTimeout(15000);
      const errors = [];
      const unexpected = [];
      page.on('pageerror', error => errors.push(error.message));
      const skills = skillServer();
      let flakyReads = 0;
      const base = `/v1/workspaces/${workspace.id}`;
      const agent = {
        id: agentId,
        name: 'Sales assistant',
        owningTeamId: teamId,
        savedRevision: 'b'.repeat(40),
        definitionRevision: 'c'.repeat(64),
        definition: {
          name: 'Sales assistant',
          instructions: 'Qualify inbound leads.',
          tools: [],
          skills: [
            { id: skillId, revision },
            { id: missingId, revision },
            { id: flakyId, revision },
          ],
        },
        capabilities: ['read', 'edit', 'invoke'],
        admin: false,
        activations: [],
      };
      await page.route('**/v1/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();
        const reply = (json, status = 200) => route.fulfill({ status, json });
        if (path === '/v1/auth/get-session') return reply(session);
        const shell = shellRead(method, path, workspace);
        if (shell) return route.fulfill(shell);
        if (path === '/v1/workspaces') return reply([workspace]);
        if (path === `/v1/workspaces/${workspace.slug}`) return reply(workspace);
        if (path === `${base}/governance/me`)
          return reply({
            membershipId,
            role: 'admin',
            teams: [{ id: teamId, name: 'Sales' }],
            capabilities: { manageGovernance: true, canLeave: true },
          });
        if (path === `${base}/credits`)
          return reply({ available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] });
        if (path === `${base}/workspace-mcp/capabilities`) return reply({ error: 'not-found' }, 404);
        if (path === `${base}/model-catalog`) return reply(chatCatalog);
        if (path === `${base}/tables`) return reply({ tables: [], total: 0, nextCursor: null });
        if (path === `${base}/skills` && method === 'GET')
          return reply(skills.list(url.searchParams.get('view'), url.searchParams.get('search') ?? ''));
        if (path === `${base}/skills/${missingId}`) return reply({ error: 'skill-not-found' }, 404);
        if (path === `${base}/skills/${flakyId}`) {
          flakyReads++;
          if (flakyReads <= 3) return reply({ error: 'skill-operation-unavailable' }, 503);
          return reply({
            id: flakyId,
            revision,
            definition: { name: 'Renewal check', instructions: 'Confirm the renewal date.' },
            reviewedDefinition: null,
            source: 'workspace',
            management: { id: flakyId, version: 1, savedRevision: revision, activeRevision: revision, enabled: false },
            canReview: false,
            lifecycle: 'active',
            canManageLifecycle: false,
          });
        }
        if (path === `${base}/skills/${skillId}` && method === 'GET') {
          const detail = skills.detail();
          return detail ? reply(detail) : reply({ error: 'skill-not-found' }, 404);
        }
        if (path === `${base}/skills/${skillId}/deletion` && method === 'GET') {
          const answer = skills.deletion();
          return reply(answer.json, answer.status);
        }
        if (path === `${base}/skills/${skillId}/lifecycle` && method === 'PUT') {
          const answer = await skills.lifecycle(request.postDataJSON());
          return answer.lost ? route.abort('failed') : reply(answer.json, answer.status);
        }
        if (path === `${base}/agents/authoring-context`)
          return reply({
            currentSoulRevision: agent.savedRevision,
            teams: [{ id: teamId, name: 'Sales' }],
            admin: false,
          });
        if (path === `${base}/agents/${agentId}` && method === 'GET') return reply(agent);
        if (path === `${base}/agents/${agentId}/chat`) return reply({ configured: true });
        // Skill detail reads its sharing (cloud features/skills/api.ts:49); the agent page reads sharing candidates, its setup draft and Slack channels (cloud features/agents/api.ts:41, pages/agents.tsx:190, features/integrations/slack-knowledge-api.ts:65).
        if (path === `${base}/skills/${skillId}/sharing` && method === 'GET')
          return reply({ version: 1, grants: [], personGrants: [] });
        if (path === `${base}/agents/${agentId}/setup-draft` && method === 'GET')
          return reply({ error: 'setup-draft-not-found' }, 404);
        if (path === `${base}/agents/sharing-candidates`)
          return reply({ membershipId, people: [], teams: [{ id: teamId, name: 'Sales' }] });
        if (path === `${base}/knowledge/slack/discover` && method === 'GET')
          return reply({
            binding: {
              installationId: agentId,
              installationGeneration: 1,
              identityId: agentId,
              slackUserId: 'UPROOF',
              teamId: 'TPROOF',
            },
            items: [],
            nextCursor: null,
          });
        unexpected.push(`${method} ${path}${url.search}`);
        return reply({ error: 'not-found' }, 404);
      });
      const text = value => page.getByText(value, { exact: true });
      const dialog = page.getByRole('dialog');
      const lastWrite = () => {
        const { requestId, ...rest } = skills.state.writes.at(-1);
        assert.match(requestId, uuid);
        return rest;
      };
      const shot = async name => {
        if (shots)
          await page.screenshot({
            path: `${shots}/${name}-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
            fullPage: true,
          });
      };
      const fits = async () =>
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          'no horizontal overflow',
        );
      try {
        await page.goto(`${origin}/${workspace.slug}/skills`);
        const activeToggle = page.getByRole('button', { name: 'Active skills', exact: true });
        const archivedToggle = page.getByRole('button', { name: 'Archived skills', exact: true });
        await page.getByRole('link', { name: procedure.name }).waitFor();
        assert.equal(await activeToggle.getAttribute('aria-pressed'), 'true');
        assert.equal(await archivedToggle.getAttribute('aria-pressed'), 'false');
        assert.equal(
          await page.getByRole('heading', { name: 'Built-in skills' }).count(),
          0,
          'built-in skills are hidden',
        );
        assert.equal(skills.state.views.at(-1), null, 'the active list sends no view');
        await archivedToggle.click();
        await page.getByRole('heading', { name: 'No archived skills' }).waitFor();
        await text('Skills you archive appear here. Open one to restore or delete it.').waitFor();
        assert.equal(skills.state.views.at(-1), 'archived', 'the archived list asks for view=archived');
        assert.equal(await archivedToggle.getAttribute('aria-pressed'), 'true');
        assert.equal(await activeToggle.getAttribute('aria-pressed'), 'false');
        assert.equal(
          await page.getByRole('heading', { name: 'Built-in skills' }).count(),
          0,
          'built-in skills stay hidden',
        );
        await fits();
        await shot('archived-empty');
        await page.getByRole('button', { name: 'Show active skills' }).click();
        await page.getByRole('link', { name: procedure.name }).waitFor();
        assert.equal(await activeToggle.getAttribute('aria-pressed'), 'true');
        assert.equal(
          await activeToggle.evaluate(node => node === document.activeElement),
          true,
          'focus moves to the Active toggle',
        );

        await page.getByRole('link', { name: procedure.name }).click();
        await page.getByRole('heading', { name: 'Archive or delete' }).waitFor();
        const held = Promise.withResolvers();
        skills.plan({ gate: held.promise });
        await page.getByRole('button', { name: 'Archive skill' }).dblclick();
        const archiving = page.getByRole('button', { name: 'Archiving skill…' });
        await archiving.waitFor();
        assert.equal(await archiving.getAttribute('aria-busy'), 'true');
        assert.equal(await archiving.isDisabled(), true);
        held.resolve();
        await page
          .getByRole('status')
          .filter({
            hasText: "Skill archived. It's hidden from skill lists and pickers. Agents that pin it keep working.",
          })
          .waitFor();
        assert.equal(skills.state.writes.length, 1, 'a double click sends one request');
        assert.deepEqual(lastWrite(), { expectedVersion: 2, lifecycle: 'archived' });
        await text(
          "This skill is archived. It's hidden from skill lists and pickers. Agents that pin it keep working.",
        ).waitFor();
        await text('Restore this skill to edit or review it.').waitFor();
        // Skills are edited in chat (cloud 9bb986c8, #808); archived skills offer no edit entry (cloud pages/skills.tsx:105-106).
        assert.equal(await page.getByRole('link', { name: 'Edit in chat', exact: true }).count(), 0);
        // The procedure is read-only text with no draft form (cloud pages/skills.tsx:108).
        assert.equal(
          await page.getByRole('region', { name: 'Procedure', exact: true }).getByRole('textbox').count(),
          0,
        );
        await page
          .getByRole('region', { name: 'Procedure', exact: true })
          .getByText(procedure.instructions, { exact: true })
          .waitFor();
        assert.equal(await page.getByRole('button', { name: 'Save draft' }).count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Review and enable' }).isDisabled(), true);
        assert.equal(
          await page.getByRole('button', { name: 'Disable skill' }).isDisabled(),
          false,
          'admins can still disable an archived skill',
        );
        await fits();
        await shot('archived-detail');

        await page.getByRole('link', { name: 'Back to skills' }).click();
        await archivedToggle.click();
        const archivedRow = page
          .getByRole('table', { name: 'Archived skills' })
          .getByRole('row')
          .filter({ hasText: procedure.name });
        await archivedRow.getByText('Archived', { exact: true }).waitFor();
        assert.equal(await page.getByRole('heading', { name: 'Built-in skills' }).count(), 0);
        await page.getByRole('searchbox', { name: 'Find skills' }).fill('zzz');
        await page.getByRole('heading', { name: 'No matching archived skills' }).waitFor();
        await page.getByRole('button', { name: 'Clear search', exact: true }).last().click();
        await archivedRow.waitFor();
        await page.getByRole('link', { name: procedure.name }).click();
        await page.getByRole('heading', { name: 'Restore or delete' }).waitFor();
        await page.getByRole('link', { name: 'Back to skills' }).click();
        await page.getByRole('table', { name: 'Archived skills' }).waitFor();
        assert.equal(
          await archivedToggle.getAttribute('aria-pressed'),
          'true',
          'the archived view survives navigating back',
        );
        await page.getByRole('link', { name: procedure.name }).click();

        await page.getByRole('button', { name: 'Restore skill' }).click();
        await page.getByRole('status').filter({ hasText: 'Skill restored.' }).waitFor();
        assert.deepEqual(lastWrite(), { expectedVersion: 3, lifecycle: 'active' });
        await text(
          "This skill is archived. It's hidden from skill lists and pickers. Agents that pin it keep working.",
        ).waitFor({ state: 'detached' });
        await page.getByRole('link', { name: 'Edit in chat', exact: true }).waitFor();

        skills.state.deletion = 'error';
        await page.getByRole('button', { name: 'Delete skill' }).click();
        await dialog.getByText('Checking where this skill is used…').waitFor();
        await dialog.getByText("Couldn't check where this skill is used.").waitFor();
        skills.state.deletion = 'blocked';
        await dialog.getByRole('button', { name: 'Check again' }).click();
        await dialog.getByText("“Qualify lead” can't be deleted").waitFor();
        await dialog
          .getByText(
            'Agents use this skill. Deleting it would stop them. Archive it to hide it from lists and pickers while those agents keep working.',
          )
          .waitFor();
        const agents = dialog.getByRole('list', { name: 'Agents that use this skill' });
        assert.deepEqual(await agents.getByRole('listitem').allTextContents(), [
          'Sales assistantActive version pins this skill',
          `${coordinator}A run in progress uses this skillSaved version pins this skill`,
        ]);
        assert.equal(
          await agents.getByRole('link', { name: 'Sales assistant' }).getAttribute('href'),
          `/${workspace.slug}/agents/${agentId}`,
        );
        await dialog.getByText("1 agent you can't open also uses this skill.").waitFor();
        await dialog.getByText('And 2 more agents.').waitFor();
        assert.equal(
          await dialog.getByRole('button', { name: 'Delete skill' }).count(),
          0,
          'a blocked skill offers no delete',
        );
        await fits();
        await shot('delete-blocked');
        await dialog.getByRole('button', { name: 'Archive instead' }).click();
        await dialog.waitFor({ state: 'detached' });
        await page
          .getByRole('status')
          .filter({
            hasText: "Skill archived. It's hidden from skill lists and pickers. Agents that pin it keep working.",
          })
          .waitFor();
        assert.deepEqual(lastWrite(), { expectedVersion: 4, lifecycle: 'archived' });

        skills.state.deletion = 'deletable';
        skills.plan('in-use');
        await page.getByRole('button', { name: 'Delete skill' }).click();
        await dialog.getByText('Delete “Qualify lead”?').waitFor();
        await dialog
          .getByText(
            "This can't be undone. The skill leaves lists, pickers, and new chats. Sent messages keep its name.",
          )
          .waitFor();
        await shot('delete-confirm');
        await dialog.getByRole('button', { name: 'Delete skill' }).click();
        await dialog.getByText("Agents now use this skill, so it wasn't deleted. Archive it instead.").waitFor();
        await dialog.getByText("“Qualify lead” can't be deleted").waitFor();
        await dialog.getByText("It's already archived.").waitFor();
        assert.equal(
          await dialog.getByRole('button', { name: 'Archive instead' }).count(),
          0,
          'an archived skill is not offered archive again',
        );
        assert.deepEqual(lastWrite(), { expectedVersion: 5, lifecycle: 'deleted' });

        await agents.getByRole('link', { name: 'Sales assistant' }).click();
        await page.waitForURL(new RegExp(`/agents/${agentId}$`));
        await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
        const selected = page.getByRole('list', { name: 'Selected skills' }).getByRole('listitem');
        const flaky = selected.nth(2);
        await flaky.getByText('Loading skill name…', { exact: true }).waitFor();
        await selected.nth(0).getByText(procedure.name, { exact: true }).waitFor();
        await selected.nth(0).getByText('Archived', { exact: true }).waitFor();
        await page.getByRole('button', { name: `Remove skill ${procedure.name}`, exact: true }).waitFor();
        assert.equal(
          await selected.nth(0).getByText(skillId).count(),
          0,
          'the pinned skill is named, not shown as an id',
        );
        await selected.nth(1).getByText('Unavailable skill', { exact: true }).waitFor();
        await selected.nth(1).getByText(missingId, { exact: true }).waitFor();
        await page.getByRole('button', { name: `Remove skill ${missingId}`, exact: true }).waitFor();
        await flaky.getByRole('button', { name: 'Retry skill name' }).click();
        await flaky.getByText('Renewal check', { exact: true }).waitFor();
        await flaky.getByText('Disabled', { exact: true }).waitFor();
        assert.equal(
          await flaky.getByText('Archived', { exact: true }).count(),
          0,
          'an active pin has no Archived badge',
        );
        assert.equal(
          await selected.nth(0).getByText('Disabled', { exact: true }).count(),
          0,
          'an enabled pin has no Disabled badge',
        );
        await page.getByRole('button', { name: 'Remove skill Renewal check', exact: true }).waitFor();
        assert.equal(
          await page
            .locator('[data-slot="page-content"]')
            .locator('..')
            .evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth)),
          true,
          'the picker fits its scroll container',
        );
        await page.getByRole('region', { name: 'Agent skills' }).scrollIntoViewIfNeeded();
        await shot('agent-pin');
        await page.goBack();
        await page.getByRole('heading', { name: 'Restore or delete' }).waitFor();

        skills.state.deletion = 'deletable';
        skills.plan('lost');
        await page.getByRole('button', { name: 'Delete skill' }).click();
        await dialog.getByText('Delete “Qualify lead”?').waitFor();
        await dialog.getByRole('button', { name: 'Delete skill' }).click();
        const retry = dialog.getByRole('button', { name: 'Retry same operation' });
        await retry.waitFor();
        await dialog
          .getByText(
            'We could not confirm the outcome. Your input is kept here. Check status before trying the same operation again.',
          )
          .waitFor();
        const lost = skills.state.writes.at(-1);
        assert.deepEqual(lastWrite(), { expectedVersion: 5, lifecycle: 'deleted' });
        await shot('delete-uncertain');
        await dialog.getByRole('button', { name: 'Check status again' }).click();
        await dialog.getByText('This skill was deleted or you can no longer manage it.').waitFor();
        assert.equal(
          await dialog.getByRole('button', { name: 'Cancel' }).count(),
          0,
          'an unavailable skill offers Close',
        );
        await retry.click();
        await page.waitForURL(new RegExp(`/${workspace.slug}/skills$`));
        assert.deepEqual(skills.state.writes.at(-1), lost, 'the retry reuses the same requestId');
        await page.waitForFunction(
          () => document.activeElement?.tagName === 'H1' && document.activeElement.textContent === 'Skills',
        );
        await page.getByRole('heading', { name: 'No archived skills' }).waitFor();
        await fits();
        await shot('deleted');
        assert.deepEqual(unexpected, []);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
