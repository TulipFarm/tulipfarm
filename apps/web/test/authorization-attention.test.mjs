import assert from 'node:assert/strict';
import { test } from 'node:test';
import { googleAppScopes, googleIdentityScopes } from '@tulipfarm/google-workspace/public-contracts';
import { authorizationAttention } from '../src/features/integrations/authorization-attention.ts';

const google = {
  configured: true,
  status: {
    status: 'connected',
    email: 'ada@example.test',
    scopes: [...googleIdentityScopes, ...googleAppScopes.calendar],
  },
};
const slack = { state: 'active', canManage: true, scopes: ['chat:write'], linked: true, teamId: 'TONE' };
const github = { id: 'github-one', configured: true, state: 'reconnect-required', identity: { login: 'ada' } };
const atlassian = {
  id: 'atlassian-one',
  configured: true,
  protocol: 'atlassian-mcp',
  state: 'reconnect-required',
  capabilities: { manage: true },
  identity: { label: 'Support' },
};
const mcp = {
  id: 'mcp-one',
  name: 'Support tools',
  canManage: true,
  authMethod: 'oauth',
  reauthorizationRequired: true,
  status: 'error',
};

test('unused, disconnected, healthy and unknown integrations never ask for authorization', () => {
  assert.deepEqual(authorizationAttention({}), []);
  assert.deepEqual(
    authorizationAttention({ google, slack, github: { configured: true, accounts: [{ ...github, state: 'active' }] } }),
    [],
  );
  for (const state of ['disconnected', 'authorizing', 'failed', 'revoked', 'unavailable'])
    assert.deepEqual(authorizationAttention({ slack: { ...slack, state } }), []);
  assert.deepEqual(
    authorizationAttention({ google: { ...google, status: { status: 'disconnected' } }, slack: 'unavailable' }),
    [],
  );
});
test('Google renews expired accounts and partially granted apps, not unused apps', () => {
  assert.deepEqual(
    authorizationAttention({ google: { ...google, status: { ...google.status, status: 'reconnect-required' } } }).map(
      item => item.target,
    ),
    [{ kind: 'google' }],
  );
  const partial = {
    ...google,
    status: { ...google.status, scopes: [...google.status.scopes, googleAppScopes.gmail[0]] },
  };
  assert.deepEqual(
    authorizationAttention({ google: partial }).map(item => item.target),
    [{ kind: 'google', app: 'gmail' }],
  );
  assert.deepEqual(authorizationAttention({ google: { ...partial, configured: false } }), []);
});
test('Slack scope updates and personal recovery respect the current manager and owner', () => {
  const missing = { ...slack, state: 'permissions-required', missingScopes: ['chat:write.customize'] };
  assert.deepEqual(
    authorizationAttention({ slack: missing }).map(item => item.reason),
    ['permissions'],
  );
  assert.deepEqual(authorizationAttention({ slack: { ...missing, canManage: false } }), []);
  assert.deepEqual(
    authorizationAttention({ slack: { ...missing, canManage: false, recoveryEventId: 'event-one' } }).map(
      item => item.target,
    ),
    [{ kind: 'slack-user', eventId: 'event-one' }],
  );
});
test('each configured OAuth account is independent, including managed shared accounts', () => {
  const sources = {
    github: { configured: true, accounts: [{ ...github, id: 'healthy', state: 'active' }, github] },
    atlassian: { accounts: [atlassian, { ...atlassian, id: 'healthy', state: 'active' }] },
    mcp: [mcp],
  };
  assert.deepEqual(
    authorizationAttention(sources).map(item => item.id),
    ['github:github-one', 'atlassian:atlassian-one', 'mcp:mcp-one'],
  );
  assert.deepEqual(
    authorizationAttention({
      github: { configured: false, accounts: [github] },
      atlassian: { accounts: [{ ...atlassian, capabilities: { manage: false } }] },
      mcp: [{ ...mcp, canManage: false }],
    }),
    [],
  );
  assert.deepEqual(
    authorizationAttention({
      github: { configured: true, accounts: [{ ...github, configured: false }] },
      atlassian: { accounts: [{ ...atlassian, configured: false }] },
    }),
    [],
  );
});
test('MCP general errors, review and automatic refresh are not OAuth repair', () => {
  for (const status of ['error', 'setup', 'review-required', 'oauth-pending', 'disabled', 'disconnected'])
    assert.deepEqual(authorizationAttention({ mcp: [{ ...mcp, status, reauthorizationRequired: false }] }), []);
  assert.deepEqual(authorizationAttention({ mcp: [{ ...mcp, authMethod: 'bearer' }] }), []);
  assert.equal(authorizationAttention({ mcp: [{ ...mcp, barrier: { actionId: 'unknown-action' } }] }).length, 1);
});
