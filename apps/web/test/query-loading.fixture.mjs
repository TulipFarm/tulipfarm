import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { governanceSnapshot } from './governance-snapshot.mjs';
import { shellRead } from './shell-reads.mjs';
import { conversationPages } from '../../api/src/conversation-pages.ts';

export const id = '11111111-1111-4111-8111-111111111111';
const at = '2026-10-02T00:00:00.000Z';
export const workspace = {
  id,
  slug: 'query-qa',
  name: 'Query QA',
  status: 'ready',
  createdAt: at,
  soulCommit: 'a'.repeat(40),
};
export const base = `/v1/workspaces/${id}`;
export const chat = {
  id,
  title: 'Query loading measurement',
  titleRevision: 1,
  archived: false,
  activityAt: at,
  createdAt: at,
};
export const messageText = 'The measured conversation is ready.';
export const draftText = 'Keep this unsent baseline draft';
export const isAuthority = path =>
  ['/v1/auth/get-session', `/v1/workspaces/${workspace.slug}`, `${base}/governance/me`].includes(path);

export async function startFixture() {
  const state = { status: 'completed', available: 1000, latencyMs: 40, unknown: [], requests: [] };
  const member = {
    membershipId: id,
    role: 'admin',
    teams: [],
    capabilities: { manageGovernance: true, canLeave: true },
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.test');
    const path = url.pathname;
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? 'http://127.0.0.1');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const row = { method: req.method, path, search: url.search, startedAt: performance.now(), payloadBytes: 0 };
    state.requests.push(row);
    let json, status;
    const history = before => ({
      messages: [
        {
          id: before ? '22222222-2222-4222-8222-222222222222' : id,
          sequence: before ? 1 : 2,
          author: 'assistant',
          createdAt: at,
          parts: [{ kind: 'text', text: before ? 'Older measured message.' : messageText }],
          tools: [],
          turn: before ? null : { id, status: state.status, generation: 0 },
        },
      ],
      nextBefore: before ? null : 2,
      hasGitHubProposals: false,
    });
    // Chat history windows are read in one POST since cloud 26c5e10b (#1007), features/chat/conversation-api.ts:210.
    if (req.method === 'POST' && path === `${base}/conversations/${id}/messages/pages`) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      json = {
        chat,
        ...(await conversationPages(
          body.count,
          body.before,
          body.known,
          async before => history(before),
          page => page.nextBefore,
        )),
      };
      row.turnStatus = state.status;
    } else if (req.method === 'GET') {
      if (path === '/v1/auth/get-session')
        json = {
          session: { id: 'query-fixture', userId: 'ada' },
          user: { id: 'ada', name: 'Ada', email: 'ada@example.test' },
        };
      else if (path === '/v1/workspaces') json = [workspace];
      else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
      else if (path === `${base}/governance/me`) json = member;
      else if (path === `${base}/governance`)
        json = governanceSnapshot({
          actorMembershipId: id,
          members: [{ id, userId: 'ada', name: 'Ada', email: 'ada@example.test', role: 'admin' }],
          teams: [],
          resources: [],
          grants: [],
        });
      else if (path === `${base}/settings`)
        json = { workspaceId: id, name: workspace.name, slug: workspace.slug, revision: 1, canManage: true };
      else if (path === `${base}/personal-memory`)
        json = { content: 'Use concise answers and include next steps.', revision: 1 };
      else if (path === `${base}/credits`)
        json = {
          available: state.available,
          granted: 1000,
          used: 1000 - state.available,
          held: 0,
          days: [],
          breakdown: [],
          series: [],
        };
      else if (path === `${base}/model-catalog`) json = chatCatalog;
      else if (path === `${base}/agents/authoring-context`)
        json = { currentSoulRevision: 'a'.repeat(40), teams: [{ id, name: 'Operations' }], admin: false };
      else if (path === `${base}/agents/${id}`)
        json = {
          id,
          name: 'Measurement agent',
          owningTeamId: id,
          savedRevision: 'a'.repeat(40),
          definitionRevision: 'b'.repeat(64),
          definition: {
            name: 'Measurement agent',
            instructions: 'Measure catalog loading.',
            tools: [],
            modelFamilyId: 'claude-sonnet',
          },
          capabilities: ['read', 'edit'],
          admin: false,
          activations: [],
        };
      // The agent page reads any unreviewed setup draft; none exists (cloud 3e124b0f features/agents/api.ts:59).
      else if (path === `${base}/agents/${id}/setup-draft`) {
        status = 404;
        json = { error: 'setup-draft-not-found' };
      } else if (path === `${base}/skills` && url.searchParams.get('view') === 'reviewed')
        json = { workspace: [], nextCursor: null };
      else if (path === `${base}/model-policy/availability`)
        json = { items: chatCatalog.families.map(family => ({ familyId: family.id, enabled: true, revision: 0 })) };
      else if (
        path.startsWith(`${base}/model-policy/rules/`) &&
        chatCatalog.families.some(family => path.endsWith(`/${family.id}`))
      )
        json = {
          sourceFamilyId: path.split('/').at(-1),
          targetFamilyId: null,
          revision: 0,
          editorMembershipId: null,
          updatedAt: null,
        };
      else if (path === `${base}/conversations`) json = { chats: [chat], nextCursor: null };
      else if (path === `${base}/conversations/${id}`) json = chat;
      else if (path === `${base}/conversations/${id}/messages`) {
        json = history(url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null);
        row.turnStatus = state.status;
      }
      // The live event stream is unavailable here, so the chat falls back to the measured polling (cloud features/chat/conversation-api.ts:131).
      else if (path === `${base}/conversations/${id}/events`) {
        status = 503;
        json = { error: 'events-unavailable' };
      }
      // Chat plans and the project picker read their lists on every chat (cloud features/chat/plans.tsx:53).
      else if (path === `${base}/conversations/${id}/plans`) json = { plans: [] };
      else if (path === `${base}/projects`) json = [];
      // Model settings read the compaction tab's policy with access (cloud ecd7b787 features/models/compaction-api.ts:21).
      else if (path === `${base}/compaction-policy`)
        json = {
          automatic: true,
          triggerPercent: 70,
          targetPercent: 30,
          modelFamilyId: 'claude-sonnet',
          fallbackFamilyId: null,
          outputPrompt: null,
          revision: 0,
          editorMembershipId: null,
          updatedAt: null,
          budgetFamilies: [],
        };
      else if (path === `${base}/github/accounts`) json = { configured: true, accounts: [] };
      else if (path === `${base}/github/chats/${id}/selection`)
        json = { accountId: null, generation: null, version: 0 };
      else if (path === `${base}/github/chats/${id}/batches`) json = { batches: [] };
      else if (path === `${base}/google-workspace/operations/proposals`) json = { proposals: [], nextCursor: null };
      else if (path === `${base}/google-workspace/availability`) json = { configured: true };
      else if (path === `${base}/google-workspace`) json = { status: 'disconnected' };
    }
    const shell = json === undefined && status === undefined ? shellRead(req.method, path, workspace) : undefined;
    if (shell) ({ json, status = 200 } = shell);
    status ??= json === undefined ? 501 : 200;
    if (status === 501) state.unknown.push(`${req.method} ${req.url}`);
    const body = status === 204 ? '' : JSON.stringify(json ?? { error: 'unhandled-measurement-route' });
    await delay(state.latencyMs);
    if (res.destroyed) {
      row.aborted = true;
      return;
    }
    row.payloadBytes = Buffer.byteLength(body);
    row.completedAt = performance.now();
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': row.payloadBytes,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
