import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversations } from '../../conversations/dist/index.js';
import { createTeamGitHubReads, createTeamGitHubSourceCheck } from '../src/team-reads.ts';
import { githubReadSchema } from '../src/read-contracts.ts';
import { fixture as integrationFixture } from '../../integrations/test/fixture.mjs';

async function fixture() {
  const f = await integrationFixture();
  try {
    f.input.repositories.push(
      { id: randomUUID(), owner: 'tulipfarm', repo: 'library' },
      { id: randomUUID(), owner: 'private', repo: 'hidden' },
    );
    await f.service.create(f.workspaceId, f.creator, f.input);
    const grants = {
      grants: [{ teamId: f.teamId, permissions: ['read', 'use'] }],
      sourceGrants: [],
      investigationGrants: f.input.repositories.slice(0, 2).map(source => ({
        teamId: f.teamId,
        sourceId: source.id,
        permissions: ['github.code.read', 'github.issues.read'],
      })),
    };
    await f.service.setGrants(f.workspaceId, f.creator, f.input.id, { ...grants, expectedGrantsVersion: 1 });
    const store = createConversations(f.runtime);
    const conversationId = randomUUID();
    await store.create(f.workspaceId, f.member.userId, { chatId: conversationId, commandId: randomUUID() });
    await f.owner.query(
      `INSERT INTO ${f.table('tf_github_chat_selection')} (conversation_id,account_id,account_generation,version,context_start,integration_id,integration_generation,investigation) VALUES ($1,NULL,NULL,1,1,$2,1,true)`,
      [conversationId, f.input.id],
    );
    const sent = await store.send(f.workspaceId, f.member.userId, conversationId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text: 'Investigate the handler.' }],
    });
    await f.owner.query(
      `UPDATE ${f.table('tf_conversation_turns')} SET status='processing',lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1`,
      [sent.turnId],
    );
    const binding = {
      integrationId: f.input.id,
      generation: 1,
      membershipId: f.member.membershipId,
      selectionVersion: 1,
      origin: { kind: 'chat', conversationId, turnId: sent.turnId },
    };
    const requests = [];
    let provider = async () => Response.json({ name: 'fixture' });
    const fetcher = async (url, init) => {
      requests.push({ url: String(url), init });
      return provider(url, init);
    };
    const options = { runtime: f.runtime, keyring: f.keyring, fetcher };
    const reads = createTeamGitHubReads(options);
    const read = (operation, sourceId) =>
      reads.read(f.workspaceId, f.member, binding, githubReadSchema.parse(operation), sourceId);
    return {
      ...f,
      grants,
      binding,
      requests,
      options,
      reads,
      read,
      setProvider(value) {
        provider = value;
      },
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}

test('team discovery omits unauthorized sources and searches pin repository targets and revision reads', async () => {
  const f = await fixture();
  try {
    const list = await f.reads.repositories(f.workspaceId, f.member, f.binding, { perPage: 1 });
    assert.equal(list.result.repositories.length, 1);
    assert.equal(list.result.nextPage, 2);
    const rest = await f.reads.repositories(f.workspaceId, f.member, f.binding, { page: 2, perPage: 1 });
    assert.equal(rest.result.repositories.length, 1);
    assert.equal(rest.result.nextPage, null);
    assert.equal(JSON.stringify([list, rest]).includes('hidden'), false);
    assert.equal(f.requests.length, 0);
    f.setProvider(async () =>
      Response.json({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            url: 'https://api.github.com/repos/tulipfarm/fixture/contents/src/handler.ts?ref=main',
            name: 'handler.ts',
          },
        ],
      }),
    );
    const found = await f.read({ kind: 'file.search', query: 'handler' }, f.input.repositories[0].id);
    assert.equal(new URL(f.requests[0].url).searchParams.get('q'), 'handler repo:tulipfarm/fixture');
    assert.deepEqual(found.sources[0].requiredPermissions, ['github.code.read']);
    assert.equal(found.sources[0].readProof.accessTargets[0].path, 'src/handler.ts');
    assert.equal(found.sources[0].investigation.selectionVersion, 1);
    f.setProvider(async () => Response.json({ name: 'handler.ts', content: 'YQ==' }));
    await f.read({ kind: 'file.read', owner: 'tulipfarm', repo: 'library', path: 'src/handler.ts', ref: 'fix/report' });
    assert.equal(new URL(f.requests.at(-1).url).searchParams.get('ref'), 'fix/report');
    const before = f.requests.length;
    for (const operation of [
      { kind: 'actions.runs', owner: 'tulipfarm', repo: 'fixture' },
      { kind: 'file.read', owner: 'private', repo: 'hidden', path: 'secret.ts' },
      { kind: 'project.list', owner: 'tulipfarm', ownerType: 'organization' },
    ])
      await assert.rejects(f.read(operation));
    await assert.rejects(
      f.read({ kind: 'file.search', query: 'repo:private/hidden' }, f.input.repositories[0].id),
      /read-unqualified/,
    );
    assert.equal(f.requests.length, before);
  } finally {
    await f.close();
  }
});

