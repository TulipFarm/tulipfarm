import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { AccessDenied } from '@tulipfarm/access';
import { knowledgeEmbeddingProfile as profile } from '@tulipfarm/config';
import { GoogleCorpusError } from '@tulipfarm/google-workspace/corpus';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import {
  createDefaultKnowledge,
  createDefaultKnowledgeGate,
  createGoogleKnowledge,
  createGitHubKnowledge,
  createKnowledgeEmbeddings,
  createSlackKnowledge,
  recordDefaultKnowledgeIntent,
  SlackCorpusError,
} from '../dist/index.js';

const day = 86_400_000;
const date = time => new Date(time).toISOString().slice(0, 10);

async function setup(version) {
  const db = await fixture();
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const stream = await workspaceTableMigrations();
  const ws = await db.create(version ? stream.slice(0, version) : stream);
  const table = name => qualified(ws.names.schema, name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
  const runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(ws) }),
  });
  const member = async () => {
    const who = { userId: randomUUID(), membershipId: randomUUID() };
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      who.membershipId,
      who.userId,
    ]);
    return who;
  };
  const record = input =>
    runtime.transaction(ws.id, commonCompatibility, tx => recordDefaultKnowledgeIntent(tx, input));
  const live = async sourceId =>
    (
      await db.platform.query(
        `SELECT count(*)::int AS n FROM ${table('documents')} WHERE source_id=$1 AND tombstoned_at IS NULL`,
        [sourceId],
      )
    ).rows[0].n;
  return {
    db,
    ws,
    table,
    runtime,
    member,
    record,
    live,
    owner: { userId: ws.userId, membershipId: ws.membershipId },
    close: async () => {
      await runtime.close?.();
      await db.close();
    },
  };
}

// A Slack workspace where each linked member reads one thread per channel through their own identity.
async function slackWorld({ db, table }) {
  const installationId = randomUUID();
  await db.platform.query(
    `INSERT INTO ${table('tf_slack_installations')} (id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after) VALUES ($1,'AAPP','TTEAM','UBOT',1,'active','{chat:write}','{}',0)`,
    [installationId],
  );
  const bindings = new Map();
  const calls = [];
  const conversations = [];
  const stamp = `${Math.floor((Date.now() - day) / 1000)}.000100`;
  const observation = id => ({
    nativeId: `${id}:${stamp}`,
    conversationId: id,
    ts: stamp,
    title: `#${id} thread`,
    canonicalURL: `https://app.slack.com/client/TTEAM/${id}/thread/${id}-${stamp}`,
    sourceRevision: '1',
    accessedAt: new Date().toISOString(),
    coverage: 'supported',
  });
  return {
    calls,
    conversations,
    bindings,
    // A later generation stands for a reinstall or relink, which may bring a different Slack user.
    async link(who, slackUserId, generation = 1) {
      const identityId = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_slack_identities')} (id,installation_id,generation,slack_user_id,user_id,membership_id,state,credential,scopes) VALUES ($1,$2,$7,$3,$4,$5,'authorized','{}',$6)`,
        [
          identityId,
          installationId,
          slackUserId,
          who.userId,
          who.membershipId,
          ['channels:history', 'channels:read', 'groups:history', 'groups:read'],
          generation,
        ],
      );
      bindings.set(who.userId, { installationId, installationGeneration: 1, identityId, slackUserId, teamId: 'TTEAM' });
    },
    provider: {
      discover: async (_w, userId) => ({ binding: bindings.get(userId), items: conversations, nextCursor: null }),
      inspectSelection: async (_w, userId, selection) => ({
        binding: bindings.get(userId),
        title: 'Selected Slack',
        conversations: selection.conversationIds.map(id => ({ conversationId: id, kind: 'public', title: `#${id}` })),
      }),
      access: async (_w, _u, _b, id) => ({
        conversationId: id,
        kind: 'public',
        title: `#${id}`,
        accessedAt: new Date().toISOString(),
        member: true,
        archived: false,
      }),
      list: async (_w, userId, _b, id) => {
        calls.push(['list', userId, id]);
        return { observations: [observation(id)], nextCursor: null };
      },
      read: async (_w, userId, _b, id) => {
        calls.push(['read', userId, id]);
        return {
          ...observation(id),
          markdown: `# Thread\n\n## Message by U at 2026-01-01T00:00:00.000Z\n\norchid note in ${id}\n`,
        };
      },
    },
  };
}
const channels = id => ({
  commandId: randomUUID(),
  memberIds: [],
  selection: { kind: 'channels', conversationIds: [id], after: date(Date.now() - 30 * day) },
});

