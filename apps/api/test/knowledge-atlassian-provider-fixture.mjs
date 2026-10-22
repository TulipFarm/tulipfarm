import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAtlassianAccounts } from '@tulipfarm/atlassian/accounts';
import { createAtlassianCorpusProvider } from '@tulipfarm/atlassian/corpus';
import { accountCredentialCipher } from '../../../packages/atlassian/dist/account-credentials.js';
import { configurationHash } from '../../../packages/atlassian/dist/account-provider.js';

export const atlassianCloudId = '5b0e8f0c-2d1a-4c3b-9e7f-6a5d4c3b2a19';
export const atlassianSecondCloudId = '7c1f9a1d-3e2b-4d4c-8f80-7b6e5d4c3b2a';
const adf = text =>
  JSON.stringify({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const doc = text => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

// A local Confluence v2 and Jira v3 REST API with per-token visibility. No live Atlassian site or OAuth exchange is involved.
// `secondSite` adds a site with the same content, so one site can refuse access while the other works.
export function atlassianProviderFixture({ secondSite = false } = {}) {
  const keyring = { activeKeyId: 'fixture', keys: { fixture: 'ab'.repeat(32) } };
  const cipher = accountCredentialCipher(keyring);
  const configurations = {
    'atlassian-rest': {
      clientId: 'fixture-client',
      clientSecret: 'fixture-secret',
      redirectUri: 'http://localhost:3000/v1/atlassian/oauth/callback',
      scopes: ['read:me', 'read:page:confluence', 'read:jira-work', 'offline_access'],
    },
  };
  const site = {
    id: atlassianCloudId,
    name: 'acme',
    url: 'https://acme.atlassian.net',
    scopes: ['read:page:confluence', 'read:jira-work'],
  };
  const sites = secondSite
    ? [site, { id: atlassianSecondCloudId, name: 'beta', url: 'https://beta.atlassian.net', scopes: site.scopes }]
    : [site];
  const tokens = new Map();
  const calls = [];
  const everyone = () => new Set(['owner-aaid', 'reader-aaid']);
  const state = {
    failure: null,
    spaces: new Map([['9001', { key: 'SUP', name: 'Suppliers' }]]),
    pages: new Map([
      [
        '101',
        {
          title: 'Supplier handbook',
          space: '9001',
          ancestors: [],
          text: 'Orchid supplier rollout starts Monday',
          version: 1,
          viewers: everyone(),
        },
      ],
      [
        '102',
        {
          title: 'Supplier pricing',
          space: '9001',
          ancestors: ['101'],
          text: 'Orchid pricing is restricted',
          version: 1,
          viewers: new Set(['owner-aaid']),
        },
      ],
    ]),
    projects: new Map([['7001', { key: 'OPS', name: 'Operations' }]]),
    issues: new Map([
      [
        '10001',
        {
          key: 'OPS-1',
          project: '7001',
          summary: 'Orchid shipment',
          text: 'orchid shipment delayed',
          updated: '2026-10-01T10:00:00.000+0000',
          viewers: everyone(),
          comments: [
            {
              id: '1',
              author: { accountId: 'owner-aaid', displayName: 'Olive' },
              body: doc('orchid courier confirmed'),
              created: '2026-10-01T09:00:00.000+0000',
            },
            {
              id: '2',
              author: { accountId: 'owner-aaid', displayName: 'Olive' },
              body: doc('salary escalation'),
              created: '2026-10-01T09:30:00.000+0000',
              visibility: { type: 'role', value: 'Administrators' },
            },
          ],
        },
      ],
      [
        '10002',
        {
          key: 'OPS-2',
          project: '7001',
          summary: 'Orchid security review',
          text: 'orchid security restricted',
          updated: '2026-10-01T10:00:00.000+0000',
          viewers: new Set(['owner-aaid']),
          comments: [],
        },
      ],
    ]),
  };
  const page = id => {
    const p = state.pages.get(id);
    return {
      id,
      title: p.title,
      status: 'current',
      spaceId: p.space,
      authorId: 'owner-aaid',
      createdAt: '2026-09-01T00:00:00.000Z',
      version: { number: p.version, authorId: 'owner-aaid', createdAt: '2026-10-01T00:00:00.000Z' },
      _links: { webui: `/spaces/SUP/pages/${id}` },
      body: { atlas_doc_format: { value: adf(p.text) } },
    };
  };
  const issue = id => {
    const i = state.issues.get(id);
    return {
      id,
      key: i.key,
      fields: {
        summary: i.summary,
        updated: i.updated,
        created: '2026-09-01T00:00:00.000+0000',
        project: { id: i.project, name: state.projects.get(i.project)?.name ?? 'Moved' },
        issuetype: { name: 'Task' },
        status: { name: 'Open' },
        reporter: { accountId: 'owner-aaid', displayName: 'Olive' },
        description: doc(i.text),
      },
    };
  };
  async function fetcher(input, init) {
    const url = new URL(input);
    assert.equal(url.hostname, 'api.atlassian.com');
    const user = tokens.get(init.headers.authorization?.replace('Bearer ', ''));
    const prefix = url.pathname.match(/^\/ex\/(?:confluence|jira)\/([^/]+)/);
    const cloudId = prefix?.[1] ?? null;
    if (cloudId && !sites.some(s => s.id === cloudId)) return new Response('{}', { status: 404 });
    const path = prefix ? url.pathname.slice(prefix[0].length) : url.pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ user, path, cloudId, query: Object.fromEntries(url.searchParams), body });
    if (!user) return new Response('{}', { status: 401 });
    if (state.failure) {
      const failure = state.failure(user, path, cloudId);
      if (failure) return failure;
    }
    const canPage = id => state.pages.get(id)?.viewers.has(user);
    const canIssue = id => state.issues.get(id)?.viewers.has(user);
    let match;
    if (path === '/wiki/api/v2/spaces')
      return Response.json({
        results: [...state.spaces].map(([id, s]) => ({ id, key: s.key, name: s.name })),
        _links: {},
      });
    if ((match = path.match(/^\/wiki\/api\/v2\/spaces\/(\d+)$/)) && state.spaces.has(match[1]))
      return Response.json({ id: match[1], ...state.spaces.get(match[1]) });
    if ((match = path.match(/^\/wiki\/api\/v2\/spaces\/(\d+)\/pages$/)))
      return Response.json({
        results: [...state.pages.keys()].filter(id => state.pages.get(id).space === match[1] && canPage(id)).map(page),
        _links: {},
      });
    if (path === '/wiki/api/v2/pages')
      return Response.json({ results: url.searchParams.get('id').split(',').filter(canPage).map(page) });
    if ((match = path.match(/^\/wiki\/api\/v2\/pages\/(\d+)\/ancestors$/)) && canPage(match[1]))
      return Response.json({ results: state.pages.get(match[1]).ancestors.map(id => ({ id })) });
    if ((match = path.match(/^\/wiki\/api\/v2\/pages\/(\d+)\/descendants$/)) && canPage(match[1]))
      return Response.json({
        results: [...state.pages.keys()]
          .filter(id => state.pages.get(id).ancestors.includes(match[1]))
          .map(id => ({ id, type: 'page', status: 'current' })),
        _links: {},
      });
    if ((match = path.match(/^\/wiki\/api\/v2\/pages\/(\d+)$/)) && canPage(match[1]))
      return Response.json(page(match[1]));
    if (path === '/rest/api/3/project/search')
      return Response.json({
        values: [...state.projects].map(([id, p]) => ({ id, key: p.key, name: p.name })),
        isLast: true,
      });
    if ((match = path.match(/^\/rest\/api\/3\/project\/(\d+)$/)) && state.projects.has(match[1]))
      return Response.json({ id: match[1], ...state.projects.get(match[1]) });
    if (path === '/rest/api/3/search/jql') {
      const project = body.jql.match(/project = (\d+)/)[1];
      return Response.json({
        issues: [...state.issues.keys()]
          .filter(id => state.issues.get(id).project === project && canIssue(id))
          .map(id => ({
            id,
            key: state.issues.get(id).key,
            fields: { summary: state.issues.get(id).summary, updated: state.issues.get(id).updated },
          })),
        isLast: true,
      });
    }
    if (path === '/rest/api/3/issue/bulkfetch')
      return Response.json({ issues: body.issueIdsOrKeys.filter(canIssue).map(id => ({ id })), issueErrors: [] });
    if ((match = path.match(/^\/rest\/api\/3\/issue\/(\d+)\/comment$/)) && canIssue(match[1])) {
      const comments = state.issues.get(match[1]).comments;
      return Response.json({ comments, total: comments.length, startAt: 0 });
    }
    if ((match = path.match(/^\/rest\/api\/3\/issue\/(\d+)$/)) && canIssue(match[1]))
      return Response.json(issue(match[1]));
    return new Response('{}', { status: 404 });
  }
  async function link(f, membershipId, atlassianAccountId) {
    const id = randomUUID();
    const token = `atl-${atlassianAccountId}-${randomUUID()}`;
    tokens.set(token, atlassianAccountId);
    const credential = cipher.encrypt(
      { workspaceId: f.workspace.id, accountId: id, protocol: 'atlassian-rest', generation: 1, purpose: 'tokens' },
      JSON.stringify({ accessToken: token, refreshToken: null }),
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_atlassian_accounts')} (id,protocol,ownership,owner_membership_id,state,config_hash,identity,resources,scopes,credential,expires_at)
      VALUES ($1,'atlassian-rest','personal',$2,'active',$3,$4,$5,$6,$7,now()+interval '1 hour')`,
      [
        id,
        membershipId,
        configurationHash('atlassian-rest', configurations['atlassian-rest']),
        { id: atlassianAccountId, label: atlassianAccountId, qualification: 'verified' },
        JSON.stringify(sites),
        configurations['atlassian-rest'].scopes,
        credential,
      ],
    );
    return { accountId: id, token };
  }
  // Stands for a completed reconnect of the same Atlassian account: a new token under the next generation, as the account service stores it.
  async function reauthorize(f, accountId, atlassianAccountId) {
    const token = `atl-${atlassianAccountId}-${randomUUID()}`;
    tokens.set(token, atlassianAccountId);
    const [{ generation }] = (
      await f.db.platform.query(
        `SELECT generation+1 AS generation FROM ${f.table('tf_atlassian_accounts')} WHERE id=$1`,
        [accountId],
      )
    ).rows;
    const credential = cipher.encrypt(
      { workspaceId: f.workspace.id, accountId, protocol: 'atlassian-rest', generation, purpose: 'tokens' },
      JSON.stringify({ accessToken: token, refreshToken: null }),
    );
    await f.db.platform.query(
      `UPDATE ${f.table('tf_atlassian_accounts')} SET generation=$2,state='active',credential=$3,expires_at=now()+interval '1 hour',refresh_started_at=NULL WHERE id=$1`,
      [accountId, generation, credential],
    );
    return { token, generation };
  }
  const revoke = token => tokens.delete(token);
  const accounts = runtime => createAtlassianAccounts({ runtime, configurations, keyring, fetcher });
  return {
    calls,
    state,
    link,
    reauthorize,
    revoke,
    fetcher,
    keyring,
    configurations,
    accounts,
    cloudId: atlassianCloudId,
    secondCloudId: atlassianSecondCloudId,
    provider: runtime => createAtlassianCorpusProvider({ accounts: accounts(runtime), fetcher }),
  };
}
