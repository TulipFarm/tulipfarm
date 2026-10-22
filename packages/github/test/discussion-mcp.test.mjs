import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchGitHubWrite, writeBindingsSchema } from '../dist/write-provider.js';
import { discussionOperations } from './discussion-provider-fixture.mjs';
import { mcpWriteFixture } from './mcp-write-fixture.mjs';

const credential = {
  accessToken: 'synthetic-discussion-token',
  identity: { id: '123', login: 'octocat' },
  scopes: ['repo'],
};
for (const operation of discussionOperations.slice(4))
  test(`official discussion_comment_write ${operation.kind} checks its actual response contract`, async () => {
    const answer = operation.kind.startsWith('discussion.answer-');
    const value = answer
      ? { discussionID: 'D_7', discussionURL: 'https://github.com/octocat/private/discussions/7' }
      : { id: 'DC_1', url: 'https://github.com/octocat/private/discussions/7#discussioncomment-1' };
    const args = {
      method: {
        'discussion.comment-update': 'update',
        'discussion.comment-delete': 'delete',
        'discussion.answer-mark': 'mark_answer',
        'discussion.answer-unmark': 'unmark_answer',
      }[operation.kind],
      commentNodeID: operation.commentId,
      ...('body' in operation ? { body: operation.body } : {}),
    };
    const item = { operation, name: 'discussion_comment_write', args, text: JSON.stringify(value) };
    for (const [result, expected] of [
      [{ content: [{ type: 'text', text: item.text }] }, 'succeeded'],
      [
        {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ...value, ...(answer ? { discussionID: 'D_wrong' } : { id: 'DC_wrong' }) }),
            },
          ],
        },
        'unknown',
      ],
      [{ content: [{ type: 'text', text: item.text }], structuredContent: {} }, 'unknown'],
      [{ content: [{ type: 'text', text: item.text }], isError: true }, 'unknown'],
    ]) {
      const effects = [],
        f = await mcpWriteFixture({ item, result, effect: call => effects.push(call) });
      try {
        const outcome = await dispatchGitHubWrite({
          operation,
          credential,
          bindings: writeBindingsSchema.parse(f.bindings),
          fetcher: f.fetcher,
          authorize: async () => true,
        });
        assert.equal(outcome.status, expected);
        assert.deepEqual(effects, [{ name: item.name, arguments: args }]);
        if (expected === 'succeeded') {
          assert.equal(outcome.result.discussionId, 'D_7');
          assert.equal(outcome.result.commentId, operation.commentId);
        }
      } finally {
        await f.close();
      }
    }
    const f = await mcpWriteFixture({ item });
    try {
      assert.deepEqual(
        await dispatchGitHubWrite({
          operation,
          credential,
          bindings: [{ ...f.bindings[0], contractDigest: '0'.repeat(64) }],
          fetcher: f.fetcher,
          authorize: async () => true,
        }),
        { status: 'unknown', result: null },
      );
      assert.equal(f.calls.length, 0);
    } finally {
      await f.close();
    }
  });