test('team search rejects provider results outside its repository and does not treat pull bodies as issues', async () => {
  const f = await fixture();
  try {
    f.setProvider(async () =>
      Response.json({
        total_count: 1,
        incomplete_results: false,
        items: [{ url: 'https://api.github.com/repos/private/hidden/contents/secret.ts' }],
      }),
    );
    await assert.rejects(
      f.read({ kind: 'file.search', query: 'secret' }, f.input.repositories[0].id),
      /read-forbidden/,
    );
    f.setProvider(async () =>
      Response.json({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            url: 'https://api.github.com/repos/tulipfarm/fixture/issues/7',
            html_url: 'https://github.com/tulipfarm/fixture/pull/7',
            number: 7,
            title: 'Private PR',
            state: 'open',
            comments: 0,
            created_at: '2026-10-13T00:00:00Z',
            updated_at: '2026-10-13T00:00:00Z',
            pull_request: {},
          },
        ],
      }),
    );
    await assert.rejects(f.read({ kind: 'issue.search', query: 'bug' }, f.input.repositories[0].id), /read-forbidden/);
    f.setProvider(async () =>
      Response.json({
        number: 7,
        title: 'PR',
        pull_request: { url: 'https://api.github.com/repos/tulipfarm/fixture/pulls/7' },
      }),
    );
    for (const kind of ['issue.read', 'issue.comments']) {
      const before = f.requests.length;
      await assert.rejects(f.read({ kind, owner: 'tulipfarm', repo: 'fixture', number: 7 }), /read-forbidden/);
      assert.equal(f.requests.length, before + 1, 'issue comments refuse PRs before fetching their comments');
    }
  } finally {
    await f.close();
  }
});

test('grant revocation during provider reads prevents disclosure and account changes never fall back', async () => {
  const f = await fixture();
  try {
    f.setProvider(async () => {
      await f.service.setGrants(f.workspaceId, f.creator, f.input.id, {
        ...f.grants,
        expectedGrantsVersion: 2,
        investigationGrants: [],
      });
      return Response.json({ secret: 'must not be returned' });
    });
    await assert.rejects(f.read({ kind: 'repository.read', owner: 'tulipfarm', repo: 'fixture' }), /not found/);
    assert.equal(f.requests.length, 1);
    await f.owner.query(`UPDATE ${f.table('tf_github_chat_selection')} SET version=2 WHERE conversation_id=$1`, [
      f.binding.origin.conversationId,
    ]);
    await assert.rejects(
      f.read({ kind: 'repository.read', owner: 'tulipfarm', repo: 'fixture' }),
      /selection-conflict/,
    );
    assert.equal(f.requests.length, 1);
  } finally {
    await f.close();
  }
});

test('team retained evidence detects provider revocation and distinguishes unavailable providers', async () => {
  const f = await fixture();
  try {
    const result = await f.read({ kind: 'repository.read', owner: 'tulipfarm', repo: 'fixture' });
    const checker = () => createTeamGitHubSourceCheck({ ...f.options, workspaceId: f.workspaceId });
    await checker()(f.member, result.sources[0]);
    f.setProvider(async () => Response.json({}, { status: 401 }));
    await assert.rejects(checker()(f.member, result.sources[0]), error => error.constructor.name === 'AccessDenied');
    f.setProvider(async () => Response.json({}, { status: 429 }));
    await assert.rejects(
      checker()(f.member, result.sources[0]),
      error => error.constructor.name === 'SourceAuthorizationUnavailable',
    );
    f.setProvider(async () => {
      throw new Error('network unavailable');
    });
    await assert.rejects(
      checker()(f.member, result.sources[0]),
      error => error.constructor.name === 'SourceAuthorizationUnavailable',
    );
  } finally {
    await f.close();
  }
});

test('retained provider checks cache exact evidence and enforce the shared request budget', async () => {
  const f = await fixture();
  try {
    const result = await f.read({ kind: 'file.read', owner: 'tulipfarm', repo: 'fixture', path: 'first.ts' });
    const check = createTeamGitHubSourceCheck({ ...f.options, workspaceId: f.workspaceId });
    const before = f.requests.length;
    await check(f.member, result.sources[0]);
    await check(f.member, result.sources[0]);
    assert.equal(f.requests.length, before + 1);
    for (let index = 1; index < 32; index++) {
      await check(f.member, {
        ...result.sources[0],
        readProof: { operation: { ...result.sources[0].readProof.operation, path: `file-${index}.ts` } },
      });
    }
    await assert.rejects(
      check(f.member, {
        ...result.sources[0],
        readProof: { operation: { ...result.sources[0].readProof.operation, path: 'over-budget.ts' } },
      }),
      error => error.constructor.name === 'SourceAuthorizationUnavailable',
    );
    assert.equal(f.requests.length, before + 32);
  } finally {
    await f.close();
  }
});
