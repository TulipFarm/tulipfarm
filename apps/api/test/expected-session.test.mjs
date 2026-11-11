import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { Pool } from 'pg';
import * as authModule from '../src/auth.ts';
import { sessionIndependentOperations } from '../src/authenticated-routes.ts';

const id = '22222222-2222-4222-8222-222222222222';
const session = { user: { id, email: 'reader@example.test' }, session: { id: 'current-session' } };
const signedInWithoutUnauthorizedResponse = new Set([
  'retiredSaveWorkspaceSkillV1',
  'readSkillHistoryV1',
  'readSkillRuntimeV1',
  'previewImportedSkillFileV1',
  'previewSkillFileV1',
  'readSkillProvenanceV1',
  'prepareSkillUpdateV1',
  'prepareSkillProcedureV1',
  'prepareSkillImportV1',
  'readSkillImportV1',
  'selectSkillImportV1',
  'cancelSkillImportV1',
  'approveSkillImportV1',
  'listGitHubBatchesV1',
  'getGitHubBatchV1',
  'getGitHubBatchStatusV1',
  'reconcileGitHubBatchStatusV1',
  'decisionGitHubBatchV1',
  'executeGitHubBatchV1',
  'reconcileGitHubBatchV1',
  'workspaceMemberPhoto',
  'listGoogleFilesV1',
  'getGoogleFileV1',
  'readGoogleFileContentV1',
  'listGoogleOperationsV1',
  'readGoogleOperationV1',
  'proposeGoogleOperationV1',
  'listGoogleProposalsV1',
  'getGoogleProposalV1',
  'decideGoogleProposalV1',
  'executeGoogleProposalV1',
]);
let sessionReads = 0;
mock.module('../src/auth.ts', {
  exports: {
    ...authModule,
    registerAuth(app) {
      const dependencies = authModule.registerAuth(app);
      mock.method(dependencies.auth.api, 'getSession', async () => {
        sessionReads++;
        return session;
      });
      mock.method(dependencies.auth, 'handler', async request =>
        Response.json({ path: new URL(request.url).pathname }),
      );
      return dependencies;
    },
  },
});
mock.method(globalThis, 'fetch', async () => assert.fail('Composition tests must not access the network'));
mock.method(dns, 'lookup', async () => assert.fail('Composition tests must not resolve network hosts'));
syncBuiltinESMExports();
const { buildApp } = await import('../src/app.ts');
after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