async function sync(engine, env, sourceTable, sourceId) {
  for (let i = 0; i < 12; i++) {
    await env.db.platform.query(
      `UPDATE ${env.table(sourceTable)} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
      [sourceId],
    );
    const work = (await engine.due(env.ws.id)).find(w => w.sourceId === sourceId);
    if (!work) return;
    if ((await engine.process(work)).disposition === 'ready') return;
  }
  assert.fail('bounded sync did not complete');
}
async function drain(defaults, env) {
  for (let i = 0; i < 40; i++) {
    const work = await defaults.due(env.ws.id);
    if (!work.length) return;
    for (const w of work) await defaults.process(w);
  }
  assert.fail('defaults did not settle');
}
// Marks existing sources as the automatic sources of one intent, as the defaults service would have created them.
async function automatic(env, who, product, accountKey, sourceIds) {
  const intentId = randomUUID();
  await env.db.platform.query(
    `INSERT INTO ${env.table('default_intents')} (id,product,membership_id,account_key,account_label,sync_state) VALUES ($1,$2,$3,$4,'Fixture','ready')`,
    [intentId, product, who.membershipId, accountKey],
  );
  for (const [index, sourceId] of sourceIds.entries())
    await env.db.platform.query(
      `INSERT INTO ${env.table('default_sources')} (source_id,intent_id,ordinal,selection,state) VALUES ($1,$2,$3,'{}','created')`,
      [sourceId, intentId, index + 1],
    );
  return intentId;
}

test(
  'a workspace still at storage version 50 keeps manual Knowledge working and records no automatic state',
  { timeout: 300000 },
  async () => {
    const env = await setup(50);
    const { ws, runtime, record, owner } = env;
    try {
      const intent = { product: 'slack', membershipId: owner.membershipId, accountKey: 'TTEAM', accountLabel: 'Acme' };
      assert.deepEqual(
        await record(intent),
        { intentId: '', created: false },
        'credential writes on old storage record no intent',
      );
      assert.deepEqual(
        await runtime.transaction(ws.id, commonCompatibility, tx =>
          recordDefaultKnowledgeIntent({ ...tx, commonVersion: undefined }, intent),
        ),
        { intentId: '', created: false },
        'a transaction without a version detects the missing tables instead of failing',
      );
      const world = await slackWorld(env);
      await world.link(owner, 'UOWNER');
      for (const flag of [true, false]) {
        const enabled = async () => flag;
        const gate = createDefaultKnowledgeGate({ runtime, enabled });
        assert.deepEqual(await gate(ws.id), []);
        const defaults = createDefaultKnowledge({ runtime, engines: {}, enabled });
        assert.deepEqual(await defaults.due(ws.id), []);
        assert.deepEqual(await defaults.held(ws.id), []);
        assert.deepEqual((await defaults.list(ws.id, owner.userId)).items, []);
        await assert.rejects(
          defaults.manage(ws.id, owner.userId, randomUUID(), { action: 'retry' }),
          error => error instanceof AccessDenied,
        );
        const slack = createSlackKnowledge({ runtime, provider: world.provider, gate });
        const source = await slack.configure(ws.id, owner.userId, channels(flag ? 'CON' : 'COFF'));
        await sync(slack, env, 'slack_sources', source.sourceId);
        assert.equal(
          await env.live(source.sourceId),
          1,
          `manual Slack still syncs with the flag ${flag ? 'on' : 'off'}`,
        );
        const embeddings = createKnowledgeEmbeddings({
          runtime,
          slack,
          gate,
          config: { kind: 'enabled', endpoint: 'https://example.services.ai.azure.com/', apiKey: 'fixture', profile },
          capacity: async () => false,
        });
        assert.ok(Array.isArray(await embeddings.due(ws.id)), 'embedding dispatch works without automatic tables');
      }
    } finally {
      await env.close();
    }
  },
);

test(
  'held automatic work is filtered before the dispatch limit, so manual and enabled work is never starved',
  { timeout: 300000 },
  async t => {
    const env = await setup();
    const { ws, runtime, member, record, db, table, owner } = env;
    try {
      const disabled = await member();
      const enabled = async (_w, userId) => userId !== disabled.userId;
      const world = await slackWorld(env);
      await world.link(owner, 'UOWNER');
      await world.link(disabled, 'UOTHER');
      const plain = createSlackKnowledge({ runtime, provider: world.provider });
      const held = [];
      for (let i = 0; i < 21; i++)
        held.push(
          (await plain.configure(ws.id, disabled.userId, channels(`CH${String(i).padStart(2, '0')}`))).sourceId,
        );
      const disabledManual = (await plain.configure(ws.id, disabled.userId, channels('CMANUALB'))).sourceId;
      const ownerManual = (await plain.configure(ws.id, owner.userId, channels('CMANUALA'))).sourceId;
      const intentId = await automatic(env, disabled, 'slack', 'TTEAM', held);
      await db.platform.query(
        `UPDATE ${table('slack_sources')} SET next_attempt_at=clock_timestamp()-interval '1 hour' WHERE source_id=ANY($1::uuid[])`,
        [held],
      );
      await db.platform.query(
        `UPDATE ${table('slack_sources')} SET next_attempt_at=clock_timestamp()-interval '1 minute' WHERE source_id=ANY($1::uuid[])`,
        [[disabledManual, ownerManual]],
      );
      const gate = createDefaultKnowledgeGate({ runtime, enabled });
      const slack = createSlackKnowledge({ runtime, provider: world.provider, gate });

      await t.test('the provider engine skips held sources before LIMIT 20', async () => {
        const ungated = (await plain.due(ws.id)).map(w => w.sourceId);
        assert.equal(ungated.length, 20);
        assert.ok(
          ungated.every(id => held.includes(id)),
          'without the gate, held work fills the whole batch',
        );
        const due = (await slack.due(ws.id)).map(w => w.sourceId).sort();
        assert.deepEqual(
          due,
          [disabledManual, ownerManual].sort(),
          'manual sources of every owner still dispatch; held automatic sources do not',
        );
        assert.deepEqual((await gate(ws.id)).sort(), held.slice().sort());
      });

      await t.test('held work claimed earlier is refused without provider calls', async () => {
        const [work] = (await plain.due(ws.id)).filter(w => held.includes(w.sourceId));
        const calls = world.calls.length;
        assert.equal((await slack.process(work)).disposition, 'stale');
        assert.equal(world.calls.length, calls);
        await sync(slack, env, 'slack_sources', ownerManual);
        await sync(slack, env, 'slack_sources', disabledManual);
        assert.equal(await env.live(ownerManual), 1);
        assert.equal(await env.live(disabledManual), 1, 'a disabled owner keeps their manual Knowledge');
      });

      await t.test('the defaults service filters disabled owners before its own limit', async () => {
        for (let i = 0; i < 21; i++)
          await record({
            product: 'github',
            membershipId: disabled.membershipId,
            accountKey: `account-${i}`,
            accountLabel: `account ${i}`,
          });
        await db.platform.query(
          `UPDATE ${table('default_intents')} SET next_attempt_at=clock_timestamp()-interval '1 hour' WHERE membership_id=$1`,
          [disabled.membershipId],
        );
        const { intentId: ownerIntent } = await record({
          product: 'github',
          membershipId: owner.membershipId,
          accountKey: 'owner-account',
          accountLabel: 'owner',
        });
        const defaults = createDefaultKnowledge({ runtime, engines: {}, enabled });
        assert.deepEqual(
          (await defaults.due(ws.id)).map(w => w.intentId),
          [ownerIntent],
        );
        assert.equal(
          (await createDefaultKnowledge({ runtime, engines: {}, enabled: async () => true }).due(ws.id)).length,
          20,
        );
        assert.equal((await defaults.held(ws.id)).length, 21);
        assert.ok(intentId);
      });
    } finally {
      await env.close();
    }
  },
);

test(
  'a flag change holds queued paid embedding work for automatic sources before any claim or credit use',
  { timeout: 300000 },
  async () => {
    const env = await setup();
    const { ws, runtime, member, db, table } = env;
    try {
      const who = await member();
      let flag = true;
      const enabled = async () => flag;
      const world = await slackWorld(env);
      await world.link(who, 'UAUTO');
      const gate = createDefaultKnowledgeGate({ runtime, enabled });
      const slack = createSlackKnowledge({ runtime, provider: world.provider, gate });
      const sourceId = (await slack.configure(ws.id, who.userId, channels('CAUTO'))).sourceId;
      await automatic(env, who, 'slack', 'TTEAM', [sourceId]);
      await sync(slack, env, 'slack_sources', sourceId);
      assert.equal(await env.live(sourceId), 1);
      await db.platform.query(
        `UPDATE ${table('tf_credit_account')} SET available=10000000000000,granted=10000000000000`,
      );
      let dispatched = 0;
      const embeddings = createKnowledgeEmbeddings({
        runtime,
        slack,
        gate,
        config: { kind: 'enabled', endpoint: 'https://example.services.ai.azure.com/', apiKey: 'fixture', profile },
        capacity: async () => true,
        provider: async () => {
          dispatched++;
          return {
            dispatch: 'dispatched',
            requestId: `gate-${dispatched}`,
            inputTokensUpperBound: 1,
            usage: { kind: 'known', inputTokens: 1, totalTokens: 1, exceedsUpperBound: false },
            result: {
              kind: 'success',
              model: profile.model,
              vectors: [Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))],
            },
          };
        },
      });
      const queued = await embeddings.due(ws.id);
      assert.ok(queued.length > 0, 'the automatic source queued paid ingestion work');
      const attempts = async () =>
        (await db.platform.query(`SELECT count(*)::int AS n FROM ${table('credit_attempts')}`)).rows[0].n;
      const before = await attempts();
      flag = false;
      assert.deepEqual(await embeddings.due(ws.id), [], 'held ingestion is not dispatched');
      for (const work of queued) assert.equal((await embeddings.process(work)).disposition, 'stale');
      assert.equal(dispatched, 0, 'no provider call while the owner is held');
      assert.equal(await attempts(), before, 'no credit attempt is reserved while the owner is held');
      flag = true;
      await db.platform.query(`UPDATE ${table('embedding_jobs')} SET dispatch_after=clock_timestamp()`);
      for (
        let i = 0;
        i < 10 &&
        !(
          await db.platform.query(
            `SELECT 1 FROM ${table('documents')} WHERE source_id=$1 AND vector_publication_id IS NOT NULL`,
            [sourceId],
          )
        ).rowCount;
        i++
      ) {
        for (const work of await embeddings.due(ws.id)) await embeddings.process(work);
      }
      assert.ok(dispatched > 0, 'work resumes when the flag is on again');
      assert.ok((await attempts()) > before);
    } finally {
      await env.close();
    }
  },
);

test(
  'Google defaults pin the recorded account and keep every manual, paused or removed choice',
  { timeout: 300000 },
  async t => {
    const env = await setup();
    const { ws, runtime, record, db, table, owner } = env;
    try {
      const integrationId = randomUUID();
      const bindings = {};
      for (const account of ['acct-a', 'acct-b', 'acct-c']) {
        bindings[account] = {
          integrationId,
          accountId: account,
          generation: 1,
          requiredScopes: [
            'https://www.googleapis.com/auth/drive.readonly',
            'https://www.googleapis.com/auth/gmail.readonly',
          ],
        };
      }
      let current = bindings['acct-a'];
      // Replacing the connected Google account keeps the integration row and changes its account.
      const use = async account => {
        current = bindings[account];
        await db.platform.query(`UPDATE ${table('tf_google_integrations')} SET account_id=$1 WHERE id=$2`, [
          account,
          integrationId,
        ]);
      };
      await db.platform.query(
        `INSERT INTO ${table('tf_google_integrations')} (id,user_id,membership_id,generation,status,account_id,email,scopes,credential) VALUES ($1,$2,$3,1,'connected',$4,'fixture@example.test',$5,'{}')`,
        [current.integrationId, owner.userId, owner.membershipId, current.accountId, current.requiredScopes],
      );
      const observation = (id, kind) => ({
        nativeId: id,
        title: `Item ${id}`,
        canonicalURL: `https://drive.google.com/file/d/${id}`,
        sourceRevision: '1',
        accessedAt: new Date().toISOString(),
        kind,
        mediaType: kind === 'message' ? 'application/json' : 'text/plain',
        parentIds: [],
        coverage: 'supported',
      });
      const provider = {
        discover: async () => ({ binding: current, items: [], nextCursor: null }),
        inspectSelection: async (_w, _u, selection) => ({
          binding: current,
          selection,
          title: selection.kind === 'gmail' ? 'Mailbox' : 'Drive',
        }),
        list: async (_w, _u, _b, s) => ({
          observations: [observation(s.kind === 'gmail' ? 'mail1' : 'file1', s.kind === 'gmail' ? 'message' : 'file')],
          nextCursor: null,
        }),
        check: async (_w, _u, _b, s, id) => {
          if (!['mail1', 'file1'].includes(id)) throw new GoogleCorpusError('not-found');
          return observation(id, s.kind === 'gmail' ? 'message' : 'file');
        },
        read: async (_w, _u, _b, s, id) => {
          const o = observation(id, s.kind === 'gmail' ? 'message' : 'file');
          return {
            ...o,
            bytes: Buffer.from('orchid terms'),
            filename: `${id}.txt`,
            normalizedContent: null,
            metadataBefore: o,
            metadataAfter: o,
          };
        },
      };
      const google = createGoogleKnowledge({ runtime, provider });
      const defaults = createDefaultKnowledge({ runtime, engines: { google }, enabled: async () => true });
      const sources = async kind =>
        (
          await db.platform.query(
            `SELECT s.account_namespace AS account,s.state FROM ${table('sources')} s JOIN ${table('google_sources')} g ON g.source_id=s.id WHERE g.selection->>'kind'${kind === 'gmail' ? '=' : '<>'}'gmail' ORDER BY s.account_namespace`,
          )
        ).rows;
      const item = async (product, accountKey) =>
        (await defaults.list(ws.id, owner.userId)).items.find(
          i => i.product === product && i.accountLabel === accountKey,
        );

      await t.test('an account replaced before processing records account-changed and creates nothing', async () => {
        await record({
          product: 'google-drive',
          membershipId: owner.membershipId,
          accountKey: 'acct-a',
          accountLabel: 'acct-a',
        });
        await use('acct-b');
        await drain(defaults, env);
        const intent = await item('google-drive', 'acct-a');
        assert.equal(intent.syncState, 'failed');
        assert.equal(intent.failure, 'account-changed');
        assert.deepEqual(await sources('drive'), [], 'no source is configured under another account');
      });

      await t.test('the original account back creates its own Drive default once', async () => {
        await use('acct-a');
        const intent = await item('google-drive', 'acct-a');
        await defaults.manage(ws.id, owner.userId, intent.intentId, { action: 'retry' });
        await drain(defaults, env);
        assert.equal((await item('google-drive', 'acct-a')).syncState, 'ready');
        assert.deepEqual(await sources('drive'), [{ account: 'acct-a', state: 'active' }]);
      });

      await t.test('a replacement account after the source exists gets its own default', async () => {
        await use('acct-b');
        await record({
          product: 'google-drive',
          membershipId: owner.membershipId,
          accountKey: 'acct-b',
          accountLabel: 'acct-b',
        });
        await drain(defaults, env);
        assert.deepEqual(await sources('drive'), [
          { account: 'acct-a', state: 'active' },
          { account: 'acct-b', state: 'active' },
        ]);
      });

      await t.test(
        'a removed manual Gmail choice and a paused manual Drive folder are never recreated or widened',
        async () => {
          const mail = await google.configure(ws.id, owner.userId, {
            commandId: randomUUID(),
            memberIds: [],
            selection: {
              kind: 'gmail',
              labelId: 'INBOX',
              after: date(Date.now() - 30 * day),
              before: date(Date.now() + day),
            },
          });
          await google.manage(ws.id, owner.userId, mail.sourceId, { commandId: randomUUID(), action: 'remove' });
          await record({
            product: 'gmail',
            membershipId: owner.membershipId,
            accountKey: 'acct-b',
            accountLabel: 'acct-b',
          });
          await use('acct-c');
          const folder = await google.configure(ws.id, owner.userId, {
            commandId: randomUUID(),
            memberIds: [],
            selection: { kind: 'drive-folder', folderId: 'root' },
          });
          await google.manage(ws.id, owner.userId, folder.sourceId, { commandId: randomUUID(), action: 'pause' });
          await record({
            product: 'google-drive',
            membershipId: owner.membershipId,
            accountKey: 'acct-c',
            accountLabel: 'acct-c',
          });
          await drain(defaults, env);
          assert.deepEqual(
            (await sources('gmail')).map(s => s.state),
            ['removed'],
            'the removed Gmail choice stays removed and no default mailbox is added',
          );
          assert.deepEqual(await sources('drive'), [
            { account: 'acct-a', state: 'active' },
            { account: 'acct-b', state: 'active' },
            { account: 'acct-c', state: 'paused' },
          ]);
          for (const [product, account] of [
            ['gmail', 'acct-b'],
            ['google-drive', 'acct-c'],
          ]) {
            const intent = await item(product, account);
            assert.equal(intent.syncState, 'ready');
            assert.deepEqual(intent.scopes, { discovered: 1, included: 0, manual: 1 });
            assert.deepEqual(intent.sources, []);
          }
        },
      );
    } finally {
      await env.close();
    }
  },
);

