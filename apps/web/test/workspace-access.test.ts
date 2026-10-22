import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkspaceAccess } from '../src/lib/workspace-access.ts';

const authority = { userId: 'A', sessionId: 'session-A', slug: 'qa' };
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'QA',
  slug: 'qa',
  createdAt: '2026-10-02T00:00:00.000Z',
  status: 'ready' as const,
  soulCommit: 'a'.repeat(40),
};
const read = { pathname: '/qa/integrations', workspace, workspaces: [workspace] };

test('revocation removes retained data and rejects successes started before denial', () => {
  const access = createWorkspaceAccess();
  const initial = access.begin(authority);
  initial.admit(read);
  assert.deepEqual(initial.retained(read.pathname), read);
  const slow = access.begin(authority);
  const denied = access.begin(authority);
  denied.deny(403);
  assert.equal(slow.retained(read.pathname), null);
  assert.throws(() => slow.admit(read), /Workspace access changed/);
  assert.equal(access.getSnapshot().kind, 'denied');
  const recovery = access.begin(authority);
  assert.equal(recovery.retained(read.pathname), null);
  recovery.admit({ ...read, workspace: { ...workspace, name: 'Restored' } });
  assert.equal(recovery.retained(read.pathname)?.workspace.name, 'Restored');
  slow.deny(404);
  assert.equal(access.getSnapshot().kind, 'admitted');
});

test('a late denial revokes a newer same-authority successful refresh', () => {
  const access = createWorkspaceAccess();
  const slow = access.begin(authority);
  access.begin(authority).admit(read);
  slow.deny(404);
  assert.equal(access.getSnapshot().kind, 'denied');
  assert.equal(access.begin(authority).retained(read.pathname), null);
});

test('identity changes and session clearing invalidate in-flight requests', () => {
  const access = createWorkspaceAccess();
  const old = access.begin(authority);
  old.admit(read);
  const next = access.begin({ ...authority, sessionId: 'session-B', userId: 'B' });
  assert.equal(next.retained(read.pathname), null);
  assert.throws(() => old.admit(read), /Workspace access changed/);
  next.admit(read);
  access.observe(authority)(403);
  old.deny(403);
  assert.equal(next.retained(read.pathname)?.workspace.name, 'QA');
  access.clear();
  assert.throws(() => next.admit(read), /Workspace access changed/);
  assert.equal(access.getSnapshot().kind, 'empty');
});

test('retained snapshots do not alias route objects or returned fallback reads', () => {
  const access = createWorkspaceAccess();
  const check = access.begin(authority);
  const input = structuredClone(read);
  check.admit(input);
  input.workspace.name = 'Mutated route';
  const retained = check.retained(read.pathname);
  assert.equal(retained?.workspace.name, 'QA');
  if (!retained) throw new Error('Expected retained read');
  retained.workspace.name = 'Mutated fallback';
  assert.equal(check.retained(read.pathname)?.workspace.name, 'QA');
  assert.equal(check.retained('/qa/agents'), null);
});