for (const isolated of [false, true]) {
  test(`all documented signed-in operations reject stale sessions with isolated storage ${isolated}`, async t => {
    const previous = { ...process.env };
    t.after(() => {
      process.env = previous;
    });
    Object.assign(process.env, {
      NODE_ENV: 'test',
      ANTHROPIC_API_KEY: 'test-key',
      WORKSPACE_STORAGE_CAPABILITY: isolated ? 'isolated-v1' : '',
      DATABASE_URL: 'postgresql://fixture@127.0.0.1:1/fixture',
      WORKSPACE_CONFIRMATION_REGISTRY_DATABASE_URL: 'postgresql://confirmation@127.0.0.1:1/fixture',
      SLACK_INTAKE_ENABLED: String(isolated),
      SLACK_CONFIGURATION: JSON.stringify({
        appId: 'ATEST',
        clientId: 'synthetic',
        clientSecret: 'synthetic',
        signingSecret: 'synthetic-signing-secret',
        redirectUri: 'https://api.example.test/v1/slack/oauth/callback',
        scopeApproval: { reference: 'test-only', botScopes: ['chat:write'] },
      }),
      SLACK_CREDENTIAL_KEYS: JSON.stringify({ activeKeyId: 'fixture', keys: { fixture: '55'.repeat(32) } }),
      WORKSPACE_RUNTIME_KEY_ID: 'fixture',
      WORKSPACE_RUNTIME_KEY: '11'.repeat(32),
      WORKSPACE_CONFIRMATION_KEY_ID: 'fixture',
      WORKSPACE_CONFIRMATION_KEY: '22'.repeat(32),
      INTEGRATION_CREDENTIAL_KEY_ID: 'fixture',
      INTEGRATION_CREDENTIAL_KEY: '33'.repeat(32),
      EMAIL_DELIVERY_KEY_ID: 'fixture',
      EMAIL_DELIVERY_KEY: '44'.repeat(32),
      TULIPFARM_OBJECT_STORAGE_FILES_BUCKET: 'fixture-files',
      TULIPFARM_OBJECT_STORAGE_REGION: 'us-east-1',
      TULIPFARM_OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:1',
      TULIPFARM_OBJECT_STORAGE_ACCESS_KEY_ID: 'synthetic',
      TULIPFARM_OBJECT_STORAGE_SECRET_ACCESS_KEY: 'synthetic',
    });
    for (const key of [
      'WORKSPACE_PROVISIONING_DATABASE_URL',
      'WORKSPACE_MIGRATION_KEY',
      'WORKSPACE_MIGRATION_PREVIOUS_KEYS',
      'WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL',
      'WORKSPACE_AUTHORING_DATABASE_URL',
    ])
      delete process.env[key];
    let storageReads = 0;
    for (const method of ['query', 'connect'])
      t.mock.method(Pool.prototype, method, async sql => {
        storageReads++;
        if (typeof sql === 'string' && sql.includes('INSERT INTO app.api_rate_limits'))
          return { rows: [{ current: 1, ttl: 60_000 }] };
        throw new Error('Database access blocked in composition test');
      });
    const app = buildApp({ agentModel: null });
    app.log.level = 'silent';
    t.after(() => app.close());
    const registered = new Map();
    app.addHook('onRoute', route => {
      if (route.schema?.operationId) registered.set(route.schema.operationId, route);
    });
    const docs = await app.inject('/v1/docs/json');
    assert.equal(docs.statusCode, 200);
    const operations = Object.entries(docs.json().paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, operation]) => ({ path, method, operation })),
    );
    const publicOperations = operations.filter(({ operation }) =>
      sessionIndependentOperations.has(operation.operationId),
    );
    assert.ok(publicOperations.some(({ operation }) => operation.operationId === 'getLivenessV1'));
    const optionalOperations = new Set([
      'receiveSlackActionV1',
      'receiveGitHubKnowledgeEventV1',
      'receiveGitHubEventV1',
      ...(!isolated
        ? [
            'receiveWorkflowWebhookV1',
            'receiveWorkflowTriggerWebhookV1',
            'completeGoogleWorkspaceOAuthV1',
            'completeWorkspaceMcpOAuthV1',
          ]
        : []),
    ]);
    for (const operationId of sessionIndependentOperations)
      if (!optionalOperations.has(operationId))
        assert.ok(registered.has(operationId), `Unknown session-independent operation: ${operationId}`);
    const signedIn = operations.filter(({ operation }) => !sessionIndependentOperations.has(operation.operationId));
    for (const { operation } of signedIn)
      assert.ok(
        operation.responses['401'] || signedInWithoutUnauthorizedResponse.has(operation.operationId),
        `Declare authentication or explicitly exempt public operation ${operation.operationId}`,
      );
    assert.ok(signedIn.some(({ operation }) => operation.operationId === 'listWorkspacesV1'));
    if (isolated) {
      for (const operationId of [
        'getWorkspaceCreditsV1',
        'listSecretsV1',
        'createSecretV1',
        'listWorkspaceMcpIntegrationsV1',
      ])
        assert.ok(
          signedIn.some(({ operation }) => operation.operationId === operationId),
          operationId,
        );
    }
    let index = 0;
    for (const { path, method, operation } of signedIn) {
      const before = sessionReads;
      const beforeStorage = storageReads;
      const response = await app.inject({
        method: method.toUpperCase(),
        url: path.replace(/\{[^}]+\}/g, () => id),
        remoteAddress: `192.0.${Math.floor(index / 250)}.${(index++ % 250) + 1}`,
        headers: { 'x-tulipfarm-expected-session': 'old-session' },
        ...(['post', 'put', 'patch'].includes(method) ? { payload: {} } : {}),
      });
      assert.equal(response.statusCode, 401, `${operation.operationId}: ${response.body}`);
      assert.deepEqual(response.json(), { error: 'session-changed' }, operation.operationId);
      assert.equal(sessionReads, before + 1, operation.operationId);
      assert.equal(storageReads, beforeStorage, operation.operationId);
    }
    const before = sessionReads;
    const live = await app.inject({
      url: '/v1/health/live',
      headers: { 'x-tulipfarm-expected-session': 'old-session' },
    });
    assert.equal(live.statusCode, 200, live.body);
    assert.equal(sessionReads, before);
    for (const request of [
      { url: '/v1/auth/options' },
      { method: 'POST', url: '/v1/auth/sign-in/email', payload: {} },
      { url: '/v1/auth/callback/google' },
      { url: '/v1/auth/get-session' },
    ]) {
      const before = sessionReads;
      const control = await app.inject({ ...request, headers: { origin: authModule.authConfig().webOrigin } });
      const stale = await app.inject({
        ...request,
        headers: {
          origin: authModule.authConfig().webOrigin,
          'x-tulipfarm-expected-session': 'old-session',
        },
      });
      assert.equal(stale.statusCode, control.statusCode, request.url);
      assert.equal(stale.body, control.body, request.url);
      assert.equal(stale.statusCode, 200, stale.body);
      assert.equal(sessionReads, before, request.url);
    }
    t.diagnostic(
      `Checked ${signedIn.filter(({ method }) => method === 'get').length} signed-in GETs and ${signedIn.length} signed-in operations`,
    );
  });
}