test('a manual choice made after planning wins over the planned automatic source', { timeout: 300000 }, async () => {
  const env = await setup();
  const { ws, runtime, record, db, table, owner } = env;
  try {
    const accountId = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_github_accounts')} (id,owner_membership_id,generation,state,config_hash,identity,scopes,credential) VALUES ($1,$2,1,'active','fixture',$3,'{repo,read:user}','{}')`,
      [accountId, owner.membershipId, { id: '101', login: 'owner' }],
    );
    const repos = Array.from({ length: 25 }, (_, i) => ({
      repositoryId: String(7000 + i),
      fullName: `acme/repo-${String(i).padStart(2, '0')}`,
      visibility: 'private',
      title: `acme/repo-${i}`,
    }));
    const provider = {
      inspectSelection: async (_w, _u, id, selection) => ({
        binding: { accountId: id, accountGeneration: 1, githubUserId: '101', login: 'owner' },
        title: 'Selected GitHub',
        repositories: selection.repositories.map(name => repos.find(r => r.fullName === name)),
      }),
    };
    const github = createGitHubKnowledge({ runtime, provider });
    const raced = repos[22];
    let first = true;
    const engines = {
      github: {
        discover: async () => ({ items: repos, nextCursor: null }),
        configure: async (w, userId, value) => {
          if (first) {
            first = false;
            await github.configure(w, userId, {
              commandId: randomUUID(),
              accountId,
              memberIds: [],
              selection: { repositories: [raced.fullName], kinds: ['issues'], after: date(Date.now() - 30 * day) },
            });
          }
          return github.configure(w, userId, value);
        },
      },
    };
    let clock = new Date(Date.now() + 1000);
    const defaults = createDefaultKnowledge({ runtime, engines, enabled: async () => true, now: () => clock });
    await record({ product: 'github', membershipId: owner.membershipId, accountKey: accountId, accountLabel: 'owner' });
    await drain(defaults, env);
    clock = new Date(clock.getTime() + 3_600_000 + 1000);
    await drain(defaults, env);
    const rows = (
      await db.platform.query(
        `SELECT r.repository_id AS id,count(*)::int AS n FROM ${table('github_repositories')} r JOIN ${table('sources')} s ON s.id=r.source_id GROUP BY r.repository_id`,
      )
    ).rows;
    assert.deepEqual(
      rows.filter(r => r.n !== 1),
      [],
      'every repository is indexed exactly once',
    );
    assert.equal(rows.length, 25);
    const automatic = (
      await db.platform.query(
        `SELECT r.repository_id AS id FROM ${table('github_repositories')} r JOIN ${table('default_sources')} d ON d.source_id=r.source_id WHERE d.state='created'`,
      )
    ).rows.map(r => r.id);
    assert.ok(!automatic.includes(raced.repositoryId), 'the raced repository stays with the manual source');
    assert.equal(automatic.length, 24);
    const [intent] = (await defaults.list(ws.id, owner.userId)).items;
    assert.equal(intent.scopes.manual, 1);
    assert.ok(
      intent.sources.some(s => s.state === 'failed' && s.failure === 'existing'),
      'the planned source records that a manual choice won',
    );
  } finally {
    await env.close();
  }
});

