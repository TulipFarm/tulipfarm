import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import Fastify from 'fastify';
import { registerAgents } from '../src/agents.ts';
import { registerAccountDetails } from '../src/account-details.ts';
import { Pool } from 'pg';
import { createHmac } from 'node:crypto';

// The app serves the shipped model catalog, which needs a provider key.
process.env.ANTHROPIC_API_KEY ??= 'test-key';

test('saved-agent and chat routes compile with the aggregate integration tool contracts', async () => {
  const app = Fastify();
  registerAgents(app, { auth: { api: { getSession: async () => null } }, runtime: {}, pool: {}, agentModel: null });
  try {
    const response = await app.inject(
      '/workspaces/11111111-1111-4111-8111-111111111111/agents/22222222-2222-4222-8222-222222222222/chat/33333333-3333-4333-8333-333333333333',
    );
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'sign-in-required' });
  } finally {
    await app.close();
  }
});

test('private account details reject guests before reading account data', async () => {
  const app = Fastify();
  let sessionReads = 0;
  registerAccountDetails(app, {
    auth: {
      api: {
        getSession: async () => {
          sessionReads++;
          return null;
        },
      },
    },
    identity: { query: async () => assert.fail('Guest access must not read account data') },
    googleEnabled: true,
  });
  try {
    const response = await app.inject('/account/sign-in-methods');
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'sign-in-required' });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(sessionReads, 1);
  } finally {
    await app.close();
  }
});

