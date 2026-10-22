import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  AccessDenied,
  knowledgeSourceDependencySchema,
  sourceDependencySchema,
  protectedSourceClosure,
  mcpSourceClosure,
  requireProtectedSource,
  requireNoMcpDerived,
} from '../dist/index.js';

const actor = { kind: 'human', userId: 'owner', membershipId: randomUUID() };
const knowledge = () => ({
  kind: 'knowledge-document',
  workspaceId: randomUUID(),
  sourceId: randomUUID(),
  documentId: randomUUID(),
  revisionId: randomUUID(),
  publicationId: randomUUID(),
  accessEpoch: 1,
});
const transaction = (hooks = {}) => ({
  schema: 'workspace',
  client: {
    query: async sql => {
      if (sql === 'SELECT to_regclass($1) IS NOT NULL AS installed')
        return { rows: [{ installed: false }], rowCount: 1 };
      throw new Error(`Unexpected query ${sql}`);
    },
  },
  ...hooks,
});

test('knowledge dependency validates every identity and a positive integral access epoch', () => {
  const source = knowledge();
  assert.deepEqual(sourceDependencySchema.parse(source), source);
  assert.deepEqual(
    knowledgeSourceDependencySchema.parse({ ...source, workspaceId: source.workspaceId.toUpperCase() }),
    source,
  );
  for (const field of ['workspaceId', 'sourceId', 'documentId', 'revisionId', 'publicationId']) {
    assert.equal(sourceDependencySchema.safeParse({ ...source, [field]: 'invalid' }).success, false);
  }
  for (const accessEpoch of [0, -1, 1.5])
    assert.equal(sourceDependencySchema.safeParse({ ...source, accessEpoch }).success, false);
});

test('knowledge authorization and both closures fail closed without their respective hook', async () => {
  const source = knowledge();
  await assert.rejects(requireProtectedSource(transaction(), actor, source), AccessDenied);
  for (const closure of [protectedSourceClosure, mcpSourceClosure]) {
    await assert.rejects(closure(transaction({ requireKnowledgeSource: async () => {} }), [source]), AccessDenied);
  }
  await assert.rejects(
    requireProtectedSource(transaction({ knowledgeSourceDependencies: async () => [] }), actor, source),
    AccessDenied,
  );
});

test('knowledge authorization passes the actor, reference, run and public restriction unchanged', async () => {
  const source = knowledge(),
    runId = randomUUID();
  const requests = [];
  const tx = transaction({
    requireKnowledgeSource: async (...args) => {
      requests.push(args);
      if (args[2].publicOnly || args[2].runId) throw new AccessDenied();
    },
  });
  await requireProtectedSource(tx, actor, source);
  await assert.rejects(requireProtectedSource(tx, actor, source, runId, false), AccessDenied);
  await assert.rejects(requireProtectedSource(tx, actor, source, runId, true), AccessDenied);
  await assert.rejects(requireProtectedSource(tx, actor, source, undefined, true), AccessDenied);
  assert.deepEqual(requests, [
    [actor, source, { publicOnly: false }],
    [actor, source, { runId, publicOnly: false }],
    [actor, source, { runId, publicOnly: true }],
    [actor, source, { publicOnly: true }],
  ]);
});

test('persisted knowledge closure exposes nested personal and MCP sources without an MCP table', async () => {
  const root = knowledge(),
    child = knowledge();
  const personal = {
    kind: 'github-personal',
    accountId: randomUUID(),
    membershipId: actor.membershipId,
    generation: 1,
    selectionVersion: 1,
    conversationId: randomUUID(),
  };
  const mcp = { kind: 'mcp-integration', integrationId: randomUUID(), authorizationEpoch: 2 };
  const tx = transaction({
    knowledgeSourceDependencies: async source => (source.documentId === root.documentId ? [child] : [personal, mcp]),
  });
  const retained = await protectedSourceClosure(tx, [root]);
  assert.deepEqual(retained, [root, child, personal, mcp]);
  for (const source of retained.filter(
    source => source.kind === 'github-personal' || source.kind === 'mcp-integration',
  )) {
    await assert.rejects(requireProtectedSource(tx, actor, source, undefined, true), AccessDenied);
  }
  assert.deepEqual(await mcpSourceClosure(tx, [root]), [mcp]);
  await assert.rejects(requireNoMcpDerived(tx, [root]), AccessDenied);
});

test('knowledge cycles fail closed and unique dependency traversal remains bounded', async () => {
  const source = knowledge();
  for (const closure of [protectedSourceClosure, mcpSourceClosure]) {
    await assert.rejects(
      closure(transaction({ knowledgeSourceDependencies: async () => [source] }), [source]),
      AccessDenied,
    );
    await assert.rejects(
      closure(
        transaction({ knowledgeSourceDependencies: async ref => [{ ...ref, accessEpoch: ref.accessEpoch + 1 }] }),
        [source],
      ),
      AccessDenied,
    );
  }
});

test('shared transitive dependencies are not mistaken for cycles', async () => {
  const root = knowledge(),
    left = knowledge(),
    right = knowledge(),
    leaf = knowledge();
  const tx = transaction({
    knowledgeSourceDependencies: async source =>
      source.documentId === root.documentId ? [left, right] : source.documentId === leaf.documentId ? [] : [leaf],
  });
  assert.deepEqual(await protectedSourceClosure(tx, [root]), [root, left, right, leaf]);
});