test(
  'Atlassian defaults isolate a refused site and keep each identity to its own sites and opt-out',
  { timeout: 300000 },
  async () => {
    const env = await setup();
    const { ws, runtime, record, owner } = env;
    try {
      const [c1, c2, c3] = [randomUUID(), randomUUID(), randomUUID()].sort();
      const sitesFor = {
        'acct-1': [
          { cloudId: c1, name: 'Acme', url: 'https://acme.atlassian.net' },
          { cloudId: c2, name: 'Beta', url: 'https://beta.atlassian.net' },
        ],
        'acct-2': [{ cloudId: c3, name: 'Gamma', url: 'https://gamma.atlassian.net' }],
      };
      const forbidden = new Set([c1]);
      const configured = [];
      const engines = {
        atlassian: {
          sites: async (_w, _u, scope) => ({ items: sitesFor[scope.account] }),
          discover: async (_w, _u, cloudId, _kind, _within, _cursor, scope) => {
            assert.ok(
              sitesFor[scope.account].some(site => site.cloudId === cloudId),
              'discovery uses only the pinned identity sites',
            );
            if (forbidden.has(cloudId)) throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
            return { items: [{ kind: 'project', id: '10', key: 'OPS', title: 'Operations' }], nextCursor: null };
          },
          configure: async (_w, _u, value) => {
            configured.push({ accountId: value.accountId, cloudId: value.selection.cloudId });
            return { sourceId: value.commandId };
          },
        },
      };
      let clock = new Date(Date.now() + 1000);
      const defaults = createDefaultKnowledge({ runtime, engines, enabled: async () => true, now: () => clock });
      const first = await record({
        product: 'jira',
        membershipId: owner.membershipId,
        accountKey: 'acct-1',
        accountLabel: 'acct-1',
      });
      await record({ product: 'jira', membershipId: owner.membershipId, accountKey: 'acct-2', accountLabel: 'acct-2' });
      await drain(defaults, env);
      const listed = async label =>
        (await defaults.list(ws.id, owner.userId)).items.find(i => i.accountLabel === label);
      assert.deepEqual(
        configured.sort((a, b) => (a.cloudId < b.cloudId ? -1 : 1)),
        [
          { accountId: 'acct-1', cloudId: c2 },
          { accountId: 'acct-2', cloudId: c3 },
        ],
      );
      assert.equal((await listed('acct-1')).syncState, 'ready', 'one refused site does not fail the account');
      assert.deepEqual((await listed('acct-1')).groupFailures, [{ title: 'Acme', failure: 'forbidden' }]);
      assert.deepEqual((await listed('acct-2')).groupFailures, []);

      await defaults.manage(ws.id, owner.userId, first.intentId, { action: 'opt-out' });
      forbidden.clear();
      clock = new Date(clock.getTime() + 3_600_000 + 1000);
      await drain(defaults, env);
      assert.equal(configured.length, 2, 'the opted-out identity discovers nothing; the other has nothing new');
      assert.equal((await listed('acct-2')).state, 'active');

      await defaults.manage(ws.id, owner.userId, first.intentId, { action: 'resume' });
      await drain(defaults, env);
      assert.deepEqual(configured.at(-1), { accountId: 'acct-1', cloudId: c1 });
      assert.deepEqual((await listed('acct-1')).groupFailures, [], 'each pass reports only its own refused sites');
    } finally {
      await env.close();
    }
  },
);