test('v1 documentation describes the routes and their response contracts', async () => {
  const app = buildApp({ agentModel: null });
  try {
    const response = await app.inject('/v1/docs/json');
    assert.equal(response.statusCode, 200);
    const spec = response.json();
    assert.equal(spec.openapi, '3.0.3');
    assert.equal(spec.info.version, '1.0.0');
    assert.deepEqual(
      Object.keys(spec.paths).sort(),
      [
        '/',
        '/.well-known/mcp-client.json',
        '/v1/account/sign-in-methods',
        '/v1/onboarding/complete',
        '/v1/onboarding/drafts',
        '/v1/onboarding/resume',
        '/v1/public/guide/options',
        '/v1/public/guide/session',
        '/v1/public/guide/messages',
        '/v1/public/guide/signup',
        '/v1/public/guide/google',
        '/v1/atlassian/oauth/callback',
        '/v1/feature-flags',
        '/v1/github/oauth/callback',
        '/v1/health',
        '/v1/health/live',
        '/v1/slack/events',
        '/v1/slack/link/complete',
        '/v1/slack/link/consent',
        '/v1/slack/link/identity',
        '/v1/slack/oauth/callback',
        '/v1/social/oauth/callback',
        '/v1/workspace-setups/{id}',
        '/v1/workspaces',
        '/v1/workspaces/{slug}',
        '/v1/workspace-mcp/oauth/callback',
        '/v1/workspaces/{workspaceId}/workspace-mcp/capabilities',
        '/v1/workspaces/{workspaceId}/workspace-mcp/catalog',
        '/v1/workspaces/{workspaceId}/workspace-mcp/integrations',
        '/v1/workspaces/{workspaceId}/workspace-mcp/integrations/{integrationId}',
        '/v1/workspaces/{workspaceId}/workspace-mcp/integrations/{integrationId}/setup',
        '/v1/workspaces/{workspaceId}/workspace-mcp/integrations/{integrationId}/discover',
        '/v1/workspaces/{workspaceId}/workspace-mcp/integrations/{integrationId}/tools',
        '/v1/workspaces/{workspaceId}/workspace-mcp/integrations/{integrationId}/descriptor',
        '/v1/workspaces/{workspaceId}/workspace-mcp/integrations/{integrationId}/grants',
        '/v1/workspaces/{workspaceId}/workspace-mcp/integrations/{integrationId}/lifecycle',
        '/v1/workspaces/{workspaceId}/workspace-mcp/selections/{kind}/{originId}',
        '/v1/workspaces/{workspaceId}/workspace-mcp/selections/chat/{originId}/reserve',
        '/v1/workspaces/{workspaceId}/workspace-mcp/agents/{agentId}/permissions',
        '/v1/workspaces/{workspaceId}/workspace-mcp/agent-permission-choices',
        '/v1/workspaces/{workspaceId}/workspace-mcp/actions',
        '/v1/workspaces/{workspaceId}/workspace-mcp/actions/{actionId}',
        '/v1/workspaces/{workspaceId}/workspace-mcp/actions/{actionId}/status',
        '/v1/workspaces/{workspaceId}/workspace-mcp/actions/{actionId}/decision',
        '/v1/workspaces/{workspaceId}/workspace-mcp/actions/{actionId}/cancel',
        '/v1/workspaces/{workspaceId}/workspace-mcp/actions/{actionId}/reconciliation',
        '/v1/workspaces/{workspaceId}/atlassian/accounts',
        '/v1/workspaces/{workspaceId}/atlassian/accounts/begin',
        '/v1/workspaces/{workspaceId}/atlassian/accounts/{accountId}',
        '/v1/workspaces/{workspaceId}/atlassian/accounts/{accountId}/disconnect',
        '/v1/workspaces/{workspaceId}/atlassian/accounts/{accountId}/grants',
        '/v1/workspaces/{workspaceId}/atlassian/accounts/{accountId}/reconnect',
        '/v1/workspaces/{workspaceId}/github/accounts',
        '/v1/workspaces/{workspaceId}/github/accounts/begin',
        '/v1/workspaces/{workspaceId}/github/accounts/{accountId}',
        '/v1/workspaces/{workspaceId}/github/accounts/{accountId}/disconnect',
        '/v1/workspaces/{workspaceId}/github/accounts/{accountId}/reconnect',
        '/v1/workspaces/{workspaceId}/github/chats/{conversationId}/downloads/{downloadId}',
        '/v1/workspaces/{workspaceId}/github/chats/{conversationId}/selection',
        '/v1/workspaces/{workspaceId}/slack/channels',
        '/v1/workspaces/{workspaceId}/slack/channels/{channel}',
        '/v1/workspaces/{workspaceId}/slack/disconnect',
        '/v1/workspaces/{workspaceId}/slack/grants',
        '/v1/workspaces/{workspaceId}/slack/install',
        '/v1/workspaces/{workspaceId}/slack/link',
        '/v1/workspaces/{workspaceId}/slack/link/{eventId}',
        '/v1/workspaces/{workspaceId}/slack/status',
        '/v1/workspaces/{workspaceId}/slack/unlink',
        '/v1/workspaces/{workspaceId}/social/accounts',
        '/v1/workspaces/{workspaceId}/social/accounts/begin',
        '/v1/workspaces/{workspaceId}/social/accounts/{accountId}',
        '/v1/workspaces/{workspaceId}/social/accounts/{accountId}/disconnect',
        '/v1/workspaces/{workspaceId}/social/accounts/{accountId}/reconnect',
        '/v1/workspaces/{workspaceId}/social/availability',
        '/v1/workspaces/{workspaceId}/social/platform-apps',
        '/v1/workspaces/{workspaceId}/social/platform-apps/{platformAppId}/replace-secret',
      ].sort(),
    );
    const flags = spec.paths['/v1/feature-flags'].get;
    assert.equal(flags.operationId, 'getFeatureFlagsV1');
    assert.deepEqual(
      flags.parameters.map(parameter => [parameter.in, parameter.name]),
      [['query', 'workspace']],
    );
    const methods = spec.paths['/v1/account/sign-in-methods'].get;
    assert.equal(methods.operationId, 'accountSignInMethods');
    const methodsResponse = methods.responses['200'].content['application/json'].schema;
    assert.equal(methodsResponse.additionalProperties, false);
    assert.deepEqual(Object.keys(methodsResponse.properties), ['methods']);
    assert.deepEqual(methodsResponse.required, ['methods']);
    assert.equal(methodsResponse.properties.methods.type, 'array');
    assert.deepEqual(methodsResponse.properties.methods.items.enum, ['email-link', 'google']);
    assert.ok(methods.responses['401']);
    const guide = spec.paths['/v1/public/guide/messages'].post;
    assert.equal(guide.operationId, 'publicGuideMessageV1');
    const guideBody = guide.requestBody.content['application/json'].schema;
    assert.equal(guideBody.additionalProperties, false);
    assert.equal(guideBody.properties.message.maxLength, 1200);
    assert.equal(guideBody.properties.conversation.maxLength, 16000);
    const onboarding = spec.paths['/v1/onboarding/drafts'].post;
    assert.equal(onboarding.operationId, 'saveOnboardingV1');
    const draftResponse = onboarding.responses['200'].content['application/json'].schema;
    assert.equal(draftResponse.properties.token, undefined);
    assert.equal(draftResponse.properties.details.properties.messages.type, 'array');
    assert.ok(spec.paths['/v1/onboarding/complete'].post.responses['401']);
    assert.ok(spec.paths['/v1/onboarding/complete'].post.responses['202']);
    const account =
      spec.paths['/v1/workspaces/{workspaceId}/atlassian/accounts/{accountId}'].get.responses['200'].content[
        'application/json'
      ].schema;
    assert.equal(account.additionalProperties, false);
    assert.equal(account.properties.capabilities.properties.use.type, 'boolean');
    assert.equal(account.properties.credential, undefined);
    const slack = await app.inject({
      method: 'POST',
      url: '/v1/slack/events',
      payload: { type: 'url_verification', challenge: 'disabled' },
    });
    assert.equal(slack.statusCode, 503);
    assert.deepEqual(slack.json(), { error: 'slack-release-disabled' });
    assert.equal((await app.inject('/v1/workspaces')).statusCode, 503);
    const health = spec.paths['/v1/health'].get;
    assert.equal(health.operationId, 'getHealthV1');
    assert.deepEqual(Object.keys(health.responses).sort(), ['200', '400', '413', '415', '429', '500', '503']);
    assert.ok(health.responses['503'].content['application/json'].schema);
    const live = await app.inject('/v1/health/live');
    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json(), { status: 'ok', version: 'development', commit: 'development' });
    assert.equal((await app.inject('/health')).statusCode, 404);
    assert.equal((await app.inject('/health/live')).statusCode, 404);
    const ui = await app.inject('/v1/docs/');
    assert.equal(ui.statusCode, 200);
    assert.match(ui.body, /swagger-ui/);
    assert.equal((await app.inject('/v1/docs/static/swagger-ui-bundle.js')).statusCode, 200);
    const yaml = await app.inject('/v1/docs/yaml');
    assert.equal(yaml.statusCode, 200);
    assert.match(yaml.body, /openapi: 3.0.3/);
  } finally {
    await app.close();
  }
});

