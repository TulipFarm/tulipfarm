import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../../packages/workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime } from '../../../packages/workspace-storage/src/runtime.ts';
import { registerWorkflows } from '../../api/src/workflows.ts';
import { protectBusinessRequests } from '../../api/src/business.ts';
import { saveWorkflow, openWorkflow, assertConfiguration } from './workflow-definition.fixture.mjs';

const requireApi = createRequire(new URL('../../api/package.json', import.meta.url));
const Fastify = requireApi('fastify'),
  cors = requireApi('@fastify/cors');
// The service comes from the same build the API routes import, so errors it throws match the routes' error classes.
const { createWorkflows } = await import(pathToFileURL(requireApi.resolve('@tulipfarm/workflows')).href);
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);

test(
  'Chromium creates signed and bearer webhook keys once, shows the previous key grace period, and revokes it',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    const origin = 'http://127.0.0.1:5395',
      apiOrigin = 'http://127.0.0.1:3395';
    let app, runtime, browser, vite;
    const priorOrigin = process.env.WEB_ORIGIN;
    try {
      process.env.WEB_ORIGIN = origin;
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const w = await db.create(await workspaceTableMigrations());
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const service = createWorkflows(runtime, {
          keyring: { activeKeyId: 'browser', keys: { browser: '9e'.repeat(32) } },
        }),
        id = randomUUID(),
        revision = randomUUID();
      let workflow = await service.save(w.id, w.userId, id, {
        revision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'Order intake',
          trigger: { kind: 'webhook' },
          steps: [{ id: 'copy', kind: 'transform', fields: { order: { kind: 'input', path: [] } } }],
        },
      });
      await service.sponsorship(w.id, w.userId, id, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId],
      });
      await service.activate(w.id, w.userId, id, {
        commandId: randomUUID(),
        expectedGeneration: 2,
        revision,
        enabled: true,
      });
      const workspace = {
        id: w.id,
        name: 'Webhook proof',
        slug: 'webhook-proof',
        createdAt: new Date().toISOString(),
        status: 'ready',
        soulCommit: 'a'.repeat(40),
      };
      const session = {
        session: { id: 'local-test-session', userId: w.userId },
        user: { id: w.userId, name: 'Webhook tester', email: 'webhook@example.com' },
      };
      app = Fastify();
      app.register(cors, { origin, credentials: true, methods: ['GET', 'POST', 'PUT', 'OPTIONS'] });
      app.get('/v1/auth/get-session', async () => session);
      app.get('/v1/workspaces', async () => [workspace]);
      app.get('/v1/workspaces/webhook-proof', async () => workspace);
      app.get(`/v1/workspaces/${w.id}/governance/me`, async () => ({
        membershipId: w.membershipId,
        role: 'admin',
        teams: [],
        capabilities: { manageGovernance: true, canLeave: true },
      }));
      app.register(
        async routes => {
          protectBusinessRequests(routes);
          registerWorkflows(routes, {
            service,
            auth: {
              api: {
                getSession: async ({ headers }) =>
                  headers.get('cookie')?.includes('workflow-test=1') ? session : null,
              },
            },
          });
        },
        { prefix: '/v1' },
      );
      await app.listen({ host: '127.0.0.1', port: 3395 });
      vite = spawn(
        'pnpm',
        ['--filter', '@tulipfarm/web', 'dev', '--host', '127.0.0.1', '--port', '5395', '--strictPort'],
        { env: { ...process.env, VITE_API_URL: apiOrigin }, stdio: 'ignore' },
      );
      for (let attempt = 0; ; attempt++) {
        try {
          if ((await fetch(origin)).ok) break;
        } catch {
          if (attempt > 100) throw new Error('Vite did not start');
        }
        await setTimeout(100);
      }
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      await context.addCookies([{ name: 'workflow-test', value: '1', url: apiOrigin }]);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      const setup = page.getByRole('region', { name: 'Webhook setup' });
      const keyStatus = setup.getByLabel('Webhook key status'),
        endpointStatus = setup.getByLabel('Webhook endpoint status'),
        previousStatus = setup.getByLabel('Previous webhook key status');
      const hookUrl = `${apiOrigin}/v1/workspaces/${w.id}/workflows/${id}/webhook`;
      const signed = (secret, order) => {
        const body = JSON.stringify({ order }),
          timestamp = Math.floor(Date.now() / 1000);
        return fetch(hookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-tulipfarm-timestamp': String(timestamp),
            'x-tulipfarm-signature': `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`,
            'x-github-delivery': randomUUID(),
          },
          body,
        });
      };
      const bearer = (secret, order) =>
        fetch(hookUrl, {
          method: 'POST',
          headers: {
            authorization: ['Bearer', secret].join(' '),
            'content-type': 'application/json',
            'x-github-delivery': randomUUID(),
          },
          body: JSON.stringify({ order }),
        });

      await page.goto(`${origin}/webhook-proof/workflows`);
      await page.getByRole('button', { name: 'Order intake', exact: true }).click();
      await keyStatus.getByText('Not configured', { exact: true }).waitFor();
      await endpointStatus.getByText('Not receiving requests. Create a key to start accepting calls.').waitFor();
      workflow = await saveWorkflow(
        service,
        w,
        {
          ...workflow.definition,
          trigger: {
            kind: 'webhook',
            payload: { mode: 'raw', dedupe: { source: 'header', name: 'x-github-delivery' } },
          },
        },
        workflow,
      );
      let viewer = await openWorkflow(page, workflow);
      await assertConfiguration(viewer, 0, workflow.definition.trigger);
      if (await page.getByRole('button', { name: 'Accept my sponsorship' }).count())
        await page.getByRole('button', { name: 'Accept my sponsorship' }).click();
      await page.getByRole('button', { name: 'Activate saved revision' }).click();
      await page.getByRole('button', { name: 'Disable workflow' }).waitFor();
      assert.deepEqual((await service.list(w.id, w.userId)).find(item => item.id === id).activeTrigger.payload, {
        mode: 'raw',
        dedupe: { source: 'header', name: 'x-github-delivery' },
      });
      const example = await setup.getByRole('region', { name: 'curl example' }).textContent();
      assert.match(example, new RegExp(`/v1/workspaces/${w.id}/workflows/${id}/webhook`));
      assert.match(
        example,
        /openssl dgst -sha256 -hmac "\$TULIPFARM_WEBHOOK_KEY"/,
        'New keys default to signed requests',
      );
      assert.equal(
        await setup.getByRole('button', { name: 'Signed requests (HMAC-SHA256)' }).getAttribute('aria-pressed'),
        'true',
      );

      await setup.getByRole('button', { name: 'Create webhook key' }).click();
      await keyStatus.getByText('Signed requests (HMAC-SHA256).').waitFor();
      await endpointStatus.getByText('Receiving', { exact: true }).waitFor();
      const signingKey = await setup.getByLabel('New webhook key').inputValue();
      assert.match(signingKey, /^[a-f0-9]{64}$/);
      assert.equal(
        (await setup.textContent()).includes(signingKey),
        false,
        'The key appears only inside its read-only field',
      );
      assert.equal((await signed(signingKey, 1)).status, 200);
      assert.equal((await bearer(signingKey, 1)).status, 404, 'A signing key is never accepted as a bearer key');

      await setup.getByRole('button', { name: 'Bearer key' }).click();
      assert.match(
        await setup.getByRole('region', { name: 'curl example' }).textContent(),
        /openssl/,
        'The example follows the current key until it is replaced',
      );
      await setup.getByRole('button', { name: 'Replace webhook key' }).click();
      await keyStatus.getByText('Bearer key.').waitFor();
      await previousStatus.getByText('Still accepted', { exact: true }).waitFor();
      const key = await setup.getByLabel('New webhook key').inputValue();
      assert.notEqual(key, signingKey);
      assert.match(
        await setup.getByRole('region', { name: 'curl example' }).textContent(),
        /Bearer \$TULIPFARM_WEBHOOK_KEY/,
      );
      assert.equal((await bearer(key, 2)).status, 200);
      assert.equal(
        (await signed(signingKey, 3)).status,
        200,
        'The previous signing key keeps working during its grace period',
      );
      await previousStatus.getByRole('button', { name: 'Revoke previous key now' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke previous key' }).click();
      await page.getByText('Previous webhook key revoked. Only the current key works now.').waitFor();
      assert.equal(await previousStatus.count(), 0);
      assert.equal((await signed(signingKey, 4)).status, 404, 'A revoked previous key stops at once');

      workflow = await saveWorkflow(
        service,
        w,
        {
          ...workflow.definition,
          trigger: { kind: 'webhook', payload: { mode: 'raw', dedupe: { source: 'body', path: ['order'] } } },
        },
        workflow,
      );
      viewer = await openWorkflow(page, workflow);
      await assertConfiguration(viewer, 0, workflow.definition.trigger);
      if (await page.getByRole('button', { name: 'Accept my sponsorship' }).count())
        await page.getByRole('button', { name: 'Accept my sponsorship' }).click();
      await page.getByRole('button', { name: 'Activate saved revision' }).click();
      await page.getByRole('button', { name: 'Disable workflow' }).waitFor();
      assert.deepEqual((await service.list(w.id, w.userId)).find(item => item.id === id).activeTrigger.payload.dedupe, {
        source: 'body',
        path: ['order'],
      });

      await setup.getByRole('button', { name: 'Stripe signature' }).click();
      const stripeSecret = 'whsec_browser_fixture_signing_secret';
      await setup.getByLabel('Stripe endpoint signing secret').fill(stripeSecret);
      await setup.getByRole('button', { name: 'Replace webhook key' }).click();
      await keyStatus.getByText('Stripe signature.').waitFor();
      await page.getByText('Stripe signing secret saved encrypted.', { exact: true }).waitFor();
      const stripeBody = JSON.stringify({ order: 5 }),
        stripeTimestamp = Math.floor(Date.now() / 1000);
      const stripeSignature = createHmac('sha256', stripeSecret)
        .update(`${stripeTimestamp}.${stripeBody}`)
        .digest('hex');
      const stripeResponse = await fetch(hookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': `t=${stripeTimestamp},v1=${stripeSignature}`,
        },
        body: stripeBody,
      });
      assert.equal(stripeResponse.status, 200);
      assert.equal(await setup.getByLabel('Stripe endpoint signing secret').inputValue(), '');

      workflow = await saveWorkflow(service, w, { ...workflow.definition, trigger: { kind: 'manual' } }, workflow);
      viewer = await openWorkflow(page, workflow);
      await assertConfiguration(viewer, 0, { kind: 'manual' });
      await setup
        .getByRole('note')
        .getByText(
          'The saved revision uses a manual trigger. Activating it stops this endpoint and deletes the webhook key.',
        )
        .waitFor();
      await endpointStatus.getByText('Receiving', { exact: true }).waitFor();

      await page.getByRole('button', { name: 'Activate saved revision' }).click();
      await page.getByRole('button', { name: 'Disable workflow' }).waitFor();
      assert.equal(await setup.count(), 0);

      workflow = await saveWorkflow(service, w, { ...workflow.definition, trigger: { kind: 'webhook' } }, workflow);
      await openWorkflow(page, workflow);
      await keyStatus.getByText('Not configured', { exact: true }).waitFor();
      await endpointStatus
        .getByText(
          'Not receiving requests. The active revision uses a manual trigger. Activate the saved revision to accept calls.',
        )
        .waitFor();
      // A webhook revision runs unattended, so its named sponsor accepts the new revision before activation.
      await page.getByRole('button', { name: 'Accept my sponsorship' }).click();
      await page.getByRole('button', { name: 'Accept my sponsorship' }).waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Activate saved revision' }).click();
      await page.getByRole('button', { name: 'Disable workflow' }).waitFor();
      await endpointStatus.getByText('Not receiving requests. Create a key to start accepting calls.').waitFor();
      await keyStatus.getByText('Not configured', { exact: true }).waitFor();
      assert.equal((await bearer(key, 5)).status, 404);

      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      vite?.kill('SIGTERM');
      await app?.close();
      await runtime?.close();
      await db.close();
      if (priorOrigin === undefined) delete process.env.WEB_ORIGIN;
      else process.env.WEB_ORIGIN = priorOrigin;
    }
  },
);