test(
  'Slack defaults stay with the recorded Slack account; a replacement identity never inherits its policy or bypasses its own opt-out',
  { timeout: 300000 },
  async t => {
    const env = await setup();
    const { ws, runtime, record, db, table, owner } = env;
    try {
      const world = await slackWorld(env);
      world.conversations.push(
        { conversationId: 'CGENERAL', kind: 'public', title: '#general' },
        { conversationId: 'CPRIVATE', kind: 'private', title: '#private' },
      );
      const slack = createSlackKnowledge({ runtime, provider: world.provider });
      let clock = new Date(Date.now() + 1000);
      const defaults = createDefaultKnowledge({
        runtime,
        engines: { slack },
        enabled: async () => true,
        now: () => clock,
      });
      const sources = async () =>
        (await db.platform.query(`SELECT count(*)::int AS n FROM ${table('slack_sources')}`)).rows[0].n;
      const listed = async key => (await defaults.list(ws.id, owner.userId)).items.find(i => i.accountKey === key);

      await t.test('an intent still pending when another Slack user links (and opts out) creates nothing', async () => {
        await world.link(owner, 'UA');
        await record({
          product: 'slack',
          membershipId: owner.membershipId,
          accountKey: 'TTEAM:UA',
          accountLabel: '@UA',
        });
        await world.link(owner, 'UB', 2);
        const replacement = await record({
          product: 'slack',
          membershipId: owner.membershipId,
          accountKey: 'TTEAM:UB',
          accountLabel: '@UB',
        });
        await defaults.manage(ws.id, owner.userId, replacement.intentId, { action: 'opt-out' });
        await drain(defaults, env).catch(() => undefined);
        assert.equal(await sources(), 0, 'no source, publication or credit for the replacement identity');
        assert.deepEqual(world.calls, []);
        const pinned = await listed('TTEAM:UA');
        assert.equal(pinned.syncState, 'failed');
        assert.equal(pinned.failure, 'account-changed');
        assert.equal((await listed('TTEAM:UB')).state, 'opted-out');
      });

      await t.test('relinking the same Slack account keeps its intent and opt-out', async () => {
        const again = await record({
          product: 'slack',
          membershipId: owner.membershipId,
          accountKey: 'TTEAM:UB',
          accountLabel: '@UB',
        });
        assert.equal(again.created, false);
        assert.equal((await listed('TTEAM:UB')).state, 'opted-out');
      });

      await t.test('an identity replaced between discovery and configuration creates nothing', async () => {
        await world.link(owner, 'UA', 3);
        const original = world.provider.inspectSelection;
        world.provider.inspectSelection = async (w, userId, selection) => {
          await world.link(owner, 'UC', 4);
          return original(w, userId, selection);
        };
        try {
          const pinned = await listed('TTEAM:UA');
          await defaults.manage(ws.id, owner.userId, pinned.intentId, { action: 'retry' });
          clock = new Date(clock.getTime() + 1000);
          await drain(defaults, env).catch(() => undefined);
        } finally {
          world.provider.inspectSelection = original;
        }
        assert.equal(await sources(), 0);
        assert.equal((await listed('TTEAM:UA')).failure, 'account-changed');
      });
    } finally {
      await env.close();
    }
  },
);

