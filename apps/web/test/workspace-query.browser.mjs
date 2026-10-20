import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

test(
  'workspace queries share membership, isolate account setup, conceal revoked data and exclude invitation secrets',
  { timeout: 90_000 },
  async () => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { port: 0 },
      plugins: [
        {
          name: 'workspace-query-test',
          configureServer(server) {
            server.middlewares.use('/workspace-query-test', async (_request, response) => {
              response.setHeader('Content-Type', 'text/html');
              response.end(await server.transformIndexHtml('/workspace-query-test', '<html><body></body></html>'));
            });
          },
        },
      ],
    });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`${server.resolvedUrls.local[0]}workspace-query-test`);
      const result = await page.evaluate(async () => {
        const {
          React,
          createRoot,
          SessionQueryProvider,
          WorkspaceQueryProvider,
          featureKey,
          useFeatureContext,
          useOwnMembership,
          useWorkspaceSettings,
          useInvitations,
          useWorkspaceSetup,
          useGovernanceChanges,
          governanceKeys,
        } = await import('/test/workspace-query-fixture.tsx');
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const wait = async predicate => {
          for (let i = 0; i < 400 && !predicate(); i++) await sleep(10);
          if (!predicate()) throw new Error(`Timed out: ${document.body.textContent}`);
        };
        const workspaceId = '11111111-1111-4111-8111-111111111111';
        const membershipId = '22222222-2222-4222-8222-222222222222';
        const scope = { kind: 'workspace', userId: 'alice', workspaceId, membershipId };
        const identity = { userId: 'alice', sessionId: 'session' };
        const calls = { membership: 0, settings: 0, invitations: 0, setup: 0 };
        let release,
          hold = false;
        window.fetch = async url => {
          const path = new URL(url).pathname;
          if (path.endsWith('/governance/me')) {
            calls.membership++;
            return Response.json({
              membershipId,
              role: 'admin',
              teams: [],
              capabilities: { manageGovernance: true, canLeave: true },
            });
          }
          if (path.endsWith('/settings')) {
            calls.settings++;
            return Response.json({ workspaceId, name: 'Acme', slug: 'acme', revision: 0, canManage: true });
          }
          if (path.includes('/workspace-setups/')) {
            calls.setup++;
            return Response.json({ id: workspaceId, stage: 'ready', error: null });
          }
          calls.invitations++;
          if (hold)
            await new Promise(resolve => {
              release = resolve;
            });
          return Response.json({ items: [], nextCursor: null });
        };
        let runtime, invitations, changes;
        function Account() {
          runtime = useFeatureContext().runtime;
          const read = useWorkspaceSetup(workspaceId);
          return React.createElement('output', null, JSON.stringify(read.state));
        }
        function Membership() {
          const read = useOwnMembership(workspaceId);
          return React.createElement('output', null, JSON.stringify(read.state));
        }
        function Settings() {
          const read = useWorkspaceSettings(workspaceId);
          changes = useGovernanceChanges();
          return React.createElement('output', null, JSON.stringify(read.state));
        }
        function Invitations() {
          invitations = useInvitations(workspaceId, true, () => {});
          return React.createElement('output', null, invitations.data ? 'ready' : 'loading');
        }
        const root = createRoot(document.body.appendChild(document.createElement('div')));
        const admitted = () => true,
          subscribe = () => () => {};
        const render = show =>
          root.render(
            React.createElement(
              SessionQueryProvider,
              { identity },
              React.createElement(Account),
              show &&
                React.createElement(
                  WorkspaceQueryProvider,
                  { scope, admitted, subscribe },
                  React.createElement(Membership),
                  React.createElement(Settings),
                  React.createElement(Invitations),
                ),
            ),
          );
        render(true);
        await wait(
          () =>
            document.querySelectorAll('output').length === 4 &&
            [...document.querySelectorAll('output')].every(node => node.textContent.includes('ready')),
        );
        const cold = { ...calls };
        render(false);
        await sleep(30);
        render(true);
        await wait(() => document.querySelectorAll('output').length === 4);
        window.dispatchEvent(new Event('focus'));
        await sleep(100);
        const revisit = { ...calls };
        const setupKeys = runtime.client
          .getQueryCache()
          .getAll()
          .filter(query => query.queryKey.includes('setup'))
          .map(query => query.queryKey);
        invitations.record({
          id: membershipId,
          kind: 'email',
          email: 'invite@example.com',
          expiresAt: '2026-10-04T00:00:00.000Z',
          status: 'active',
          canCopy: true,
          url: 'SECRET_INVITATION_LINK',
        });
        const noSecrets = !JSON.stringify(
          runtime.client
            .getQueryCache()
            .getAll()
            .map(query => [query.queryKey, query.state.data]),
        ).includes('SECRET_INVITATION_LINK');
        await sleep(50);
        const dependentKey = featureKey(scope, ['tables', 'list']);
        runtime.client.setQueryData(dependentKey, 'protected rows');
        const administrationKey = featureKey(scope, governanceKeys.administration);
        runtime.client.setQueryData(administrationKey, 'admin snapshot');
        await changes.saved('/grants', 'PUT');
        const concealed = runtime.client.getQueryData(dependentKey) === undefined;
        const administrationKept =
          runtime.client.getQueryData(administrationKey) === 'admin snapshot' &&
          runtime.client.getQueryState(administrationKey).isInvalidated;
        hold = true;
        void invitations.refresh();
        await wait(() => !!release);
        runtime.revoke(scope, true);
        release();
        await sleep(100);
        const lateReadRejected = runtime.client
          .getQueryCache()
          .findAll({ queryKey: featureKey(scope, governanceKeys.invitations) })
          .every(query => query.state.data === undefined);
        const accountRetained =
          runtime.client.getQueryData(['user', 'alice', 'workspaces', 'setup', workspaceId])?.stage === 'ready';
        root.unmount();
        return {
          cold,
          revisit,
          setupKeys,
          noSecrets,
          concealed,
          administrationKept,
          lateReadRejected,
          accountRetained,
        };
      });
      assert.deepEqual(result.cold, { membership: 1, settings: 1, invitations: 1, setup: 1 });
      assert.deepEqual(result.revisit, result.cold);
      assert.deepEqual(result.setupKeys, [
        ['user', 'alice', 'workspaces', 'setup', '11111111-1111-4111-8111-111111111111'],
      ]);
      assert.equal(result.noSecrets, true);
      assert.equal(result.concealed, true);
      assert.equal(result.administrationKept, true);
      assert.equal(result.lateReadRejected, true);
      assert.equal(result.accountRetained, true);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
