import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import {
  answerCodeSessionRequest,
  appendCodeSessionTerminalChunk,
  CodeSessionError,
  createCodeSession,
  getMemberCodeSettings,
  listCodeSessions,
  listCodeSessionTerminalChunks,
  listOpenCodeSessionRequestsForMember,
  openCodeSessionRequest,
  readCodeSession,
  stopCodeSession,
  updateMemberCodeSettings,
} from '../src/code-session-store.ts';

async function harness(t) {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await loadPlatformBaseline(db.platform);
  const workspace = await db.create(await workspaceTableMigrations());
  const schema = `"${workspace.names.schema}"`;
  runtime = createWorkspaceRuntime({
    resolveCredential: async () => ({
      workspaceId: workspace.id,
      generation: 1,
      connectionString: db.login(workspace),
    }),
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
  });

  const peerUserId = randomUUID();
  const peerMembershipId = randomUUID();
  await db.platform.query(`INSERT INTO ${schema}.tf_memberships (id, user_id, role) VALUES ($1, $2, 'member')`, [
    peerMembershipId,
    peerUserId,
  ]);

  const owner = { kind: 'human', userId: workspace.userId, membershipId: workspace.membershipId };
  const peer = { kind: 'human', userId: peerUserId, membershipId: peerMembershipId };
  return { db, runtime, workspace, schema, owner, peer };
}

