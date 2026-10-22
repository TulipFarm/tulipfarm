import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { githubChatFixture } from './github-read-fixture.mjs';
import { createGitHubAccounts } from '@tulipfarm/github';
import { createGitHubBatches } from '@tulipfarm/github/batches';
import { createGitHubBatchDecision } from '@tulipfarm/github/batch-approval';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';
import { mcpWriteFixture } from '../../../packages/github/test/mcp-write-fixture.mjs';

export const repositoryTarget = { owner: 'octocat', repo: 'private', repositoryId: 42 };
export const branchSha = 'a'.repeat(40);
export async function repositoryFixture(mcpItem) {
  const nativeFetch = globalThis.fetch;
  const f = await githubChatFixture();
  const accountId = await f.connect(123),
    chatId = await f.chat();
  await f.db.platform.query(
    `UPDATE ${f.table('tf_github_accounts')} SET scopes=ARRAY['repo','read:user','delete_repo'] WHERE id=$1`,
    [accountId],
  );
  await f.reads.select(f.one.id, f.member.userId, chatId, { accountId, expectedVersion: 0 });
  const accounts = createGitHubAccounts({ runtime: f.runtime, configuration: f.configuration, keyring: f.keyring });
  const mcpEffects = [];
  const mcp = mcpItem
    ? await mcpWriteFixture({
        item: mcpItem,
        fetcher: nativeFetch,
        effect: params => mcpEffects.push(params.arguments),
      })
    : null;
  const previousBindings = process.env.GITHUB_MCP_WRITE_BINDINGS;
  if (mcp) {
    process.env.GITHUB_MCP_WRITE_BINDINGS = JSON.stringify(mcp.bindings);
    const providerFetch = globalThis.fetch;
    globalThis.fetch = (url, init) =>
      String(url) === 'https://api.githubcopilot.com/mcp/' ? mcp.fetcher(url, init) : providerFetch(url, init);
  }
  const options = {
    runtime: f.runtime,
    accounts,
    requireSources: requireDraftSources,
    ...(mcp ? { bindings: mcp.bindings } : {}),
  };
  const batches = createGitHubBatches(options);
  const decide = createGitHubBatchDecision({
    ...options,
    resolveConfirmationCredential: async () => f.db.login(f.one, 'confirmation'),
  });
  let repository = {
    id: 42,
    full_name: 'octocat/private',
    name: 'private',
    description: 'Private source',
    private: true,
    archived: false,
    default_branch: 'main',
    permissions: { admin: true, push: true },
  };
  let deleted = false,
    lose = false,
    deny = false,
    outsideDeny = false;
  const branches = new Map([['old', branchSha]]),
    effects = [],
    creations = [];
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://fixture').pathname);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    const reply = (value, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(status === 204 ? undefined : JSON.stringify(value));
    };
    if (request.method === 'GET') {
      if (path === '/user') return reply({ id: 123, login: 'person-123', type: 'User' });
      if (path === '/orgs/acme') return reply({ id: 456, login: 'acme', type: 'Organization' });
      if (path === '/repos/outside/source')
        return reply(
          outsideDeny ? {} : { id: 999, full_name: 'outside/source', description: 'Sensitive outside source' },
          outsideDeny ? 403 : 200,
        );
      if (deny) return reply({}, 403);
      if (path.startsWith('/repos/person-123/') || path.startsWith('/repos/acme/'))
        return reply(
          creations.find(item => `/repos/${item.full_name}` === path) ?? {},
          creations.some(item => `/repos/${item.full_name}` === path) ? 200 : 404,
        );
      if (deleted) return reply({}, 404);
      const base = `/repos/${repository.full_name}`;
      if (path === '/repositories/42' || path === base) return reply(repository);
      if (!path.startsWith(base + '/')) return reply({}, 404);
      if (path.includes('/git/commits/')) return reply({ sha: path.split('/').at(-1) });
      if (path.includes('/git/ref/heads/')) {
        const branch = path.split('/git/ref/heads/')[1];
        return reply(
          branches.has(branch)
            ? { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: branches.get(branch) } }
            : {},
          branches.has(branch) ? 200 : 404,
        );
      }
      if (path.includes('/branches/')) {
        const branch = path.split('/branches/')[1];
        return reply(
          branches.has(branch) ? { name: branch, commit: { sha: branches.get(branch) } } : {},
          branches.has(branch) ? 200 : 404,
        );
      }
      return reply({}, 404);
    }
    effects.push({ method: request.method, path, ...(body ? { body } : {}) });
    let result, status;
    if (path === '/user/repos' || path === '/orgs/acme/repos') {
      result = {
        id: 43 + creations.length,
        full_name: `${path === '/user/repos' ? 'person-123' : 'acme'}/${body.name}`,
        ...body,
      };
      creations.push(result);
      status = 201;
    } else if (path.endsWith('/git/refs')) {
      const branch = body.ref.slice('refs/heads/'.length);
      if (branches.has(branch)) return reply({}, 422);
      branches.set(branch, body.sha);
      result = { ref: body.ref, object: { type: 'commit', sha: body.sha } };
      status = 201;
    } else if (path.includes('/git/refs/heads/')) {
      branches.delete(path.split('/git/refs/heads/')[1]);
      status = 204;
    } else if (request.method === 'DELETE') {
      deleted = true;
      status = 204;
    } else {
      repository = { ...repository, ...body, full_name: body.name ? `octocat/${body.name}` : repository.full_name };
      result = repository;
      status = 200;
    }
    if (lose) {
      response.destroy();
      return;
    }
    reply(result, status);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  f.setProvider((url, init) =>
    nativeFetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}${new URL(url).search}`, init),
  );
  async function propose(actions, sources = [{ kind: 'repository.read', owner: 'octocat', repo: 'private' }]) {
    f.decide(
      [
        ...sources.map(operation => ({ tool: 'github.personal.read', operation })),
        { tool: 'github.personal.propose', actions },
      ],
      'Review the exact repository changes.',
    );
    assert.equal((await f.send(chatId, `Prepare changes ${effects.length} ${Date.now()}.`)).status, 'completed');
    const view = (await batches.list(f.one.id, f.member.userId, chatId)).batches[0];
    assert.ok(view);
    return view;
  }
  const args = batch => [f.one.id, f.member.userId, chatId, batch.snapshot.id];
  return {
    ...f,
    options,
    accountId,
    chatId,
    batches,
    effects,
    branches,
    creations,
    propose,
    mcpEffects,
    read: batch => batches.read(...args(batch)),
    status: batch => batches.status(...args(batch)),
    approve: batch => decide(...args(batch), { digest: batch.digest, decision: 'approve' }),
    execute: batch => batches.execute(...args(batch)),
    reconcileStatus: batch => batches.reconcileStatus(...args(batch)),
    lose() {
      lose = true;
    },
    deny() {
      deny = true;
    },
    denyOutside() {
      outsideDeny = true;
    },
    allowOutside() {
      outsideDeny = false;
    },
    externalDelete() {
      deleted = true;
    },
    async worker(batch) {
      f.decide([{ tool: 'github.personal.execute', batchId: batch.snapshot.id }], 'Checked the approved batch.');
      return f.send(chatId, 'Execute the approved changes.');
    },
    async close() {
      await new Promise(resolve => server.close(resolve));
      await mcp?.close();
      if (previousBindings === undefined) delete process.env.GITHUB_MCP_WRITE_BINDINGS;
      else process.env.GITHUB_MCP_WRITE_BINDINGS = previousBindings;
      await f.close();
    },
  };
}
