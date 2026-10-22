import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireInvestigationToolBoundary } from '../src/investigation-boundary.ts';
import { githubTaskCallSchema } from '../src/github-task-contracts.ts';
import { frameworkCallSchema, readOnlyTools } from '../src/tools.ts';
import { readSkill } from '../src/skills.ts';
import { sourceDependencySchema } from '@tulipfarm/access';
import { createGitHubReads } from '@tulipfarm/github/reads';
import { createGitHubInvestigation } from '@tulipfarm/github/investigation';
import { createGitHubTaskTools } from '../src/github-tasks.ts';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';

test('investigation tools are read-only fixed contracts, never model-selected credentials', () => {
  for (const tool of ['github.investigation.account', 'github.investigation.repositories', 'github.investigation.read'])
    assert.equal(readOnlyTools.has(tool), true);
  assert.equal(
    githubTaskCallSchema.safeParse({
      tool: 'github.investigation.account',
      accountId: '11111111-1111-4111-8111-111111111111',
    }).success,
    false,
  );
  assert.equal(
    frameworkCallSchema.safeParse({
      tool: 'github.investigation.read',
      operation: { kind: 'shell', command: 'git clone' },
    }).success,
    false,
  );
  assert.match(readSkill('github-investigation').instructions, /untrusted evidence/);
});

test('scope blocks all alternate providers and writes while allowing investigation reads', async () => {
  const tx = {
    schema: 'fixture',
    client: {
      query: async () => ({
        rows: [
          {
            accountId: null,
            generation: null,
            integrationId: null,
            integrationGeneration: null,
            investigation: true,
            version: 1,
          },
        ],
        rowCount: 1,
      }),
    },
  };
  const id = '11111111-1111-4111-8111-111111111111';
  const chat = { conversationId: id, turnId: id };
  const task = { taskId: id, generation: 1 };
  for (const origin of [chat, task]) {
    for (const tool of [
      'github.personal.account',
      'github.personal.read',
      'github.personal.download',
      'github.personal.propose',
      'github.personal.execute',
      'github.issue.read',
      'slack.message.send',
      'web.fetch',
      'skills.execute',
      'rows.create',
    ])
      await assert.rejects(requireInvestigationToolBoundary(tx, origin, tool));
    await requireInvestigationToolBoundary(tx, origin, 'github.investigation.read');
    await requireInvestigationToolBoundary(tx, origin, 'skills.read');
  }
  await requireInvestigationToolBoundary(
    { ...tx, client: { query: async () => ({ rows: [], rowCount: 0 }) } },
    chat,
    'github.personal.propose',
  );
});

test('GitHub selection runtimes check common compatibility before admitting transactions', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  let admissions = 0;
  const runtime = {
    transaction: async (_workspaceId, range) => {
      admissions++;
      assert.equal(range.minimum, 1);
      throw new StorageUnavailableError('incompatible_version');
    },
  };
  const options = { runtime, accounts: {}, requireSources: async () => assert.fail('must not reach source reads') };
  await assert.rejects(
    createGitHubReads(options).selection(id, 'fixture-user', id),
    error => error.code === 'incompatible_version',
  );
  await assert.rejects(
    createGitHubInvestigation(options).choices(id, 'fixture-user', id),
    error => error.code === 'incompatible_version',
  );
  await assert.rejects(
    createGitHubTaskTools(options).execute({
      workspaceId: id,
      actor: { kind: 'human', userId: 'fixture-user', membershipId: id },
      taskId: id,
      generation: 0,
      callId: id,
      call: { tool: 'github.investigation.account' },
    }),
    error => error.code === 'incompatible_version',
  );
  assert.equal(admissions, 3);
});

test('team retained evidence carries a private selection binding and fixed read proof', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const source = {
    kind: 'github-source',
    integrationId: id,
    sourceId: id,
    generation: 1,
    grantsVersion: 1,
    requiredPermissions: ['github.code.read'],
    readProof: { operation: { kind: 'file.read', owner: 'example', repo: 'web', path: 'index.ts' } },
    investigation: { membershipId: id, selectionVersion: 2, origin: { kind: 'chat', conversationId: id } },
  };
  assert.equal(sourceDependencySchema.safeParse(source).success, true);
  assert.equal(
    sourceDependencySchema.safeParse({
      ...source,
      investigation: { ...source.investigation, origin: { kind: 'shared', conversationId: id } },
    }).success,
    false,
  );
  assert.equal(
    sourceDependencySchema.safeParse({ ...source, requiredPermissions: ['github.issue.read'] }).success,
    false,
  );
});
