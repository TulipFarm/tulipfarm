import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkspaceMcpApi } from '../src/workspace-mcp-service.ts';

const row = version => ({
  id: '6f1c2a9e-4b7d-4c1e-9a2f-3d5e8b7c1a04',
  name: 'Signing in',
  endpoint: 'https://mcp.example.test/tools',
  ownership: 'personal',
  authMethod: 'oauth',
  kind: 'remote',
  package: null,
  egress: null,
  version,
  authorizationEpoch: 1,
  lifecycle: 'authorizing',
  discovery: 'idle',
  statusReason: null,
  capabilities: { manage: true, use: true },
  barrierActionId: null,
  blocked: false,
});

test('listing integrations rereads when sign-in changes one mid-read, then gives up after three tries', async () => {
  let version = 1;
  let settlesAt = 3;
  let lists = 0;
  const api = createWorkspaceMcpApi({
    runtime: {},
    service: {
      list: async () => (lists++, [row(version)]),
      status: async () => row(version < settlesAt ? ++version : version),
    },
    catalog: {},
    oauth: {},
    admissionEnabled: false,
    dispatchEnabled: false,
    permissions: {},
    authorizeSelection: async () => {},
    authorizeSources: async () => {},
  });
  const listed = await api.integrations('workspace', 'user');
  assert.equal(lists, 3);
  assert.deepEqual(
    listed.integrations.map(integration => [integration.version, integration.status]),
    [[3, 'oauth-pending']],
  );

  lists = 0;
  settlesAt = Infinity;
  await assert.rejects(api.integrations('workspace', 'user'), { code: 'mcp-conflict' });
  assert.equal(lists, 3);
});
