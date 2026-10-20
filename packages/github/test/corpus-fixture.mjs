import { createHash } from 'node:crypto';

const sha = value => createHash('sha1').update(value).digest('hex');
const iso = offsetDays => new Date(Date.now() + offsetDays * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// A local GitHub REST and GraphQL fake with per-token repository access. No live GitHub account or network is involved.
export function fakeGitHub() {
  const calls = [];
  const tokens = new Map();
  const repos = new Map();
  const renamed = new Map();
  const state = { failure: null, repos, renamed, truncate: false };
  function addRepo({
    id,
    fullName,
    isPrivate = true,
    readers = [],
    description = null,
    files = {},
    issues = [],
    discussions = [],
  }) {
    const repo = {
      id,
      node_id: `R_${id}`,
      full_name: fullName,
      private: isPrivate,
      default_branch: 'main',
      description,
      readers: new Set(readers),
      files: new Map(Object.entries(files)),
      issues: new Map(
        issues.map(issue => [
          issue.number,
          {
            comments: [],
            pull: false,
            state: 'open',
            created_at: iso(-10),
            updated_at: iso(-1),
            user: 'octo',
            ...issue,
          },
        ]),
      ),
      discussions: new Map(
        discussions.map(item => [
          item.number,
          { comments: [], createdAt: iso(-10), updatedAt: iso(-1), author: 'octo', ...item },
        ]),
      ),
    };
    repos.set(id, repo);
    return repo;
  }
  const commit = repo => sha(JSON.stringify([...repo.files.entries()].sort()));
  const readable = (repo, user) => repo && (!repo.private || repo.readers.has(user.id));
  const body = repo => ({
    id: repo.id,
    node_id: repo.node_id,
    full_name: repo.full_name,
    private: repo.private,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.default_branch,
    description: repo.description,
    permissions: { pull: true },
  });
  const issueBody = (repo, issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: issue.user ? { login: issue.user } : null,
    state: issue.state,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.full_name}/${issue.pull ? 'pull' : 'issues'}/${issue.number}`,
    ...(issue.pull ? { pull_request: { url: 'x' } } : {}),
  });
  const discussionBody = (repo, item) => ({
    number: item.number,
    title: item.title,
    body: item.body,
    url: `https://github.com/${repo.full_name}/discussions/${item.number}`,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    author: { login: item.author },
    category: { name: 'General' },
    comments: {
      totalCount: item.comments.length,
      nodes: item.comments.map(comment => ({
        body: comment.body,
        createdAt: comment.createdAt ?? item.createdAt,
        updatedAt: comment.updatedAt ?? item.createdAt,
        author: { login: comment.author ?? 'octo' },
        replies: { totalCount: 0, nodes: [] },
      })),
    },
  });
  async function fetcher(input, init = {}) {
    const url = new URL(input);
    if (url.origin !== 'https://api.github.com') throw new Error(`unexpected origin ${url.origin}`);
    if (init.redirect !== 'manual') throw new Error('corpus requests must not follow redirects');
    const token = new Headers(init.headers).get('authorization')?.replace('Bearer ', '');
    const user = tokens.get(token);
    const path = url.pathname;
    const graph = init.body ? JSON.parse(init.body) : null;
    calls.push({ user: user?.login, path, query: Object.fromEntries(url.searchParams), graph: graph?.variables });
    if (!user) return Response.json({ message: 'Bad credentials' }, { status: 401 });
    if (state.failure) {
      const failure = state.failure(user, path, url);
      if (failure) return failure;
    }
    if (path === '/user/repos')
      return Response.json([...repos.values()].filter(repo => repo.readers.has(user.id)).map(body));
    let match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path);
    if (match) {
      const name = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`.toLowerCase();
      if (renamed.has(name))
        return new Response(null, {
          status: 301,
          headers: { location: `https://api.github.com/repositories/${renamed.get(name)}` },
        });
      const repo = [...repos.values()].find(item => item.full_name.toLowerCase() === name);
      return readable(repo, user)
        ? Response.json(body(repo))
        : Response.json({ message: 'Not Found' }, { status: 404 });
    }
    if (path === '/graphql') {
      const repo = [...repos.values()].find(item => item.node_id === graph.variables.id);
      if (!readable(repo, user))
        return Response.json({ data: { node: null }, errors: [{ type: 'NOT_FOUND', message: 'not found' }] });
      if (graph.query.includes('discussions(first')) {
        const nodes = [...repo.discussions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const start = graph.variables.cursor ? Number(graph.variables.cursor) : 0;
        const page = nodes.slice(start, start + 20);
        return Response.json({
          data: {
            node: {
              discussions: {
                pageInfo: { hasNextPage: start + 20 < nodes.length, endCursor: String(start + 20) },
                nodes: page.map(item => ({
                  number: item.number,
                  title: item.title,
                  updatedAt: item.updatedAt,
                  url: `https://github.com/${repo.full_name}/discussions/${item.number}`,
                  comments: { totalCount: item.comments.length },
                })),
              },
            },
          },
        });
      }
      const item = repo.discussions.get(graph.variables.number);
      return Response.json({ data: { node: { discussion: item ? discussionBody(repo, item) : null } } });
    }
    match = /^\/repositories\/(\d+)(\/.*)?$/.exec(path);
    if (!match) return Response.json({ message: 'Not Found' }, { status: 404 });
    const repo = repos.get(Number(match[1]));
    if (!readable(repo, user)) return Response.json({ message: 'Not Found' }, { status: 404 });
    const rest = match[2] ?? '';
    if (!rest) return Response.json(body(repo));
    if (rest === `/commits/${repo.default_branch}`)
      return repo.files.size
        ? new Response(commit(repo), { headers: { 'content-type': 'application/vnd.github.sha' } })
        : Response.json({ message: 'Git Repository is empty.' }, { status: 409 });
    if (rest.startsWith('/git/trees/')) {
      const entries = [...repo.files.entries()].map(([file, content]) => ({
        path: file,
        type: 'blob',
        sha: sha(`blob:${content}`),
        size: Buffer.byteLength(content),
      }));
      return Response.json({
        sha: commit(repo),
        truncated: state.truncate,
        tree: [{ path: 'docs', type: 'tree', sha: sha('tree') }, ...(state.truncate ? entries.slice(0, 1) : entries)],
      });
    }
    if (rest.startsWith('/contents/')) {
      const file = rest.slice('/contents/'.length).split('/').map(decodeURIComponent).join('/');
      const content = repo.files.get(file);
      if (content === undefined) return Response.json({ message: 'Not Found' }, { status: 404 });
      const bytes = Buffer.from(content);
      return Response.json({
        type: 'file',
        path: file,
        sha: sha(`blob:${content}`),
        size: bytes.byteLength,
        encoding: 'base64',
        content: bytes.toString('base64'),
      });
    }
    if (rest === '/issues') {
      const since = Date.parse(url.searchParams.get('since'));
      const per = Number(url.searchParams.get('per_page'));
      const page = Number(url.searchParams.get('page'));
      const all = [...repo.issues.values()]
        .filter(issue => !issue.deleted && Date.parse(issue.updated_at) >= since)
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
      return Response.json(all.slice((page - 1) * per, page * per).map(issue => issueBody(repo, issue)));
    }
    match = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
    if (match) {
      const issue = repo.issues.get(Number(match[1]));
      if (!issue) return Response.json({ message: 'Not Found' }, { status: 404 });
      if (issue.deleted) return Response.json({ message: 'This issue was deleted' }, { status: 410 });
      if (issue.transferred)
        return new Response(null, {
          status: 301,
          headers: { location: 'https://api.github.com/repositories/9/issues/1' },
        });
      if (match[2]) {
        const page = Number(url.searchParams.get('page') ?? 1);
        return Response.json(
          issue.comments.slice((page - 1) * 100, page * 100).map(comment => ({
            user: { login: comment.user ?? 'octo' },
            body: comment.body,
            created_at: comment.created_at ?? issue.created_at,
            updated_at: comment.updated_at ?? comment.created_at ?? issue.created_at,
          })),
        );
      }
      return Response.json(issueBody(repo, issue));
    }
    return Response.json({ message: 'Not Found' }, { status: 404 });
  }
  function token(id, login) {
    const value = `gho_${login}_${sha(`${id}:${Math.random()}`).slice(0, 16)}`;
    tokens.set(value, { id, login });
    return value;
  }
  const touch = (repo, number, change) => {
    const issue = repo.issues.get(number);
    Object.assign(issue, change, { updated_at: new Date().toISOString() });
  };
  return { calls, tokens, state, fetcher, addRepo, token, touch, iso };
}
