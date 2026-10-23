import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { createDefaultKnowledge, recordDefaultKnowledgeIntent } from '../dist/index.js';

async function setup() {
  const db = await fixture();
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const stream = await workspaceTableMigrations();
  assert.equal(stream.length, commonCompatibility.maximum);
  const ws = await db.create(stream);
  const table = name => qualified(ws.names.schema, name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
  const runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(ws) }),
  });
  const member = async (role = 'member') => {
    const who = { userId: randomUUID(), membershipId: randomUUID() };
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,$3)`, [
      who.membershipId,
      who.userId,
      role,
    ]);
    return who;
  };
  const record = input =>
    runtime.transaction(ws.id, commonCompatibility, tx => recordDefaultKnowledgeIntent(tx, input));
  return {
    db,
    ws,
    table,
    runtime,
    member,
    record,
    close: async () => {
      await runtime.close?.();
      await db.close();
    },
  };
}

// GitHub repositories and Slack channels the fake providers can discover; tests mutate them between passes.
function fakes() {
  const repos = Array.from({ length: 45 }, (_, i) => ({
    repositoryId: String(9000 + i),
    fullName: `acme/repo-${String(i).padStart(2, '0')}`,
    visibility: 'private',
    title: `acme/repo-${i}`,
  }));
  const state = { repos, failPage: null, configured: [], configureError: null };
  const github = {
    discover: async (_ws, _user, accountId, cursor) => {
      const page = Number(cursor ?? '1');
      if (state.failPage === page)
        throw Object.assign(new Error('rate'), { code: 'rate-limited', retryAfterMs: 60000 });
      const items = state.repos.slice((page - 1) * 10, page * 10);
      return { binding: { accountId }, items, nextCursor: page * 10 < state.repos.length ? String(page + 1) : null };
    },
    configure: async (_ws, userId, value) => {
      if (state.configureError) throw state.configureError;
      state.configured.push({ userId, ...value });
      return { sourceId: value.commandId };
    },
  };
  return { state, github };
}

test(
  'default integration knowledge stores durable, idempotent intent without backfill and keeps manual choices',
  { timeout: 300000 },
  async t => {
    const env = await setup();
    const { ws, table, runtime, member, record, db } = env;
    try {
      const { state, github } = fakes();
      const flags = new Map();
      const enabled = async (_ws, userId) => flags.get(userId) ?? true;
      let clock = new Date(Date.now() + 1000);
      const defaults = createDefaultKnowledge({ runtime, engines: { github }, enabled, now: () => clock });
      const accountId = randomUUID();
      const owner = { userId: ws.userId, membershipId: ws.membershipId };
      const drain = async () => {
        for (let i = 0; i < 20; i++) {
          const work = await defaults.due(ws.id);
          if (!work.length) return;
          for (const w of work) await defaults.process(w);
        }
        assert.fail('bounded drain did not finish');
      };

      await t.test('no intent means no automatic work: existing integrations are not backfilled', async () => {
        assert.deepEqual(await defaults.due(ws.id), []);
        assert.deepEqual((await defaults.list(ws.id, owner.userId)).items, []);
      });

      await t.test(
        'recording is idempotent per product, member and account; reauthorization adds nothing',
        async () => {
          const input = {
            product: 'github',
            membershipId: owner.membershipId,
            accountKey: accountId,
            accountLabel: 'octo',
          };
          const first = await record(input);
          const replay = await record({ ...input, accountLabel: 'octo-renamed' });
          assert.equal(first.created, true);
          assert.equal(replay.created, false);
          assert.equal(first.intentId, replay.intentId);
          await Promise.all(Array.from({ length: 5 }, () => record(input)));
          assert.equal(
            (await db.platform.query(`SELECT count(*)::int n FROM ${table('default_intents')}`)).rows[0].n,
            1,
          );
          await assert.rejects(record({ ...input, product: 'teams' }));
        },
      );

      await t.test('GitHub is never gated: a disabled flag still leaves the queued intent due', async () => {
        flags.set(owner.userId, false);
        const [intent] = (await defaults.list(ws.id, owner.userId)).items;
        assert.equal(intent.syncState, 'queued');
        assert.deepEqual(
          (await defaults.due(ws.id)).map(w => w.intentId),
          [intent.intentId],
        );
        flags.delete(owner.userId);
      });

      await t.test(
        'connecting creates one owner-only source following every repository, with all content and full history',
        async () => {
          // A manual source for one repository is kept; the automatic source follows the whole account beside it.
          const manualSource = randomUUID();
          await db.platform.query(
            `INSERT INTO ${table('sources')} (id,provider,account_namespace,selection,owner_membership_id) VALUES ($1,'github','101','{"manual":true}',$2)`,
            [manualSource, owner.membershipId],
          );
          await db.platform.query(
            `INSERT INTO ${table('github_sources')} (source_id,binding,selection,title,fingerprint,cursor) VALUES ($1,$2,$3,'manual','f',$4)`,
            [
              manualSource,
              { accountId, accountGeneration: 1, githubUserId: '101', login: 'octo' },
              { repositories: ['acme/repo-00'], kinds: ['docs'], after: '2026-10-01' },
              { phase: 'listing', index: 0, page: null, after: null, pages: 0 },
            ],
          );
          await drain();
          assert.equal(state.configured.length, 1);
          const [configured] = state.configured;
          assert.equal(configured.accountId, accountId);
          assert.equal(configured.userId, owner.userId);
          assert.deepEqual(configured.memberIds, [], 'automatic sources are owner-only');
          assert.deepEqual(
            configured.selection,
            { scope: 'all', repositories: [], kinds: ['code', 'discussions', 'docs', 'issues', 'pulls'] },
            'every repository and content kind, no cutoff date and no rolling window',
          );
          const [intent] = (await defaults.list(ws.id, owner.userId)).items;
          assert.equal(intent.syncState, 'ready');
          assert.equal(intent.sources.length, 1);
          assert.equal(intent.sources[0].state, 'created');
        },
      );

      await t.test(
        'later passes never duplicate the account source, and a failed discovery is visible and retried',
        async () => {
          const before = state.configured.length;
          clock = new Date(clock.getTime() + 2 * 3600_000);
          state.repos.push({
            repositoryId: '9999',
            fullName: 'acme/new-repo',
            visibility: 'private',
            title: 'acme/new-repo',
          });
          state.failPage = 1;
          await drain();
          let [intent] = (await defaults.list(ws.id, owner.userId)).items;
          assert.equal(intent.syncState, 'failed');
          assert.equal(intent.failure, 'rate-limited');
          assert.equal(state.configured.length, before);
          state.failPage = null;
          clock = new Date(clock.getTime() + 3600_000);
          await drain();
          [intent] = (await defaults.list(ws.id, owner.userId)).items;
          assert.equal(intent.syncState, 'ready');
          assert.equal(state.configured.length, before, 'the source itself picks up new repositories');
          assert.equal(intent.sources.length, 1);
        },
      );

      await t.test('replayed configure after a crash uses the same deterministic command', async () => {
        const ids = state.configured.map(c => c.commandId);
        assert.equal(new Set(ids).size, ids.length);
        const rows = (
          await db.platform.query(`SELECT source_id FROM ${table('default_sources')} ORDER BY ordinal`)
        ).rows.map(r => r.source_id);
        assert.deepEqual(rows, ids);
      });

      await t.test('opt-out stops discovery durably; another member cannot manage it; resume restarts', async () => {
        const other = await member();
        const [intent] = (await defaults.list(ws.id, owner.userId)).items;
        await assert.rejects(defaults.manage(ws.id, other.userId, intent.intentId, { action: 'opt-out' }));
        assert.deepEqual((await defaults.list(ws.id, other.userId)).items, []);
        const opted = await defaults.manage(ws.id, owner.userId, intent.intentId, { action: 'opt-out' });
        assert.equal(opted.state, 'opted-out');
        clock = new Date(clock.getTime() + 2 * 3600_000);
        assert.deepEqual(await defaults.due(ws.id), []);
        await record({
          product: 'github',
          membershipId: owner.membershipId,
          accountKey: accountId,
          accountLabel: 'octo',
        });
        assert.equal(
          (await defaults.list(ws.id, owner.userId)).items[0].state,
          'opted-out',
          'reauthorization keeps the opt-out',
        );
        await assert.rejects(
          defaults.manage(ws.id, owner.userId, intent.intentId, { action: 'retry' }),
          error => error.code === 'conflict',
        );
        assert.equal(
          (await defaults.manage(ws.id, owner.userId, intent.intentId, { action: 'resume' })).state,
          'active',
        );
        assert.equal((await defaults.due(ws.id)).length, 1);
      });

      await t.test('the automatic gate never holds GitHub sources, even for a disabled owner', async () => {
        assert.equal((await db.platform.query(`SELECT count(*)::int n FROM ${table('default_sources')}`)).rows[0].n, 1);
        assert.deepEqual(await defaults.held(ws.id), []);
        flags.set(owner.userId, false);
        assert.deepEqual(await defaults.held(ws.id), []);
        flags.delete(owner.userId);
      });

      await t.test('runtime role cannot delete policy rows', async () => {
        await assert.rejects(
          runtime.transaction(ws.id, commonCompatibility, tx =>
            tx.client.query(`DELETE FROM ${qualified(tx.schema, 'tf_knowledge_default_intents')}`),
          ),
          error => error.code === '42501',
        );
      });
    } finally {
      await env.close();
    }
  },
);

test(
  'default discovery spans accounts, sites, >50 channels and both Google products with visible quota refusal',
  { timeout: 300000 },
  async t => {
    const env = await setup();
    const { ws, runtime, record, db, table } = env;
    try {
      const configured = [];
      let quota = false;
      const configure = provider => async (_ws, userId, value) => {
        if (quota) {
          const error = new Error('quota');
          error.code = 'quota';
          throw error;
        }
        configured.push({ provider, userId, ...value });
        return { sourceId: value.commandId };
      };
      const channels = Array.from({ length: 120 }, (_, i) => ({
        conversationId: `C${String(i).padStart(4, '0')}`,
        kind: i % 2 ? 'private' : 'public',
        title: `#c${i}`,
      })).concat([
        { conversationId: 'D0001', kind: 'im', title: 'dm' },
        { conversationId: 'G0001', kind: 'mpim', title: 'group' },
      ]);
      const sites = [
        { cloudId: randomUUID(), name: 'Acme', url: 'https://acme.atlassian.net' },
        { cloudId: randomUUID(), name: 'Beta', url: 'https://beta.atlassian.net' },
      ];
      const reposFor = {};
      const engines = {
        slack: {
          discover: async (_ws, _u, kind, cursor) => {
            assert.equal(kind, 'channels');
            const at = Number(cursor ?? 0);
            return {
              binding: { teamId: 'TACME', slackUserId: 'UOWNER' },
              items: channels.slice(at, at + 40),
              nextCursor: at + 40 < channels.length ? String(at + 40) : null,
            };
          },
          configure: configure('slack'),
        },
        github: {
          discover: async (_ws, _u, accountId) => ({ items: reposFor[accountId], nextCursor: null }),
          configure: configure('github'),
        },
        atlassian: {
          sites: async () => ({ items: sites }),
          discover: async (_ws, _u, cloudId, kind, _within, cursor) => {
            const count = cloudId === sites[0].cloudId ? 70 : 3;
            const kindName = kind === 'projects' ? 'project' : 'space';
            const all = Array.from({ length: count }, (_, i) => ({
              kind: kindName,
              id: String(100 + i),
              key: `K${i}`,
              title: `${kindName} ${i}`,
            }));
            const at = Number(cursor ?? 0);
            return { items: all.slice(at, at + 25), nextCursor: at + 25 < all.length ? String(at + 25) : null };
          },
          configure: configure('atlassian'),
        },
        google: { configure: configure('google') },
      };
      let clock = new Date(Date.now() + 1000);
      const defaults = createDefaultKnowledge({ runtime, engines, enabled: async () => true, now: () => clock });
      const drain = async () => {
        for (let i = 0; i < 40; i++) {
          const work = await defaults.due(ws.id);
          if (!work.length) return;
          for (const w of work) await defaults.process(w);
        }
        assert.fail('drain');
      };
      const owner = { userId: ws.userId, membershipId: ws.membershipId };
      const [a1, a2] = [randomUUID(), randomUUID()];
      reposFor[a1] = [{ repositoryId: '1', fullName: 'one/a', visibility: 'private', title: 'one/a' }];
      reposFor[a2] = [
        { repositoryId: '2', fullName: 'two/b', visibility: 'private', title: 'two/b' },
        { repositoryId: '1', fullName: 'one/a', visibility: 'private', title: 'one/a' },
      ];
      for (const input of [
        { product: 'slack', accountKey: 'TACME:UOWNER', accountLabel: 'Acme Slack' },
        { product: 'github', accountKey: a1, accountLabel: 'one' },
        { product: 'github', accountKey: a2, accountLabel: 'two' },
        { product: 'jira', accountKey: 'atl', accountLabel: 'Atlassian' },
        { product: 'confluence', accountKey: 'atl', accountLabel: 'Atlassian' },
        { product: 'google-drive', accountKey: 'g', accountLabel: 'me@example.com' },
        { product: 'gmail', accountKey: 'g', accountLabel: 'me@example.com' },
      ])
        await record({ ...input, membershipId: owner.membershipId });

      await t.test('every scope is grouped within adapter limits without truncation or DMs', async () => {
        await drain();
        const slack = configured.filter(c => c.provider === 'slack');
        assert.deepEqual(
          slack.map(c => c.selection.conversationIds.length),
          [50, 50, 20],
        );
        assert.ok(
          slack.flatMap(c => c.selection.conversationIds).every(id => id.startsWith('C')),
          'DMs and group messages stay opt-in',
        );
        assert.ok(slack.every(c => c.selection.kind === 'channels' && c.selection.window === 'rolling-90d'));
        const github = configured.filter(c => c.provider === 'github');
        assert.deepEqual(
          github.map(c => [c.accountId, c.selection.scope, c.selection.repositories]).sort(),
          [
            [a1, 'all', []],
            [a2, 'all', []],
          ].sort(),
          'each account gets one source that follows every repository it can read',
        );
        const atlassian = configured.filter(c => c.provider === 'atlassian');
        const sizes = product =>
          atlassian
            .filter(c => c.selection.product === product)
            .map(c => [c.selection.cloudId, c.selection.targets.length]);
        assert.deepEqual(
          sizes('jira').sort(),
          [
            [sites[0].cloudId, 50],
            [sites[0].cloudId, 20],
            [sites[1].cloudId, 3],
          ].sort(),
        );
        assert.deepEqual(
          sizes('confluence').sort(),
          [
            [sites[0].cloudId, 50],
            [sites[0].cloudId, 20],
            [sites[1].cloudId, 3],
          ].sort(),
        );
        assert.ok(atlassian.every(c => c.selection.targets.every(target => target.descendants === false)));
        assert.ok(
          atlassian
            .filter(c => c.selection.product === 'jira')
            .every(c => c.selection.targets.every(target => target.kind === 'project')),
        );
        const google = configured.filter(c => c.provider === 'google').map(c => c.selection);
        assert.equal(google.length, 2);
        assert.deepEqual(
          google.find(s => s.kind === 'drive-all'),
          { kind: 'drive-all' },
        );
        const gmail = google.find(s => s.kind === 'gmail');
        assert.equal(gmail.excludeSpamTrash, true);
        assert.equal(gmail.window, 'rolling-90d');
        assert.equal(gmail.labelId, null);
        assert.ok(configured.every(c => c.memberIds.length === 0 && c.userId === owner.userId));
        const items = (await defaults.list(ws.id, owner.userId)).items;
        assert.equal(items.length, 7);
        assert.ok(items.every(i => i.syncState === 'ready' && i.failure === null));
      });

      await t.test('quota refusal is visible and retried without duplicates', async () => {
        const before = configured.length;
        channels.push({ conversationId: 'C9999', kind: 'public', title: '#new' });
        quota = true;
        clock = new Date(clock.getTime() + 2 * 3600_000);
        await drain();
        const slack = (await defaults.list(ws.id, owner.userId)).items.find(i => i.product === 'slack');
        assert.equal(slack.syncState, 'failed');
        assert.equal(slack.failure, 'quota');
        assert.equal(slack.sources.at(-1).state, 'planned');
        quota = false;
        clock = new Date(clock.getTime() + 2 * 3600_000);
        await drain();
        const after = configured.slice(before).filter(c => c.provider === 'slack');
        assert.deepEqual(
          after.map(c => c.selection.conversationIds),
          [['C9999']],
        );
        assert.equal(
          (await defaults.list(ws.id, owner.userId)).items.find(i => i.product === 'slack').syncState,
          'ready',
        );
        assert.equal(
          (await db.platform.query(`SELECT count(*)::int n FROM ${table('default_sources')} WHERE state='planned'`))
            .rows[0].n,
          0,
        );
      });
    } finally {
      await env.close();
    }
  },
);