test('isolated buildApp registers the model catalog and OpenAPI contract while database access is blocked', async t => {
  const environment = {
    NODE_ENV: 'test',
    SLACK_INTAKE_ENABLED: 'true',
    SLACK_CONFIGURATION: JSON.stringify({
      appId: 'ATEST',
      clientId: 'synthetic',
      clientSecret: 'synthetic',
      signingSecret: 'synthetic-signing-secret',
      redirectUri: 'https://api.example.test/v1/slack/oauth/callback',
      scopeApproval: { reference: 'test-only', botScopes: ['chat:write'] },
    }),
    SLACK_CREDENTIAL_KEYS: JSON.stringify({ activeKeyId: 'test', keys: { test: '55'.repeat(32) } }),
    WORKSPACE_STORAGE_CAPABILITY: 'isolated-v1',
    DATABASE_URL: 'postgresql://catalog-test@127.0.0.1:1/catalog-test',
    WORKSPACE_CONFIRMATION_REGISTRY_DATABASE_URL: 'postgresql://catalog-confirmation@127.0.0.1:1/catalog-test',
    WORKSPACE_RUNTIME_KEY_ID: 'catalog-runtime-test',
    WORKSPACE_RUNTIME_KEY: '11'.repeat(32),
    WORKSPACE_CONFIRMATION_KEY_ID: 'catalog-confirmation-test',
    WORKSPACE_CONFIRMATION_KEY: '22'.repeat(32),
    INTEGRATION_CREDENTIAL_KEY_ID: 'catalog-integration-test',
    INTEGRATION_CREDENTIAL_KEY: '33'.repeat(32),
    EMAIL_DELIVERY_KEY_ID: 'catalog-email-test',
    EMAIL_DELIVERY_KEY: '44'.repeat(32),
    WORKSPACE_RUNTIME_PREVIOUS_KEYS: '{}',
    INTEGRATION_CREDENTIAL_PREVIOUS_KEYS: '{}',
    EMAIL_DELIVERY_PREVIOUS_KEYS: '{}',
    WORKSPACE_PROVISIONING_DATABASE_URL: undefined,
    WORKSPACE_MIGRATION_KEY: undefined,
    WORKSPACE_MIGRATION_PREVIOUS_KEYS: undefined,
    WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL: undefined,
    WORKSPACE_AUTHORING_DATABASE_URL: undefined,
  };
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.mock.method(Pool.prototype, 'query', async () => {
    throw new Error('Database access blocked in composition test');
  });
  t.mock.method(Pool.prototype, 'connect', async () => {
    throw new Error('Database connection blocked in composition test');
  });
  const app = buildApp({
    agentModel: null,
    modelCatalog: {
      modelCatalogSnapshot: async () => assert.fail('Unauthenticated requests must not acquire a catalog snapshot'),
    },
  });
  try {
    const payload = JSON.stringify({ type: 'url_verification', challenge: 'configured-build-app' });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const challenge = await app.inject({
      method: 'POST',
      url: '/v1/slack/events',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': `v0=${createHmac('sha256', 'synthetic-signing-secret').update(`v0:${timestamp}:${payload}`).digest('hex')}`,
      },
    });
    assert.equal(challenge.statusCode, 200, challenge.body);
    assert.deepEqual(challenge.json(), { challenge: 'configured-build-app' });
    const response = await app.inject('/v1/workspaces/11111111-1111-4111-8111-111111111111/model-catalog');
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: 'model-catalog-unavailable' });
    assert.equal(response.headers['cache-control'], 'no-store');
    const docs = await app.inject('/v1/docs/json');
    assert.equal(docs.statusCode, 200);
    const operation = docs.json().paths['/v1/workspaces/{workspaceId}/model-catalog'].get;
    assert.equal(operation.operationId, 'getModelCatalogV1');
    assert.equal(operation.parameters.find(parameter => parameter.name === 'workspaceId').required, true);
    assert.deepEqual(Object.keys(operation.responses).sort(), [
      '200',
      '400',
      '401',
      '404',
      '413',
      '415',
      '429',
      '500',
      '503',
    ]);
    const schema = operation.responses['200'].content['application/json'].schema;
    assert.deepEqual(schema.required, ['families']);
    const variants = schema.properties.families.items.oneOf;
    assert.equal(variants.length, 2);
    for (const variant of variants) {
      assert.ok(variant.required.includes('mappingRevision'));
      assert.ok(variant.required.includes('pricingRevision'));
      assert.ok(variant.required.includes('fallbackFor'));
    }
  } finally {
    await app.close();
  }
});
