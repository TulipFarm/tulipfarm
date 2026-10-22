import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';

export const actionsTarget = { owner: 'octocat', repo: 'private', repositoryId: 42 };
export const actionsHead = 'a'.repeat(40);
export const actionsOperations = [
  {
    kind: 'actions.dispatch',
    ...actionsTarget,
    workflowId: 10,
    ref: 'main',
    inputs: { name: 'reviewed', dry: true, count: 2 },
  },
  {
    kind: 'actions.rerun',
    ...actionsTarget,
    workflowId: 10,
    runId: 20,
    runAttempt: 1,
    headSha: actionsHead,
    expectedStatus: 'completed',
    mode: 'all',
  },
  {
    kind: 'actions.rerun',
    ...actionsTarget,
    workflowId: 10,
    runId: 20,
    runAttempt: 1,
    headSha: actionsHead,
    expectedStatus: 'completed',
    mode: 'failed',
  },
  {
    kind: 'actions.cancel',
    ...actionsTarget,
    workflowId: 10,
    runId: 21,
    runAttempt: 2,
    headSha: actionsHead,
    expectedStatus: 'in_progress',
  },
  { kind: 'actions.artifact-delete', ...actionsTarget, artifactId: 30 },
];
export async function actionsProviderFixture(nativeFetch = fetch) {
  const workflow = { id: 10, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' };
  const run = (id, status, attempt) => ({
    id,
    workflow_id: 10,
    run_attempt: attempt,
    head_sha: actionsHead,
    head_branch: 'main',
    status,
    conclusion: status === 'completed' ? 'failure' : null,
    repository: { id: 42 },
    actor: { id: 123 },
    triggering_actor: { id: 123 },
    event: 'workflow_dispatch',
    created_at: new Date().toISOString(),
  });
  const runs = new Map([
    [20, run(20, 'completed', 1)],
    [21, run(21, 'in_progress', 2)],
  ]);
  const artifacts = new Map([
    [
      30,
      {
        id: 30,
        name: 'build',
        size_in_bytes: 4,
        expired: false,
        expires_at: '2099-01-01T00:00:00Z',
        workflow_run: { id: 20, repository_id: 42, head_repository_id: 42, head_sha: actionsHead, head_branch: 'main' },
      },
    ],
  ]);
  const effects = [],
    requests = [];
  const state = {
    lose: false,
    status: null,
    value: undefined,
    empty: true,
    deny: false,
    outsideDeny: false,
    push: true,
    archived: false,
    repositoryId: 42,
    afterEffect: null,
    readStatus: null,
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture'),
      path = url.pathname;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString(),
      body = raw ? JSON.parse(raw) : undefined;
    const entry = {
      method: request.method,
      path,
      query: url.search,
      version: request.headers['x-github-api-version'],
      ...(body ? { body } : {}),
    };
    requests.push(entry);
    const reply = (value, status = 200, empty = false) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(status === 204 || empty ? undefined : JSON.stringify(value));
    };
    if (request.method === 'GET') {
      if (path === '/repos/outside/source')
        return reply({ id: 777, full_name: 'outside/source' }, state.outsideDeny ? 403 : 200);
      if (state.deny) return reply({}, 403);
      if (path === '/repos/octocat/private')
        return reply({
          id: state.repositoryId,
          full_name: 'octocat/private',
          archived: state.archived,
          permissions: { push: state.push },
        });
      if (state.readStatus) return reply({}, state.readStatus);
      if (path === '/repos/octocat/private/issues/7') return reply({ id: 70, number: 7 });
      if (path.endsWith('/commits/main')) return reply({ sha: actionsHead });
      if (path.endsWith('/actions/workflows')) return reply({ total_count: 1, workflows: [workflow] });
      if (path.endsWith('/actions/workflows/10')) return reply(workflow);
      if (path.endsWith('/runs')) return reply({ total_count: runs.size, workflow_runs: [...runs.values()] });
      if (path.endsWith('/artifacts'))
        return reply({ total_count: artifacts.size, artifacts: [...artifacts.values()] });
      if (path.endsWith('/artifacts/30/zip')) {
        response.writeHead(200, { 'content-type': 'application/zip' });
        response.end(Buffer.from('zip!'));
        return;
      }
      const id = Number(path.split('/').at(-1)),
        value = path.includes('/artifacts/') ? artifacts.get(id) : runs.get(id);
      return reply(value ?? {}, value ? 200 : 404);
    }
    if ([401, 403, 404, 405, 409, 410, 422, 429].includes(state.status)) return reply({}, state.status);
    let value = null,
      status = 200;
    if (path.endsWith('/dispatches')) {
      runs.set(22, run(22, 'queued', 1));
      value = {
        workflow_run_id: 22,
        run_url: 'https://api.github.com/repos/octocat/private/actions/runs/22',
        html_url: 'https://github.com/octocat/private/actions/runs/22',
      };
    } else if (path.endsWith('/rerun') || path.endsWith('/rerun-failed-jobs')) {
      const current = runs.get(Number(path.split('/').at(-2)));
      current.run_attempt++;
      current.status = 'queued';
      status = 201;
    } else if (path.endsWith('/cancel')) {
      const current = runs.get(Number(path.split('/').at(-2)));
      current.status = 'completed';
      current.conclusion = 'cancelled';
      status = 202;
    } else if (request.method === 'DELETE' && path.endsWith('/artifacts/30')) {
      artifacts.delete(30);
      status = 204;
    } else if (path.endsWith('/issues/7/comments')) {
      value = { id: 71 };
      status = 201;
    } else return reply({}, 404);
    effects.push(entry);
    await state.afterEffect?.(entry);
    if (state.lose) {
      response.destroy();
      return;
    }
    reply(
      state.value === undefined ? value : state.value,
      state.status ?? status,
      state.empty && value === null && state.value === undefined,
    );
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    workflow,
    runs,
    artifacts,
    effects,
    requests,
    state,
    fetcher: (url, init) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://api.github.com');
      assert.equal(init.redirect, parsed.pathname.endsWith('/artifacts/30/zip') ? 'manual' : 'error');
      return nativeFetch(`http://127.0.0.1:${server.address().port}${parsed.pathname}${parsed.search}`, init);
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
