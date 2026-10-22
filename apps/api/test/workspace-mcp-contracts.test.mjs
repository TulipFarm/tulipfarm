import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  mcpSetupSchema,
  mcpDecisionSchema,
  mcpReconciliationSchema,
  mcpSelectionInput,
  mcpActionSchema,
} from '../src/workspace-mcp-contracts.ts';
import { mcpPermissionRevisions } from '../src/workspace-mcp-permission-revisions.ts';

test('MCP permission revisions distinguish the saved Soul commit from current or older active definition digests', () => {
  const agent = {
    savedRevision: 'a'.repeat(40),
    definitionRevision: 'b'.repeat(64),
    activations: [{ revision: 'b'.repeat(64) }],
  };
  assert.deepEqual(mcpPermissionRevisions(agent), { savedRevision: 'a'.repeat(40), activeRevision: 'b'.repeat(64) });
  assert.deepEqual(mcpPermissionRevisions({ ...agent, activations: [{ revision: 'c'.repeat(64) }] }), {
    savedRevision: 'a'.repeat(40),
    activeRevision: 'c'.repeat(64),
  });
  assert.equal(mcpPermissionRevisions({ ...agent, activations: [] }).activeRevision, null);
  assert.equal(
    mcpPermissionRevisions({ ...agent, activations: [{ revision: 'c'.repeat(64) }, { revision: 'd'.repeat(64) }] })
      .activeRevision,
    null,
  );
});

test('workspace MCP human commands cannot carry model authority or OAuth access tokens', () => {
  const setup = {
    requestId: randomUUID(),
    name: 'Reports',
    ownership: 'personal',
    endpoint: 'https://reports.example/mcp',
    auth: { kind: 'none' },
  };
  assert.deepEqual(mcpSetupSchema.parse(setup), setup);
  for (const body of [
    { ...setup, principal: randomUUID() },
    { ...setup, sources: [] },
    { ...setup, auth: { kind: 'oauth', accessToken: 'private-token' } },
    { ...setup, auth: { kind: 'headers', headers: [{ name: 'Authorization\r\nHost', value: 'secret' }] } },
  ])
    assert.equal(mcpSetupSchema.safeParse(body).success, false);
  const decision = { requestId: randomUUID(), digest: 'a'.repeat(64), decision: 'approve' };
  assert.deepEqual(mcpDecisionSchema.parse(decision), decision);
  for (const extra of [
    { arguments: {} },
    { sources: [] },
    { integrationId: randomUUID() },
    { toolRevision: 'b'.repeat(64) },
    { requester: randomUUID() },
  ])
    assert.equal(mcpDecisionSchema.safeParse({ ...decision, ...extra }).success, false);
  assert.equal(mcpDecisionSchema.safeParse({ ...decision, digest: 'short' }).success, false);
  assert.equal(
    mcpReconciliationSchema.safeParse({
      requestId: randomUUID(),
      digest: decision.digest,
      outcome: 'completed',
      notes: 'Checked externally',
      providerConfirmed: true,
    }).success,
    false,
  );
  assert.equal(
    mcpSelectionInput.safeParse({ requestId: randomUUID(), expectedVersion: '1', bindings: [] }).success,
    false,
  );
  assert.equal(
    mcpSelectionInput.safeParse({ requestId: randomUUID(), expectedVersion: 1, bindings: [], allowedTools: [] })
      .success,
    false,
  );
});

test('requester metadata serializer cannot expose a private payload or provider result, and orphan views no longer exist', () => {
  const metadata = {
    id: randomUUID(),
    digest: 'b'.repeat(64),
    integrationId: randomUUID(),
    integrationName: 'Shared reports',
    status: 'outcome-unknown',
    expiresAt: new Date().toISOString(),
    canDecide: false,
    canReconcile: true,
    integrationPaused: true,
    reconciliation: null,
    receipt: null,
    visibility: 'requester-metadata',
  };
  assert.deepEqual(mcpActionSchema.parse(metadata), metadata);
  assert.equal(mcpActionSchema.safeParse({ ...metadata, visibility: 'orphan-metadata' }).success, false);
  assert.equal(mcpActionSchema.safeParse({ ...metadata, exact: { arguments: { private: 'content' } } }).success, false);
  assert.equal(mcpActionSchema.safeParse({ ...metadata, receipt: { text: 'private result' } }).success, false);
  assert.equal(mcpActionSchema.safeParse({ ...metadata, canDecide: true }).success, false);
  assert.equal(
    mcpActionSchema.safeParse({
      ...metadata,
      reconciliation: {
        outcome: 'still-unknown',
        notes: 'private evidence',
        observedAt: metadata.expiresAt,
        observer: randomUUID(),
        administrative: true,
      },
    }).success,
    false,
  );
});