test(
  'Atlassian defaults isolate a site that refuses configuration and recover it once access returns',
  { timeout: 300000 },
  async () => {
    const env = await setup();
    const { ws, runtime, record, owner, db, table } = env;
    try {
      const [c1, c2] = [randomUUID(), randomUUID()].sort();
      const sites = [
        { cloudId: c1, name: 'Acme', url: 'https://acme.atlassian.net' },
        { cloudId: c2, name: 'Beta', url: 'https://beta.atlassian.net' },
      ];
      const refused = new Set([c1]);
      const configured = [];
      const engines = {
        atlassian: {
          sites: async () => ({ items: sites }),
          discover: async () => ({
            items: [{ kind: 'project', id: '10', key: 'OPS', title: 'Operations' }],
            nextCursor: null,
          }),
          configure: async (_w, _u, value) => {
            if (refused.has(value.selection.cloudId))
              throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
            configured.push(value.selection.cloudId);
            return { sourceId: value.commandId };
          },
        },
      };
      let clock = new Date(Date.now() + 1000);
      const defaults = createDefaultKnowledge({ runtime, engines, enabled: async () => true, now: () => clock });
      await record({ product: 'jira', membershipId: owner.membershipId, accountKey: 'acct-1', accountLabel: 'acct-1' });
      await drain(defaults, env);
      let [intent] = (await defaults.list(ws.id, owner.userId)).items;
      assert.deepEqual(configured, [c2], 'the other site still configures');
      assert.equal(intent.syncState, 'ready', 'one refused site does not fail the account');
      assert.deepEqual(intent.groupFailures, [{ title: 'Acme', failure: 'forbidden' }]);
      assert.deepEqual(intent.sources.map(s => [s.state, s.failure]).sort(), [
        ['created', null],
        ['failed', 'forbidden'],
      ]);

      refused.clear();
      clock = new Date(clock.getTime() + 3_600_000 + 1000);
      await drain(defaults, env);
      [intent] = (await defaults.list(ws.id, owner.userId)).items;
      assert.deepEqual(configured, [c2, c1], 'the refused site is created once access returns');
      assert.deepEqual(intent.groupFailures, []);
      clock = new Date(clock.getTime() + 3_600_000 + 1000);
      await drain(defaults, env);
      assert.deepEqual(configured, [c2, c1], 'no duplicates on later passes');
      const assigned = (
        await db.platform.query(
          `SELECT count(*)::int AS n FROM ${table('default_scopes')} WHERE disposition='assigned'`,
        )
      ).rows[0].n;
      assert.equal(assigned, 2);
    } finally {
      await env.close();
    }
  },
);