test(
  'Chromium shows the webhook delivery log through load failure, empty, test send, and rejected calls, and opens the run',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    const origin = 'http://127.0.0.1:5396',
      apiOrigin = 'http://127.0.0.1:3396';
    let app, runtime, browser, vite;
    const priorOrigin = process.env.WEB_ORIGIN;
    try {
      process.env.WEB_ORIGIN = origin;
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const w = await db.create(await workspaceTableMigrations());
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const service = createWorkflows(runtime),
        id = randomUUID(),
        revision = randomUUID();
      await service.save(w.id, w.userId, id, {
        revision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'Order intake',
          trigger: { kind: 'webhook' },
          steps: [{ id: 'copy', kind: 'transform', fields: { order: { kind: 'input', path: [] } } }],
        },
      });
      await service.sponsorship(w.id, w.userId, id, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId],
      });
      await service.activate(w.id, w.userId, id, {
        commandId: randomUUID(),
        expectedGeneration: 2,
        revision,
        enabled: true,
      });
      const { key } = await service.webhookKey(w.id, w.userId, id, {
        commandId: randomUUID(),
        expectedGeneration: 3,
        mode: 'bearer',
      });
      const workspace = {
        id: w.id,
        name: 'Webhook log proof',
        slug: 'webhook-log-proof',
        createdAt: new Date().toISOString(),
        status: 'ready',
        soulCommit: 'a'.repeat(40),
      };
      const session = {
        session: { id: 'local-test-session', userId: w.userId },
        user: { id: w.userId, name: 'Webhook tester', email: 'webhook@example.com' },
      };
      app = Fastify();
      app.register(cors, { origin, credentials: true, methods: ['GET', 'POST', 'PUT', 'OPTIONS'] });
      app.get('/v1/auth/get-session', async () => session);
      app.get('/v1/workspaces', async () => [workspace]);
      app.get('/v1/workspaces/webhook-log-proof', async () => workspace);
      app.get(`/v1/workspaces/${w.id}/governance/me`, async () => ({
        membershipId: w.membershipId,
        role: 'admin',
        teams: [],
        capabilities: { manageGovernance: true, canLeave: true },
      }));
      app.register(
        async routes => {
          protectBusinessRequests(routes);
          registerWorkflows(routes, {
            service,
            auth: {
              api: {
                getSession: async ({ headers }) =>
                  headers.get('cookie')?.includes('workflow-test=1') ? session : null,
              },
            },
          });
        },
        { prefix: '/v1' },
      );
      await app.listen({ host: '127.0.0.1', port: 3396 });
      vite = spawn(
        'pnpm',
        ['--filter', '@tulipfarm/web', 'dev', '--host', '127.0.0.1', '--port', '5396', '--strictPort'],
        { env: { ...process.env, VITE_API_URL: apiOrigin }, stdio: 'ignore' },
      );
      for (let attempt = 0; ; attempt++) {
        try {
          if ((await fetch(origin)).ok) break;
        } catch {
          if (attempt > 100) throw new Error('Vite did not start');
        }
        await setTimeout(100);
      }
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      await context.addCookies([{ name: 'workflow-test', value: '1', url: apiOrigin }]);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      const log = page.getByRole('region', { name: 'Recent deliveries' });
      const hookUrl = `${apiOrigin}/v1/workspaces/${w.id}/workflows/${id}/webhook`;
      const call = (authorization, requestId) =>
        fetch(hookUrl, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify({ requestId, input: { order: 7 } }),
        });

      let failReads = true,
        emptyShownWhileLoading = false;
      await page.route('**/webhook-deliveries', async route => {
        if (!failReads) return route.continue();
        await setTimeout(600);
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: '{"error":"workflow-operation-failed"}',
        });
      });
      await page.goto(`${origin}/webhook-log-proof/workflows`);
      await page.getByRole('button', { name: 'Order intake', exact: true }).click();
      await log.getByText('Loading deliveries…').waitFor();
      emptyShownWhileLoading = (await log.getByText('No deliveries yet').count()) > 0;
      await log.getByRole('alert').getByText('Deliveries could not load').waitFor({ timeout: 20000 });
      assert.equal(emptyShownWhileLoading, false, 'The empty state never shows before a successful read');
      assert.equal(await log.getByText('No deliveries yet').count(), 0);
      failReads = false;
      await log.getByRole('button', { name: 'Retry loading deliveries' }).click();
      await log.getByText('No deliveries yet').waitFor();

      await log.getByRole('button', { name: 'Send test event' }).click();
      await page.getByText('Test event sent. Open its run from the webhook panel.').waitFor();
      const rows = log.getByRole('table', { name: 'Webhook deliveries' }).getByRole('row');
      await rows.filter({ hasText: 'Run started' }).filter({ hasText: 'Test' }).waitFor();
      const testRun = (await service.history(w.id, w.userId, id).then(page => page.runs))[0];
      assert.deepEqual([testRun.source, testRun.input], ['webhook', { test: true }]);
      await log.getByRole('button', { name: 'Open test run' }).click();
      const article = page.locator(`#workflow-run-${testRun.id}`);
      await article.waitFor();
      assert.equal(await article.isVisible(), true, 'Open test run shows that run in run history');
      const pinned = page.getByRole('region', { name: 'Selected run diagram', exact: true });
      await pinned.getByText('Definition used by this run', { exact: true }).waitFor();
      assert.equal((await service.runDetail(w.id, w.userId, id, testRun.id)).run.revision, revision);

      const sent = randomUUID();
      assert.equal((await call(`Bearer ${'0'.repeat(64)}`, sent)).status, 404);
      const accepted = await call(`Bearer ${key}`, sent);
      assert.equal(accepted.status, 200);
      const { runId } = await accepted.json();
      await page.getByRole('button', { name: 'Definition and activation' }).click();
      await log.getByRole('button', { name: 'Check deliveries' }).click();
      const rejected = rows.filter({ hasText: 'Key or signature not accepted' });
      await rejected.waitFor();
      assert.match(await rejected.textContent(), new RegExp(sent));
      assert.match(await rejected.textContent(), /No run/);
      const started = rows.filter({ hasText: sent }).filter({ hasText: 'Run started' });
      await started.getByRole('button', { name: 'Open run' }).click();
      await page.locator(`#workflow-run-${runId}`).waitFor();
      assert.equal(await page.locator(`#workflow-run-${runId}`).isVisible(), true);
      await pinned.getByText('Definition used by this run', { exact: true }).waitFor();

      await page.getByRole('button', { name: 'Definition and activation' }).click();
      await page.getByRole('button', { name: 'Disable workflow' }).click();
      await page.getByRole('button', { name: 'Activate saved revision' }).waitFor();
      await log.getByText('Activate the webhook revision to send a test event.').waitFor();
      assert.equal(await log.getByRole('button', { name: 'Send test event' }).isDisabled(), true);

      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      vite?.kill('SIGTERM');
      await app?.close();
      await runtime?.close();
      await db.close();
      if (priorOrigin === undefined) delete process.env.WEB_ORIGIN;
      else process.env.WEB_ORIGIN = priorOrigin;
    }
  },
);
