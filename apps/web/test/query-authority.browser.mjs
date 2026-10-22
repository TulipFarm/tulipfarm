import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

test(
  'two-tab navigation retains caches; hidden integration changes resume running and idle chats; team rename retains data; skill disabling conceals remotely',
  { timeout: 90000 },
  async () => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { port: 0 },
      plugins: [
        {
          name: 'authority-regressions',
          configureServer(server) {
            server.middlewares.use('/authority-proof', async (_request, response) => {
              response.setHeader('Content-Type', 'text/html');
              response.end(await server.transformIndexHtml('/authority-proof', '<html><body></body></html>'));
            });
          },
        },
      ],
    });
    await server.listen();
    const browser = await chromium.launch();
    const errors = [];
    try {
      const context = await browser.newContext();
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
      const pages = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of pages) {
        await page.goto(`${server.resolvedUrls.local[0]}authority-proof`);
        await page.evaluate(async () => {
          const {
            React,
            createRoot,
            SessionQueryProvider,
            WorkspaceQueryProvider,
            useFeatureRead,
            useFeatureContext,
            featureKey,
            createWorkspaceAccess,
            useIntegrationChanges,
            useGoogleIntegration,
            useConversationHistory,
            useOwnMembership,
            useGovernanceChanges,
            useSkillApi,
            useSkillDetail,
          } = await import('/test/query-authority-fixture.tsx');
          const workspaceId = '11111111-1111-4111-8111-111111111111',
            membershipId = '22222222-2222-4222-8222-222222222222';
          const skillId = '33333333-3333-4333-8333-333333333333',
            teamId = '44444444-4444-4444-8444-444444444444';
          const identity = { userId: 'authority-proof', sessionId: 'session' };
          const scope = { kind: 'workspace', userId: identity.userId, workspaceId, membershipId };
          const state = {
            hidden: false,
            generation: 1,
            name: 'Original team',
            hold: false,
            disabled: false,
            failures: false,
            reads: {},
            notices: [],
            lost: [],
          };
          const pending = [];
          const count = name => {
            state.reads[name] = (state.reads[name] ?? 0) + 1;
          };
          const wait = async () => {
            if (state.hold) await new Promise(resolve => pending.push(resolve));
          };
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => (state.hidden ? 'hidden' : 'visible'),
          });
          const channel = new BroadcastChannel('tulipfarm:query:v1');
          channel.onmessage = event => state.notices.push(event.data);
          const receipt = {
            id: skillId,
            version: 1,
            savedRevision: 'a'.repeat(64),
            activeRevision: null,
            enabled: false,
          };
          window.fetch = async (url, init) => {
            const path = new URL(url).pathname;
            if (path.endsWith('/governance/me')) {
              count('membership');
              await wait();
              return Response.json({
                membershipId,
                role: 'admin',
                teams: [{ id: teamId, name: state.name }],
                capabilities: { manageGovernance: true, canLeave: true },
              });
            }
            if (path.endsWith('/google-workspace')) {
              count('integration');
              return Response.json({
                status: 'connected',
                integrationId: workspaceId,
                generation: state.generation,
                accountId: 'fixture',
                email: 'fixture@example.test',
                scopes: [],
              });
            }
            if (path.endsWith('/enabled')) {
              count('writes');
              return Response.json(receipt);
            }
            if (path.endsWith(`/skills/${skillId}`)) {
              count('skill');
              await wait();
              return state.disabled
                ? Response.json({ error: 'skill-unavailable' }, { status: 403 })
                : Response.json({
                    id: skillId,
                    revision: 'a'.repeat(64),
                    definition: { name: 'Private skill', instructions: 'PRIVATE SKILL BODY' },
                    reviewedDefinition: null,
                    management: receipt,
                    canReview: true,
                  });
            }
            throw new Error(`Unexpected request ${init?.method} ${path}`);
          };
          const access = createWorkspaceAccess();
          let selected = scope,
            admission;
          const open = next => {
            selected = next;
            admission = access.begin({ ...identity, slug: next.workspaceId });
            admission.admit({ pathname: `/${next.workspaceId}`, workspace: { id: next.workspaceId }, workspaces: [] });
          };
          open(scope);
          const root = createRoot(document.body.appendChild(document.createElement('div')));
          let runtime, changes, governance, skills;
          function Reader({ id }) {
            const read = useFeatureRead({
              key: ['navigation'],
              load: async () => {
                count(`navigation:${id}`);
                return `Workspace ${id}`;
              },
            });
            return React.createElement('output', { id: 'navigation' }, JSON.stringify(read.state));
          }
          function Chat({ id }) {
            const api = {
              history: async () => {
                count(id);
                const generation = state.generation;
                await wait();
                if (state.failures) throw Object.assign(new Error('Temporary failure'), { status: 422 });
                return {
                  chat: { id },
                  messages: [
                    {
                      id,
                      content: `PRIVATE CHAT ${id} ${generation}`,
                      turn: { id, status: id === 'running' ? 'processing' : 'completed', generation: 0 },
                    },
                  ],
                  nextCursor: null,
                };
              },
            };
            const read = useConversationHistory(api, id, 1, false);
            return React.createElement('output', { id }, JSON.stringify(read.state));
          }
          function Features() {
            runtime = useFeatureContext().runtime;
            changes = useIntegrationChanges();
            governance = useGovernanceChanges();
            const membership = useOwnMembership(workspaceId);
            useGoogleIntegration(workspaceId);
            skills = useSkillApi(workspaceId);
            const skill = useSkillDetail(skills, skillId);
            const resource = useFeatureRead({
              key: ['tables', 'list'],
              load: async () => {
                count('tables');
                await wait();
                return ['PRIVATE RECORD'];
              },
            });
            return React.createElement(
              React.Fragment,
              null,
              React.createElement('output', { id: 'membership' }, JSON.stringify(membership.state)),
              React.createElement('output', { id: 'skill' }, JSON.stringify(skill.state)),
              React.createElement('output', { id: 'tables' }, JSON.stringify(resource.state)),
              React.createElement(Chat, { id: 'running' }),
              React.createElement(Chat, { id: 'idle' }),
            );
          }
          const render = () => {
            const revision = admission.revision;
            root.render(
              React.createElement(
                SessionQueryProvider,
                { identity, onAuthorityLost: value => state.lost.push(value) },
                React.createElement(
                  WorkspaceQueryProvider,
                  {
                    scope: selected,
                    admitted: () =>
                      access.getSnapshot().kind === 'admitted' && access.getSnapshot().revision === revision,
                    subscribe: access.subscribe,
                  },
                  React.createElement(Reader, { id: selected.workspaceId }),
                  selected.workspaceId === workspaceId && React.createElement(Features),
                ),
              ),
            );
          };
          window.proof = {
            state,
            scope,
            featureKey,
            get runtime() {
              return runtime;
            },
            hide(value) {
              state.hidden = value;
              document.dispatchEvent(new Event('visibilitychange'));
              window.dispatchEvent(new Event('focus'));
            },
            navigate(other) {
              open(other ? { ...scope, workspaceId: 'other' } : scope);
              render();
            },
            rename() {
              state.name = 'Renamed team';
              return governance.saved(`/teams/${teamId}/name`, 'PUT', {
                name: state.name,
                description: '',
                expected: { name: 'Original team', description: '' },
              });
            },
            integration() {
              state.generation++;
              return changes.authority('google');
            },
            disable() {
              return skills.send(skillId, { kind: 'enable', enabled: false, requestId: teamId, expectedVersion: 0 });
            },
            release() {
              state.hold = false;
              pending.splice(0).forEach(resolve => resolve());
            },
            deny() {
              admission.deny(403);
            },
            close() {
              root.unmount();
              channel.close();
            },
          };
          render();
        });
        await page.waitForFunction(() =>
          ['navigation', 'membership', 'skill', 'tables', 'running', 'idle'].every(id =>
            document.getElementById(id)?.textContent.includes('"kind":"ready"'),
          ),
        );
      }
      const [first, second] = pages;
      // Admission revision changes must fence late work without publishing a denial.
      await first.evaluate(async () => {
        const { runtime, scope } = window.proof;
        await runtime.catalog.save(scope, { families: [] }, Date.now(), () => true);
        window.proof.navigate(true);
      });
      await first.waitForFunction(() => document.getElementById('navigation')?.textContent.includes('Workspace other'));
      assert.deepEqual(
        await second.evaluate(() => ({
          lost: window.proof.state.lost,
          denied: window.proof.state.notices.filter(event => event.kind === 'denied'),
        })),
        { lost: [], denied: [] },
      );
      assert.equal(
        await second
          .locator('#skill')
          .textContent()
          .then(text => text.includes('PRIVATE SKILL BODY')),
        true,
      );
      assert.deepEqual(
        await first.evaluate(
          async () => (await window.proof.runtime.catalog.restore(window.proof.scope, () => true))?.data,
        ),
        { families: [] },
      );
      await first.evaluate(() => window.proof.navigate(false));
      await first.waitForFunction(() =>
        document.getElementById('navigation')?.textContent.includes(window.proof.scope.workspaceId),
      );
      assert.equal(
        await first.evaluate(() => window.proof.state.reads[`navigation:${window.proof.scope.workspaceId}`]),
        1,
        'returning to the workspace reuses the fresh cache',
      );

      // Rename changes membership display data, never its access binding.
      for (const page of pages)
        await page.evaluate(() => {
          window.proof.hide(true);
          window.proof.state.name = 'Renamed team';
          window.proof.state.hold = true;
        });
      await first.evaluate(() => window.proof.rename());
      await second.waitForFunction(() =>
        window.proof.state.notices.some(event => event.keys.some(key => key[0] === 'governance')),
      );
      for (const page of pages) {
        assert.match(await page.locator('#tables').textContent(), /PRIVATE RECORD/);
        assert.match(await page.locator('#skill').textContent(), /PRIVATE SKILL BODY/);
        await page.evaluate(() => window.proof.release());
      }
      await second.evaluate(async () => {
        window.proof.hide(false);
        await window.proof.runtime.client.refetchQueries({
          predicate: query => query.queryKey.includes('membership') && query.queryKey.includes('governance'),
        });
      });
      assert.match(await second.locator('#membership').textContent(), /Renamed team/);
      assert.match(await second.locator('#tables').textContent(), /PRIVATE RECORD/);
      assert.equal(
        await second.evaluate(() => window.proof.state.reads.tables),
        1,
        'successful rename revalidation does not conceal/refetch unrelated dependents',
      );

      // A remote integration change conceals both running and idle chat queries while hidden.
      await second.evaluate(() => {
        window.proof.hide(true);
        window.proof.state.generation = 2;
      });
      await first.evaluate(() => window.proof.integration());
      await second.waitForFunction(() =>
        ['running', 'idle'].every(id => document.getElementById(id)?.textContent === '{"kind":"loading"}'),
      );
      const beforeResume = await second.evaluate(() => ({
        running: window.proof.state.reads.running,
        idle: window.proof.state.reads.idle,
      }));
      await second.waitForTimeout(2200);
      assert.deepEqual(
        await second.evaluate(() => ({
          running: window.proof.state.reads.running,
          idle: window.proof.state.reads.idle,
        })),
        beforeResume,
        'hidden concealment starts no reads',
      );
      await second.evaluate(() => {
        window.proof.state.hold = true;
        window.proof.hide(false);
      });
      await second.waitForTimeout(300);
      assert.deepEqual(
        await second.evaluate(() => ({
          running: window.proof.state.reads.running,
          idle: window.proof.state.reads.idle,
        })),
        beforeResume,
        'visibility return waits the 500 ms chat polling interval',
      );
      await second.waitForFunction(
        before =>
          window.proof.state.reads.running === before.running + 1 && window.proof.state.reads.idle === before.idle + 1,
        beforeResume,
      );
      await second.evaluate(() => window.proof.release());
      await second.waitForFunction(() =>
        ['running', 'idle'].every(id => document.getElementById(id)?.textContent.includes(`PRIVATE CHAT ${id} 2`)),
      );
      await second.waitForFunction(before => window.proof.state.reads.running === before.running + 2, beforeResume);
      assert.equal(
        await second.evaluate(() => window.proof.state.reads.idle),
        beforeResume.idle + 1,
        'idle revalidation is one-shot while running chat resumes polling',
      );
      await second.evaluate(() => window.proof.hide(true));
      const settledNotices = await second.evaluate(() => window.proof.state.notices.length);
      await second.waitForTimeout(250);
      assert.equal(
        await second.evaluate(() => window.proof.state.notices.length),
        settledNotices,
        'received authority changes do not echo',
      );

      // Disabling through the real skill API conceals another tab before its held read completes.
      await first.evaluate(() => {
        window.proof.hide(true);
        window.proof.state.disabled = true;
      });
      await second.evaluate(() => {
        window.proof.state.disabled = true;
        window.proof.state.hold = true;
      });
      const skillReads = await second.evaluate(() => window.proof.state.reads.skill);
      const concealBaseline = await second.evaluate(
        () => window.proof.state.notices.filter(event => event.kind === 'conceal').length,
      );
      await first.evaluate(() => window.proof.disable());
      await second.waitForFunction(() => document.getElementById('skill')?.textContent === '{"kind":"loading"}');
      assert.equal(
        await second.evaluate(() =>
          window.proof.runtime.client
            .getQueryCache()
            .getAll()
            .some(query => JSON.stringify(query.state.data)?.includes('PRIVATE SKILL BODY')),
        ),
        false,
      );
      const notices = await second.evaluate(
        baseline => window.proof.state.notices.filter(event => event.kind === 'conceal').slice(baseline),
        concealBaseline,
      );
      assert.equal(notices.length, 1);
      assert.deepEqual(Object.keys(notices[0]).sort(), ['version', 'id', 'sessionId', 'scope', 'kind', 'keys'].sort());
      assert.equal(JSON.stringify(notices).includes('PRIVATE'), false);
      await second.evaluate(() => window.proof.hide(false));
      await second.waitForTimeout(1700);
      assert.equal(await second.evaluate(() => window.proof.state.reads.skill), skillReads);
      await second.waitForFunction(before => window.proof.state.reads.skill === before + 1, skillReads);
      assert.equal(await second.locator('#skill').textContent(), '{"kind":"loading"}');
      await second.evaluate(() => window.proof.release());
      await second.waitForFunction(() =>
        document.getElementById('skill')?.textContent.includes('"kind":"unavailable"'),
      );
      await second.waitForTimeout(2200);
      assert.equal(
        await second.evaluate(() => window.proof.state.reads.skill),
        skillReads + 1,
        'denial is neither retried nor polled',
      );
      assert.equal(await first.evaluate(() => window.proof.state.reads.writes), 1);
      assert.equal(
        await second.evaluate(() => window.proof.state.notices.filter(event => event.kind === 'conceal').length),
        concealBaseline + 1,
      );
      await first.evaluate(() => window.proof.deny());
      await second.waitForFunction(() => window.proof.state.lost.length === 1);
      assert.equal(
        await first.evaluate(async () => await window.proof.runtime.catalog.restore(window.proof.scope, () => true)),
        null,
        'real denial still clears persisted data',
      );
      for (const page of pages) await page.evaluate(() => window.proof.close());
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
