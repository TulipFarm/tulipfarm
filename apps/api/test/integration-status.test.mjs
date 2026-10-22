import assert from 'node:assert/strict';
import { test } from 'node:test';
import { logUnconfiguredIntegrations, unconfiguredIntegrations } from '../src/integration-status.ts';

const configured = {
  GOOGLE_WORKSPACE_CLIENT_ID: 'google-id',
  GOOGLE_WORKSPACE_CLIENT_SECRET: 'google-secret',
  GOOGLE_WORKSPACE_REDIRECT_URI: 'https://app.example/v1/google-workspace/callback',
  GITHUB_OAUTH_CLIENT_ID: 'github-id',
  GITHUB_OAUTH_CLIENT_SECRET: 'github-secret',
  GITHUB_OAUTH_REDIRECT_URI: 'https://app.example/github/callback',
  GITHUB_OAUTH_SCOPES: 'repo',
  ATLASSIAN_MCP_CLIENT_ID: 'mcp-id',
  ATLASSIAN_MCP_CLIENT_SECRET: 'mcp-secret',
  ATLASSIAN_MCP_REDIRECT_URI: 'https://app.example/integrations/atlassian/callback',
  ATLASSIAN_MCP_SCOPES: 'read:jira-work',
  SLACK_INTAKE_ENABLED: 'true',
};

test('an empty environment reports every integration as missing', () => {
  assert.deepEqual(
    unconfiguredIntegrations({}).map(({ provider, status }) => `${provider}:${status}`),
    [
      'google-workspace:missing',
      'github:missing',
      'atlassian-mcp:missing',
      'atlassian-rest:missing',
      'trello:missing',
      'slack:missing',
    ],
  );
});

test('configured providers are omitted; partial sets are invalid, never missing', () => {
  const result = unconfiguredIntegrations({
    ...configured,
    GOOGLE_WORKSPACE_REDIRECT_URI: undefined,
    TRELLO_CLIENT_ID: 'trello-id',
  });
  assert.deepEqual(result, [
    { provider: 'google-workspace', status: 'invalid' },
    { provider: 'atlassian-rest', status: 'missing' },
    { provider: 'trello', status: 'invalid' },
  ]);
});

test('the startup log names providers and status only, never setting values', t => {
  const lines = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (line, ...args) => {
    if (typeof line !== 'string' || !line.startsWith('{"level":')) return write(line, ...args);
    lines.push(line);
    return true;
  });
  logUnconfiguredIntegrations({ GOOGLE_WORKSPACE_CLIENT_ID: 'PRIVATE-ID' });
  t.mock.restoreAll();
  const records = lines.map(line => JSON.parse(line)).filter(record => record.event === 'integration_unconfigured');
  assert.equal(records.length, 6);
  assert.deepEqual(records[0], { ...records[0], level: 'info', provider: 'google-workspace', status: 'invalid' });
  assert.ok(!lines.join('').includes('PRIVATE-ID'));
});
