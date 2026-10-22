import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { buildClientSchema, graphql } from 'graphql';
import { schema } from '@octokit/graphql-schema';

export const discussionTarget = {
  owner: 'octocat',
  repo: 'private',
  repositoryId: 42,
  repositoryNodeId: 'R_42',
  ownerNodeId: 'U_123',
};
export const existingDiscussion = { ...discussionTarget, discussionId: 'D_7', discussionNumber: 7 };
export const discussionOperations = [
  {
    kind: 'discussion.create',
    ...discussionTarget,
    categoryId: 'DIC_1',
    title: 'Release questions',
    body: 'Ask here.',
  },
  {
    kind: 'discussion.update',
    ...existingDiscussion,
    categoryId: 'DIC_1',
    title: 'Updated questions',
    body: 'Updated body.',
  },
  { kind: 'discussion.delete', ...existingDiscussion },
  { kind: 'discussion.comment-create', ...existingDiscussion, replyToId: null, body: 'New answer.' },
  { kind: 'discussion.comment-update', ...existingDiscussion, commentId: 'DC_1', body: 'Updated answer.' },
  { kind: 'discussion.comment-delete', ...existingDiscussion, commentId: 'DC_1' },
  { kind: 'discussion.answer-mark', ...existingDiscussion, commentId: 'DC_1' },
  { kind: 'discussion.answer-unmark', ...existingDiscussion, commentId: 'DC_2' },
];
const apiSchema = buildClientSchema(schema.json.data ?? schema.json);
export async function discussionProviderFixture(nativeFetch = fetch) {
  const state = {
    deny: false,
    outsideDeny: false,
    lose: false,
    partial: false,
    malformed: false,
    status: null,
    afterEffect: null,
  };
  const effects = [],
    requests = [],
    schemaErrors = [];
  const repository = {
    __typename: 'Repository',
    id: 'R_42',
    databaseId: 42,
    name: 'private',
    nameWithOwner: 'octocat/private',
    owner: { __typename: 'User', id: 'U_123', databaseId: 123, login: 'octocat' },
    isArchived: false,
    hasDiscussionsEnabled: true,
    viewerPermission: 'ADMIN',
  };
  const category = {
    __typename: 'DiscussionCategory',
    id: 'DIC_1',
    name: 'Help',
    description: 'Questions',
    emoji: ':question:',
    isAnswerable: true,
    repository,
  };
  const stamp = '2026-10-02T00:00:00Z';
  const discussions = new Map(),
    comments = new Map();
  const page = nodes => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null }, totalCount: nodes.length });
  const makeDiscussion = (id, number, title, body) => ({
    __typename: 'Discussion',
    id,
    number,
    title,
    body,
    repository,
    category,
    locked: false,
    viewerCanUpdate: true,
    viewerCanDelete: true,
    url: `https://github.com/octocat/private/discussions/${number}`,
    createdAt: stamp,
    updatedAt: stamp,
    author: repository.owner,
    answer: null,
    comments: () => page([...comments.values()].filter(c => c.discussion.id === id && !c.replyTo)),
  });
  const makeComment = (id, discussion, body, replyTo = null) => ({
    __typename: 'DiscussionComment',
    id,
    body,
    discussion,
    replyTo,
    isAnswer: false,
    viewerCanUpdate: true,
    viewerCanDelete: true,
    viewerCanMarkAsAnswer: true,
    viewerCanUnmarkAsAnswer: true,
    url: `${discussion.url}#discussioncomment-${id.replace('DC_', '')}`,
    createdAt: stamp,
    updatedAt: stamp,
    author: repository.owner,
    replies: () => page([...comments.values()].filter(c => c.replyTo?.id === id)),
  });
  discussions.set('D_7', makeDiscussion('D_7', 7, 'Question', 'Original body.'));
  discussions.set('D_8', makeDiscussion('D_8', 8, 'Unrelated', 'Unrelated body.'));
  comments.set('DC_1', makeComment('DC_1', discussions.get('D_7'), 'Original answer.'));
  comments.set('DC_2', { ...makeComment('DC_2', discussions.get('D_7'), 'Chosen answer.'), isAnswer: true });
  discussions.get('D_7').answer = comments.get('DC_2');
  repository.discussion = ({ number }) => [...discussions.values()].find(d => d.number === number) ?? null;
  repository.discussions = () => page([...discussions.values()]);
  repository.discussionCategories = () => page([category]);
  const roots = {
    repository: () => (state.deny ? null : repository),
    node: ({ id }) =>
      state.deny ? null : id === category.id ? category : (discussions.get(id) ?? comments.get(id) ?? null),
  };
  const effect =
    (name, apply) =>
    ({ input }) => {
      const value = apply(input);
      effects.push({ name, input });
      return value;
    };
  Object.assign(roots, {
    createDiscussion: effect('createDiscussion', input => {
      assert.equal(input.repositoryId, 'R_42');
      assert.equal(input.categoryId, 'DIC_1');
      const d = makeDiscussion('D_9', 9, input.title, input.body);
      discussions.set(d.id, d);
      return { discussion: d };
    }),
    updateDiscussion: effect('updateDiscussion', input => {
      const d = discussions.get(input.discussionId);
      Object.assign(d, { title: input.title, body: input.body });
      return { discussion: d };
    }),
    deleteDiscussion: effect('deleteDiscussion', input => {
      const d = discussions.get(input.id);
      discussions.delete(input.id);
      for (const [id, c] of comments) if (c.discussion.id === input.id) comments.delete(id);
      return { discussion: d };
    }),
    addDiscussionComment: effect('addDiscussionComment', input => {
      const c = makeComment(
        'DC_3',
        discussions.get(input.discussionId),
        input.body,
        input.replyToId ? comments.get(input.replyToId) : null,
      );
      comments.set(c.id, c);
      return { comment: c };
    }),
    updateDiscussionComment: effect('updateDiscussionComment', input => {
      const c = comments.get(input.commentId);
      c.body = input.body;
      return { comment: c };
    }),
    deleteDiscussionComment: effect('deleteDiscussionComment', input => {
      const c = comments.get(input.id);
      comments.delete(input.id);
      return { comment: c };
    }),
    markDiscussionCommentAsAnswer: effect('markDiscussionCommentAsAnswer', input => {
      const c = comments.get(input.id);
      if (c.discussion.answer) c.discussion.answer.isAnswer = false;
      c.isAnswer = true;
      c.discussion.answer = c;
      return { discussion: c.discussion };
    }),
    unmarkDiscussionCommentAsAnswer: effect('unmarkDiscussionCommentAsAnswer', input => {
      const c = comments.get(input.id);
      c.isAnswer = false;
      c.discussion.answer = null;
      return { discussion: c.discussion };
    }),
  });
  const server = createServer(async (request, response) => {
    const reply = (value, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString(),
        body = raw ? JSON.parse(raw) : null;
      requests.push({ method: request.method, path: request.url, body });
      if (request.url === '/repos/outside/source')
        return reply({ id: 777, full_name: 'outside/source' }, state.outsideDeny ? 403 : 200);
      if (request.url === '/repos/octocat/private')
        return reply(
          {
            id: repository.databaseId,
            node_id: repository.id,
            owner: { node_id: repository.owner.id },
            full_name: repository.nameWithOwner,
          },
          state.deny ? 403 : 200,
        );
      if (request.url === '/repos/octocat/private/issues/7')
        return reply({ id: 70, number: 7 }, state.deny ? 403 : 200);
      if (request.url === '/repos/octocat/private/issues/7/comments') {
        effects.push({ name: 'issueComment', input: body });
        return reply({ id: 71 }, 201);
      }
      assert.equal(request.url, '/graphql');
      assert.equal(request.method, 'POST');
      const isMutation = body.query.startsWith('mutation');
      if (isMutation && state.status) return reply({}, state.status);
      const result = await graphql({
        schema: apiSchema,
        source: body.query,
        variableValues: body.variables,
        rootValue: roots,
        typeResolver: value => value.__typename,
      });
      if (result.errors) schemaErrors.push(...result.errors.map(error => error.message));
      if (isMutation) {
        await state.afterEffect?.();
        if (state.lose) {
          response.destroy();
          return;
        }
      }
      reply(
        isMutation && state.malformed
          ? { data: { result: {} } }
          : isMutation && state.partial
            ? { ...result, errors: [{ message: 'partial mutation result' }] }
            : result,
      );
    } catch (error) {
      schemaErrors.push(String(error));
      reply({ errors: [{ message: String(error) }] }, 500);
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    state,
    effects,
    requests,
    schemaErrors,
    repository,
    category,
    discussions,
    comments,
    fetcher: (url, init) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://api.github.com');
      assert.equal(init.redirect, 'error');
      return nativeFetch(`http://127.0.0.1:${server.address().port}${parsed.pathname}${parsed.search}`, init);
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