test(
  'automatic status waits for provider ingestion and shows a source-wide failure until Retry recovers it',
  { timeout: 300000 },
  async () => {
    const env = await setup();
    const { ws, runtime, record, db, table, owner } = env;
    try {
      const world = await slackWorld(env);
      await world.link(owner, 'UOWNER');
      world.conversations.push({ conversationId: 'CGENERAL', kind: 'public', title: '#general' });
      const slack = createSlackKnowledge({ runtime, provider: world.provider });
      const defaults = createDefaultKnowledge({
        runtime,
        engines: { slack },
        enabled: async () => true,
        now: () => new Date(Date.now() + 1000),
      });
      await record({
        product: 'slack',
        membershipId: owner.membershipId,
        accountKey: 'TTEAM:UOWNER',
        accountLabel: '@UOWNER',
      });
      await drain(defaults, env);
      const status = async () => (await defaults.list(ws.id, owner.userId)).items[0];
      let intent = await status();
      assert.equal(intent.syncState, 'ready', 'discovery finished');
      assert.deepEqual(
        intent.ingestion,
        { state: 'pending', pending: 1, failed: 0, failure: null },
        'a configured but unprocessed source is not complete',
      );
      const [{ sourceId, syncState }] = intent.sources;
      assert.equal(syncState, 'queued');

      const list = world.provider.list;
      world.provider.list = async () => {
        throw new Error('first list failed');
      };
      await db.platform.query(
        `UPDATE ${table('slack_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
        [sourceId],
      );
      const work = (await slack.due(ws.id)).find(w => w.sourceId === sourceId);
      assert.equal((await slack.process(work)).disposition, 'retry');
      intent = await status();
      assert.deepEqual(
        intent.ingestion,
        { state: 'failed', pending: 0, failed: 1, failure: 'provider' },
        'a source-wide failure is visible on the automatic status',
      );
      assert.equal(intent.sources[0].syncFailure, 'provider');

      world.provider.list = list;
      intent = await defaults.manage(ws.id, owner.userId, intent.intentId, { action: 'retry' });
      assert.equal(intent.ingestion.state, 'pending', 'Retry restarts the failed source sync');
      await sync(slack, env, 'slack_sources', sourceId);
      intent = await status();
      assert.equal(intent.ingestion.state, 'ready');
      assert.equal(intent.counts.total, 1);
    } finally {
      await env.close();
    }
  },
);

test(
  'automatic Retry rebinds failed sources to the relinked account through each source Retry; paused, other-account and refused sources stay as they are',
  { timeout: 300000 },
  async () => {
    const env = await setup();
    const { ws, runtime, db, table, owner } = env;
    try {
      const world = await slackWorld(env);
      await world.link(owner, 'UOWNER');
      const slack = createSlackKnowledge({ runtime, provider: world.provider });
      const ids = [];
      for (const id of ['CREBOUND', 'CPAUSED', 'CREFUSED', 'COTHER'])
        ids.push((await slack.configure(ws.id, owner.userId, channels(id))).sourceId);
      const intentId = await automatic(env, owner, 'slack', 'TTEAM:UOWNER', ids);
      for (const id of ids) await sync(slack, env, 'slack_sources', id);
      const binding = async id =>
        (await db.platform.query(`SELECT binding FROM ${table('slack_sources')} WHERE source_id=$1`, [id])).rows[0]
          .binding;
      const row = async id =>
        (
          await db.platform.query(
            `SELECT s.state,g.sync_state,g.failure FROM ${table('slack_sources')} g JOIN ${table('sources')} s ON s.id=g.source_id WHERE g.source_id=$1`,
            [id],
          )
        ).rows[0];
      const before = await binding(ids[0]);

      // A reinstall and relink of the same Slack user: the installation generation and identity change, so every old binding is stale.
      await db.platform.query(`UPDATE ${table('tf_slack_installations')} SET generation=2 WHERE id=$1`, [
        before.installationId,
      ]);
      await world.link(owner, 'UOWNER', 2);
      world.bindings.set(owner.userId, { ...world.bindings.get(owner.userId), installationGeneration: 2 });
      for (const id of ids) {
        await db.platform.query(
          `UPDATE ${table('slack_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
          [id],
        );
        const work = (await slack.due(ws.id)).find(w => w.sourceId === id);
        assert.equal((await slack.process(work)).disposition, 'retry');
        // The old binding no longer names a linked reader, so the source fails until it is rebound.
        assert.deepEqual(await row(id), { state: 'active', sync_state: 'failed', failure: 'not-linked' });
      }
      await slack.manage(ws.id, owner.userId, ids[1], { commandId: randomUUID(), action: 'pause' });
      await db.platform.query(
        `UPDATE ${table('slack_sources')} SET sync_state='failed',failure='not-linked' WHERE source_id=$1`,
        [ids[1]],
      );
      // A source bound to another Slack account is outside this intent's account, even though the intent lists it.
      await db.platform.query(
        `UPDATE ${table('slack_sources')} SET binding=jsonb_set(binding,'{slackUserId}','"UOTHER"') WHERE source_id=$1`,
        [ids[3]],
      );
      const otherBinding = await binding(ids[3]);

      const retried = [];
      const engine = {
        ...slack,
        manage: async (w, u, sourceId, value) => {
          retried.push(sourceId);
          if (sourceId === ids[2]) throw new SlackCorpusError('transient');
          return slack.manage(w, u, sourceId, value);
        },
      };
      const defaults = createDefaultKnowledge({ runtime, engines: { slack: engine }, enabled: async () => true });
      const status = await defaults.manage(ws.id, owner.userId, intentId, { action: 'retry' });
      assert.deepEqual(
        retried,
        [ids[0], ids[2]],
        'only active failed sources of the intent account run their own Retry, in order',
      );
      assert.deepEqual(
        await binding(ids[0]),
        world.bindings.get(owner.userId),
        'Retry rebinds to the current authorization',
      );
      assert.equal((await row(ids[0])).sync_state, 'queued');
      assert.equal(status.ingestion.state, 'failed', 'the refused source still shows its failure');
      assert.deepEqual(
        await row(ids[1]),
        { state: 'paused', sync_state: 'failed', failure: 'not-linked' },
        'a paused source is unchanged',
      );
      assert.deepEqual(await binding(ids[1]), before);
      assert.deepEqual(
        await row(ids[2]),
        { state: 'active', sync_state: 'failed', failure: 'not-linked' },
        'a refused Retry leaves only that source failed',
      );
      assert.deepEqual(await binding(ids[3]), otherBinding, 'another account is never rebound');
      assert.equal((await row(ids[3])).sync_state, 'failed');

      await sync(slack, env, 'slack_sources', ids[0]);
      assert.equal((await row(ids[0])).sync_state, 'ready', 'the rebound source syncs again');
      const documents = (
        await db.platform.query(
          `SELECT count(*)::int AS n,count(*) FILTER (WHERE lexical_publication_id IS NOT NULL)::int AS published FROM ${table('documents')} WHERE source_id=$1 AND tombstoned_at IS NULL`,
          [ids[0]],
        )
      ).rows[0];
      assert.deepEqual(documents, { n: 1, published: 1 }, 'the same source republishes without duplicate documents');
      assert.equal(
        (await db.platform.query(`SELECT count(*)::int AS n FROM ${table('sources')}`)).rows[0].n,
        4,
        'no source is created by Retry',
      );

      // A repeated Retry is a new command; the paused and other-account sources stay as they are.
      retried.length = 0;
      await defaults.manage(ws.id, owner.userId, intentId, { action: 'retry' });
      assert.deepEqual(retried, [ids[2]]);
    } finally {
      await env.close();
    }
  },
);
