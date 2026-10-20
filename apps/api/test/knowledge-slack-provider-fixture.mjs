import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { slackCredentialCipher } from '@tulipfarm/slack';
import { createSlackCorpusProvider, slackCorpusCredentials } from '@tulipfarm/slack/corpus';

export const slackScopes = [
  'channels:history',
  'channels:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
];
const BASE = Math.floor(Date.now() / 1000) - 86400;
const ROOT = `${BASE}.000100`;

// A local Slack Web API with per-token membership. No live Slack workspace or OAuth exchange is involved.
export function slackProviderFixture() {
  const appId = 'AKNOWLEDGE';
  const cipher = slackCredentialCipher({ activeKeyId: 'fixture', keys: { fixture: 'cd'.repeat(32) } });
  const tokens = new Map();
  const calls = [];
  const after = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const state = {
    failure: null,
    conversations: new Map([
      ['CGENERAL', { name: 'general', kind: 'public', members: new Set(['UOWNER', 'UREADER']), archived: false }],
      ['GPRIVATE', { name: 'leadership', kind: 'private', members: new Set(['UOWNER']), archived: false }],
      ['DOWNER', { user: 'UFRIEND', kind: 'im', members: new Set(['UOWNER']), archived: false }],
    ]),
    threads: new Map([
      [
        'CGENERAL',
        [
          {
            ts: ROOT,
            user: 'UOWNER',
            text: 'Orchid supplier rollout starts Monday',
            reply_count: 1,
            thread_ts: ROOT,
            replies: [
              { ts: `${BASE + 60}.000200`, thread_ts: ROOT, user: 'UREADER', text: 'Confirmed orchid quantities' },
            ],
          },
        ],
      ],
      ['GPRIVATE', [{ ts: ROOT, user: 'UOWNER', text: 'Orchid budget is confidential' }]],
      ['DOWNER', [{ ts: ROOT, user: 'UFRIEND', text: 'Personal orchid reminder' }]],
    ]),
  };
  const channel = id => {
    const c = state.conversations.get(id);
    return {
      id,
      ...(c.name ? { name: c.name } : {}),
      ...(c.user ? { user: c.user } : {}),
      is_im: c.kind === 'im',
      is_mpim: c.kind === 'mpim',
      is_private: c.kind === 'private',
      is_archived: c.archived,
    };
  };
  const strip = ({ replies: _replies, ...message }) => message;
  async function fetcher(input, init) {
    const url = new URL(input);
    assert.equal(url.hostname, 'slack.com');
    const user = tokens.get(init.headers.authorization?.replace('Bearer ', ''));
    const method = url.pathname.replace('/api/', '');
    const query = Object.fromEntries(url.searchParams);
    calls.push({ user, method, query });
    if (!user) return Response.json({ ok: false, error: 'invalid_auth' });
    if (state.failure) {
      const failure = state.failure(user, method, query);
      if (failure) return failure;
    }
    const visible = id => {
      const c = state.conversations.get(id);
      return c && (c.kind === 'public' || c.members.has(user));
    };
    if (method === 'users.conversations') {
      const types = query.types.split(',');
      const kinds = { public_channel: 'public', private_channel: 'private', im: 'im', mpim: 'mpim' };
      return Response.json({
        ok: true,
        channels: [...state.conversations.keys()]
          .filter(
            id =>
              state.conversations.get(id).members.has(user) &&
              types.some(type => kinds[type] === state.conversations.get(id).kind),
          )
          .map(channel),
        response_metadata: { next_cursor: '' },
      });
    }
    if (!visible(query.channel)) return Response.json({ ok: false, error: 'channel_not_found' });
    const c = state.conversations.get(query.channel);
    if (method === 'conversations.info')
      return Response.json({
        ok: true,
        channel: {
          ...channel(query.channel),
          ...(c.kind === 'public' || c.kind === 'private' ? { is_member: c.members.has(user) } : {}),
        },
      });
    const messages = state.threads.get(query.channel) ?? [];
    if (method === 'conversations.history')
      return Response.json({ ok: true, messages: messages.map(strip), has_more: false });
    if (method === 'conversations.replies') {
      const root = messages.find(message => message.ts === query.ts);
      if (!root) return Response.json({ ok: false, error: 'thread_not_found' });
      return Response.json({ ok: true, messages: [strip(root), ...(root.replies ?? [])], has_more: false });
    }
    return Response.json({ ok: false, error: 'unknown_method' });
  }
  const installationId = randomUUID();
  // A later `generation` links again after a reinstall, as member consent does for the new installation generation.
  async function link(f, who, membershipId, slackUserId, { scopes = slackScopes, generation = 1 } = {}) {
    if (
      !(await f.db.platform.query(`SELECT 1 FROM ${f.table('tf_slack_installations')} WHERE id=$1`, [installationId]))
        .rowCount
    ) {
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_slack_installations')} (id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after) VALUES ($1,$2,'TFIXTURE','UBOT',1,'active','{chat:write}','{}',0)`,
        [installationId, appId],
      );
    }
    // Member linking requires the installation use grant, and corpus use keeps checking it.
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_slack_installation_grants')} (installation_id,membership_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [installationId, membershipId],
    );
    const identityId = randomUUID();
    const token = `xoxp-${slackUserId.toLowerCase()}-${randomUUID()}`;
    tokens.set(token, slackUserId);
    const credential = cipher.encrypt(
      { workspaceId: f.workspace.id, installationId, generation, kind: 'user', identityId, membershipId, slackUserId },
      token,
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_slack_identities')} (id,installation_id,generation,slack_user_id,user_id,membership_id,state,credential,scopes,authorized_at) VALUES ($1,$2,$8,$3,$4,$5,'authorized',$6,$7,now())`,
      [identityId, installationId, slackUserId, who.id, membershipId, credential, scopes, generation],
    );
    return { identityId, token };
  }
  return {
    appId,
    cipher,
    calls,
    state,
    after,
    root: ROOT,
    installationId,
    fetcher,
    link,
    provider: runtime =>
      createSlackCorpusProvider({ credentials: slackCorpusCredentials({ runtime, appId, cipher }), fetcher }),
  };
}