test('code sessions persist settings, stream terminal chunks, enforce visibility, and sync inline/Inbox answers', async t => {
  const { db, runtime, workspace, schema, owner, peer } = await harness(t);

  const initialSettings = await getMemberCodeSettings(runtime, workspace.id, owner);
  assert.equal(initialSettings.branchPrefix, 'tulipfarm');

  const updatedSettings = await updateMemberCodeSettings(runtime, workspace.id, owner, {
    branchPrefix: 'dev-code',
    openPullRequests: true,
    openAsDraft: true,
    reviewers: [{ agent: 'codex' }],
  });
  assert.equal(updatedSettings.branchPrefix, 'dev-code');
  assert.equal(updatedSettings.openAsDraft, true);

  const [{ id: tableId }] = (
    await db.platform.query(`SELECT core_definition->>'id' AS id FROM ${schema}.tf_system_tables WHERE kind = 'tasks'`)
  ).rows;
  const rowId = randomUUID();
  const created = await createCodeSession(runtime, workspace.id, owner, {
    request: 'Add readiness check endpoint',
    tableId,
    rowId,
    start: {
      agent: 'copilot',
      repository: 'TulipFarm/tulipfarm',
      baseBranch: 'main',
    },
  });
  assert.equal(created.stage, 'brainstorm');
  assert.equal(created.rowId, rowId);
  assert.ok(created.sessionBranch.startsWith('dev-code/'));

  await appendCodeSessionTerminalChunk(runtime, workspace.id, {
    sessionId: created.id,
    stage: 'brainstorm',
    stream: 'stdout',
    chunk: 'Scanning apps/api/src/health.ts',
  });

  const opened = await openCodeSessionRequest(runtime, workspace.id, created.id, {
    kind: 'question',
    question: 'Check Temporal too?',
    questionIndex: 1,
    totalQuestions: 1,
    options: [
      { number: 1, label: 'Yes, Postgres + Temporal', recommended: true },
      { number: 2, label: 'Postgres only' },
    ],
    allowFreeText: true,
  });

  // Retrying openCodeSessionRequest with the same payload is idempotent.
  const openedAgain = await openCodeSessionRequest(runtime, workspace.id, created.id, {
    kind: 'question',
    question: 'Check Temporal too?',
    questionIndex: 1,
    totalQuestions: 1,
    options: [
      { number: 1, label: 'Yes, Postgres + Temporal', recommended: true },
      { number: 2, label: 'Postgres only' },
    ],
    allowFreeText: true,
  });
  assert.equal(openedAgain.id, opened.id);

  const openForOwner = await listOpenCodeSessionRequestsForMember(runtime, workspace.id, owner);
  assert.equal(openForOwner.length, 1);
  assert.equal(openForOwner[0].request.id, opened.id);

  // Peer without repo read access sees workspace summary only, masked branch, and zero terminal logs.
  const peerSummary = await readCodeSession(runtime, workspace.id, peer, created.id, {
    canReadRepo: async () => false,
  });
  assert.equal(peerSummary.title, created.title);
  assert.equal(peerSummary.stage, 'brainstorm');
  assert.equal(peerSummary.sessionBranch, 'protected');
  assert.equal(peerSummary.request, null);
  assert.equal(peerSummary.openRequest, null);
  assert.equal(peerSummary.isOwner, false);
  const peerNoLogs = await listCodeSessionTerminalChunks(runtime, workspace.id, peer, created.id, {
    canReadRepo: async () => false,
  });
  assert.equal(peerNoLogs.length, 0);

  // Private chat-origin sessions (no rowId) are never listed to peers in workspace scope.
  const privateSession = await createCodeSession(runtime, workspace.id, owner, {
    request: 'Secret private prompt',
    start: { agent: 'copilot', repository: 'TulipFarm/tulipfarm', baseBranch: 'main' },
  });
  const peerWorkspaceList = await listCodeSessions(runtime, workspace.id, peer, { scope: 'workspace' });
  assert.equal(peerWorkspaceList.length, 1);
  assert.equal(peerWorkspaceList[0].id, created.id);
  assert.notEqual(peerWorkspaceList[0].id, privateSession.id);
  assert.equal(peerWorkspaceList[0].sessionBranch, 'protected');

  // Peer with repo read access can read terminal logs, still cannot see/answer owner's openRequest.
  const peerWithLogs = await listCodeSessionTerminalChunks(runtime, workspace.id, peer, created.id, {
    canReadRepo: async () => true,
  });
  assert.ok(peerWithLogs.length >= 3);
  await assert.rejects(
    () =>
      answerCodeSessionRequest(runtime, workspace.id, peer, {
        sessionId: created.id,
        requestId: opened.id,
        answer: { kind: 'question', optionNumber: 1, text: 'Yes, Postgres + Temporal' },
      }),
    error => error instanceof CodeSessionError && error.code === 'code-session-not-owner',
  );

  // Owner cannot submit mismatched answer kind.
  await assert.rejects(
    () =>
      answerCodeSessionRequest(runtime, workspace.id, owner, {
        sessionId: created.id,
        requestId: opened.id,
        answer: { kind: 'plan-approval', decision: 'approve' },
      }),
    error => error instanceof CodeSessionError && error.code === 'code-session-invalid-answer',
  );

  // Owner answers the question; Inbox item resolves and answer chunk streams to terminal.
  await answerCodeSessionRequest(runtime, workspace.id, owner, {
    sessionId: created.id,
    requestId: opened.id,
    answer: { kind: 'question', optionNumber: 1, text: 'Yes, Postgres + Temporal' },
  });
  // Replaying the exact same answer is idempotent.
  await answerCodeSessionRequest(runtime, workspace.id, owner, {
    sessionId: created.id,
    requestId: opened.id,
    answer: { kind: 'question', optionNumber: 1, text: 'Yes, Postgres + Temporal' },
  });

  const remaining = await listOpenCodeSessionRequestsForMember(runtime, workspace.id, owner);
  assert.equal(remaining.length, 0);

  const inboxRows = await db.platform.query(
    `SELECT resolved_at IS NOT NULL AS resolved FROM ${schema}.tf_inbox_items WHERE source_id = $1`,
    [opened.id],
  );
  assert.equal(inboxRows.rows[0]?.resolved, true);

  const chunks = await listCodeSessionTerminalChunks(runtime, workspace.id, owner, created.id);
  assert.equal(chunks.at(-1)?.stream, 'answer');
  assert.match(chunks.at(-1)?.chunk ?? '', /Yes, Postgres \+ Temporal/);

  // Workspace-scoped list returns row-linked session for Tasks board.
  const workspaceSessions = await listCodeSessions(runtime, workspace.id, peer, { scope: 'workspace' });
  assert.equal(workspaceSessions.length, 1);
  assert.equal(workspaceSessions[0].rowId, rowId);

  // Stop is idempotent.
  const stoppedOnce = await stopCodeSession(runtime, workspace.id, owner, created.id);
  const stoppedTwice = await stopCodeSession(runtime, workspace.id, owner, created.id);
  assert.equal(stoppedOnce.stage, 'stopped');
  assert.equal(stoppedTwice.stage, 'stopped');
});
