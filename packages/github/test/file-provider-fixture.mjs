import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';

export const headSha = 'a'.repeat(40),
  treeSha = 'b'.repeat(40);
export const blob = text =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest('hex');
export const fileTarget = { owner: 'octocat', repo: 'private', repositoryId: 42, branch: 'main', headSha };
export const forkOperation = {
  kind: 'pull.create-fork',
  owner: 'upstream',
  repo: 'project',
  repositoryId: 99,
  headOwner: 'octocat',
  headRepo: 'private',
  headRepositoryId: 42,
  head: 'main',
  headSha,
  base: 'main',
  title: 'Reviewed fork',
  body: 'Exact fork body',
  draft: false,
};
export async function fileProviderFixture(nativeFetch = fetch) {
  const initial = new Map([
    ['old.txt', { content: 'old text\n', mode: '100644', sha: blob('old text\n') }],
    ['keep.txt', { content: 'untouched\n', mode: '100755', sha: blob('untouched\n') }],
  ]);
  const trees = new Map([[treeSha, initial]]),
    commits = new Map([[headSha, { sha: headSha, tree: { sha: treeSha }, parents: [], message: 'Initial' }]]);
  const branches = new Map([
      ['main', headSha],
      ['other', headSha],
    ]),
    effects = [],
    requests = [],
    pulls = [];
  const state = {
    lose: '',
    reject: '',
    malformed: '',
    unauthorized: '',
    deny: false,
    outsideDeny: false,
    push: true,
    repositoryId: 42,
    race: false,
    secret: '',
    status: null,
    truncated: false,
  };
  let sequence = 1;
  const hash = () => (++sequence).toString(16).padStart(40, '0');
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture'),
      path = decodeURIComponent(url.pathname);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    const entry = { method: request.method, path, ...(body ? { body } : {}) };
    requests.push(entry);
    const reply = (value, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (state.unauthorized && path.endsWith(state.unauthorized)) return reply({}, 401);
    if (state.reject && path.endsWith(state.reject)) return reply({}, 422);
    if (request.method === 'GET') {
      if (path === '/repos/outside/source')
        return reply(
          state.outsideDeny ? {} : { id: 777, full_name: 'outside/source', description: 'Private outside content' },
          state.outsideDeny ? 403 : 200,
        );
      if (state.deny) return reply({}, 403);
      if (path === '/repos/octocat/private')
        return reply({
          id: state.repositoryId,
          full_name: 'octocat/private',
          description: 'Private files',
          archived: false,
          default_branch: 'main',
          permissions: { push: state.push, admin: true },
          parent: { id: 99 },
          source: { id: 99 },
        });
      if (path === '/repos/upstream/project')
        return reply({ id: 99, full_name: 'upstream/project', archived: false, permissions: { push: false } });
      if (path.includes('/git/ref/heads/')) {
        const name = path.split('/git/ref/heads/')[1];
        return reply(
          branches.has(name) ? { ref: `refs/heads/${name}`, object: { type: 'commit', sha: branches.get(name) } } : {},
          branches.has(name) ? 200 : 404,
        );
      }
      if (path.includes('/branches/')) {
        const name = path.split('/branches/')[1];
        return reply({ name, commit: { sha: branches.get(name) } });
      }
      if (path.includes('/git/commits/'))
        return reply(commits.get(path.split('/').at(-1)) ?? {}, commits.has(path.split('/').at(-1)) ? 200 : 404);
      if (path.includes('/git/trees/')) {
        const id = path.split('/').at(-1),
          tree = trees.get(id);
        return reply(
          tree
            ? {
                sha: id,
                truncated: state.truncated,
                tree: [...tree].map(([path, file]) => ({ path, mode: file.mode, type: 'blob', sha: file.sha })),
              }
            : {},
          tree ? 200 : 404,
        );
      }
      if (path.includes('/contents/')) {
        const name = path.split('/contents/')[1],
          ref = url.searchParams.get('ref') ?? 'main';
        const commit = commits.get(branches.get(ref) ?? ref),
          file = trees.get(commit?.tree.sha)?.get(name);
        return reply(
          file
            ? {
                type: 'file',
                name,
                path: name,
                sha: file.sha,
                size: Buffer.byteLength(file.content),
                encoding: 'base64',
                content: Buffer.from(file.content).toString('base64'),
                html_url: `https://github.com/octocat/private/blob/${ref}/${name}`,
              }
            : {},
          file ? 200 : 404,
        );
      }
      if (path.includes('/compare/')) {
        const [base, current] = path.split('/compare/')[1].split('...');
        let next = current;
        const visited = new Set();
        while (next && next !== base && !visited.has(next)) {
          visited.add(next);
          next = commits.get(next)?.parents[0]?.sha;
        }
        return reply({
          status: next === base ? 'ahead' : 'diverged',
          base_commit: { sha: base },
          merge_base_commit: { sha: next === base ? base : headSha },
        });
      }
      if (path.endsWith('/commits'))
        return reply(
          [...commits.values()].map(commit => ({
            ...commit,
            commit: { message: commit.message },
            author: { id: 123 },
          })),
        );
      if (path.includes('/commits/')) {
        const commit = commits.get(path.split('/').at(-1));
        return reply(commit ?? {}, commit ? 200 : 404);
      }
      if (path.endsWith('/pulls')) return reply(pulls);
      return reply({}, 404);
    }
    let result,
      status = 200;
    if (path.endsWith('/git/trees')) {
      assert.ok(trees.has(body.base_tree));
      const tree = new Map(trees.get(body.base_tree));
      for (const file of body.tree)
        if (file.sha === null) tree.delete(file.path);
        else tree.set(file.path, { content: file.content, mode: file.mode, sha: blob(file.content) });
      const sha = hash();
      trees.set(sha, tree);
      result = { sha };
      status = 201;
    } else if (path.endsWith('/git/commits')) {
      const sha = hash();
      result = { sha, message: body.message, tree: { sha: body.tree }, parents: body.parents.map(sha => ({ sha })) };
      commits.set(sha, result);
      status = 201;
      if (state.race) branches.set('main', 'c'.repeat(40));
    } else if (path.includes('/git/refs/heads/')) {
      assert.equal(body.force, false);
      const branch = path.split('/git/refs/heads/')[1],
        commit = commits.get(body.sha);
      if (commit?.parents[0]?.sha !== branches.get(branch)) return reply({}, 422);
      branches.set(branch, body.sha);
      result = { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: body.sha } };
    } else if (path.includes('/contents/')) {
      const name = path.split('/contents/')[1],
        parent = branches.get(body.branch),
        base = commits.get(parent),
        tree = new Map(trees.get(base.tree.sha)),
        old = tree.get(name);
      if (body.sha ? old?.sha !== body.sha : old !== undefined) return reply({}, 409);
      const content =
        request.method === 'DELETE'
          ? null
          : {
              content: Buffer.from(body.content, 'base64').toString(),
              mode: old?.mode ?? '100644',
              sha: blob(Buffer.from(body.content, 'base64').toString()),
            };
      if (content) tree.set(name, content);
      else tree.delete(name);
      const nextTree = hash(),
        sha = hash();
      trees.set(nextTree, tree);
      const commit = {
        sha,
        message: body.message,
        tree: { sha: nextTree },
        parents: [{ sha: parent }],
        files: [
          { filename: name, status: content ? (old ? 'modified' : 'added') : 'removed', sha: content?.sha ?? old.sha },
        ],
      };
      commits.set(sha, commit);
      branches.set(body.branch, sha);
      result = { content: content ? { path: name, sha: content.sha } : null, commit };
      status = old ? 200 : 201;
    } else if (path === '/repos/upstream/project/pulls') {
      result = {
        id: 88,
        number: 8,
        title: body.title,
        body: body.body,
        user: { id: 123 },
        head: {
          ref: body.head.split(':')[1],
          sha: branches.get(body.head.split(':')[1]),
          repo: { id: 42, full_name: 'octocat/private' },
        },
        base: { ref: body.base, repo: { id: 99 } },
      };
      pulls.push(result);
      status = 201;
    } else return reply({}, 404);
    effects.push(entry);
    if (state.lose && path.endsWith(state.lose)) {
      response.destroy();
      return;
    }
    if (state.malformed && path.endsWith(state.malformed)) result = { secret: state.secret || 'malformed' };
    reply(result, state.status ?? status);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    state,
    effects,
    requests,
    branches,
    commits,
    trees,
    pulls,
    current: () => trees.get(commits.get(branches.get('main'))?.tree.sha),
    fetcher: (url, init) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://api.github.com');
      assert.equal(init.redirect, 'error');
      return nativeFetch(`http://127.0.0.1:${server.address().port}${parsed.pathname}${parsed.search}`, init);
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
