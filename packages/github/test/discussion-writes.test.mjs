import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClientSchema, parse, validate } from 'graphql';
import { schema } from '@octokit/graphql-schema';
import { githubWriteSchema } from '../dist/batch-contracts.js';
import { discussionDocuments } from '../dist/discussion-writes.js';
import { dispatchGitHubWrite, requireWriteTarget, reconcileGitHubWrite } from '../dist/write-provider.js';
import { discussionOperations, discussionProviderFixture } from './discussion-provider-fixture.mjs';

const credential = {
  accessToken: 'synthetic-discussion-token',
  identity: { id: '123', login: 'octocat' },
  scopes: ['repo'],
};
test('actual fixed Discussion documents validate against the published GitHub schema', () => {
  const s = buildClientSchema(schema.json.data ?? schema.json);
  for (const document of Object.values(discussionDocuments)) assert.deepEqual(validate(s, parse(document)), []);
  assert.notDeepEqual(
    validate(s, parse('mutation($input: DeleteDiscussionInput!) { deleteDiscussion(input:$input) { deletedId } }')),
    [],
  );
});
for (const original of discussionOperations)
  test(`${original.kind} executes schema-coerced variables over provider HTTP`, async () => {
    const f = await discussionProviderFixture(),
      operation = githubWriteSchema.parse(original);
    try {
      await requireWriteTarget(operation, credential, f.fetcher, true);
      const outcome = await dispatchGitHubWrite({
        operation,
        credential,
        fetcher: f.fetcher,
        bindings: [],
        authorize: async () => true,
      });
      assert.equal(outcome.status, 'succeeded');
      assert.equal(outcome.result.repositoryId, 42);
      assert.equal(f.effects.length, 1);
      assert.deepEqual(f.schemaErrors, []);
      if (operation.kind === 'discussion.create') assert.equal(f.discussions.get('D_9').title, 'Release questions');
      if (operation.kind === 'discussion.update') assert.equal(f.discussions.get('D_7').body, 'Updated body.');
      if (operation.kind === 'discussion.delete') assert.equal(f.discussions.has('D_7'), false);
      if (operation.kind === 'discussion.comment-create') assert.equal(f.comments.get('DC_3').body, 'New answer.');
      if (operation.kind === 'discussion.comment-update') assert.equal(f.comments.get('DC_1').body, 'Updated answer.');
      if (operation.kind === 'discussion.comment-delete') assert.equal(f.comments.has('DC_1'), false);
      if (operation.kind === 'discussion.answer-mark') assert.equal(f.discussions.get('D_7').answer.id, 'DC_1');
      if (operation.kind === 'discussion.answer-unmark') assert.equal(f.discussions.get('D_7').answer, null);
      assert.equal(
        (await reconcileGitHubWrite({ operation, credential, fetcher: f.fetcher, marker: 'unused' })).result,
        null,
      );
      assert.equal(f.effects.length, 1);
    } finally {
      await f.close();
    }
  });
test('strict actions reject arbitrary GraphQL URLs and absent stable identities', () => {
  assert.deepEqual(githubWriteSchema.parse(discussionOperations[0]), discussionOperations[0]);
  for (const key of ['repositoryId', 'repositoryNodeId', 'ownerNodeId', 'categoryId']) {
    const value = { ...discussionOperations[0] };
    delete value[key];
    assert.equal(githubWriteSchema.safeParse(value).success, false);
  }
  for (const key of ['query', 'url', 'variables', 'clientMutationId'])
    assert.equal(githubWriteSchema.safeParse({ ...discussionOperations[0], [key]: 'arbitrary' }).success, false);
});
for (const mode of ['partial', 'malformed', 'lose'])
  test(`${mode} mutation response cannot become success or a fallback effect`, async () => {
    const f = await discussionProviderFixture();
    try {
      f.state[mode] = true;
      await assert.rejects(
        dispatchGitHubWrite({
          operation: discussionOperations[0],
          credential,
          fetcher: f.fetcher,
          bindings: [],
          authorize: async () => true,
        }),
      );
      assert.equal(f.discussions.get('D_9').title, 'Release questions');
      assert.equal(f.effects.length, 1);
    } finally {
      await f.close();
    }
  });
test('current owner repository category discussion comment and rights checks stop foreign or denied writes', async () => {
  const f = await discussionProviderFixture();
  try {
    await requireWriteTarget(discussionOperations[4], credential, f.fetcher, true);
    for (const patch of [
      { ownerNodeId: 'U_wrong' },
      { repositoryNodeId: 'R_wrong' },
      { repositoryId: 99 },
      { discussionId: 'D_8' },
      { commentId: 'DC_missing' },
    ])
      await assert.rejects(requireWriteTarget({ ...discussionOperations[4], ...patch }, credential, f.fetcher, true));
    await assert.rejects(
      requireWriteTarget(discussionOperations[0], { ...credential, scopes: ['read:project'] }, f.fetcher, true),
    );
    f.comments.get('DC_1').viewerCanUpdate = false;
    await assert.rejects(requireWriteTarget(discussionOperations[4], credential, f.fetcher, true));
    assert.equal(f.effects.length, 0);
    f.comments.get('DC_1').viewerCanUpdate = true;
    const result = await dispatchGitHubWrite({
      operation: discussionOperations[4],
      credential,
      fetcher: f.fetcher,
      bindings: [],
      authorize: async () => true,
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(f.comments.get('DC_1').body, 'Updated answer.');
  } finally {
    await f.close();
  }
});
