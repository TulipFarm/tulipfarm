import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import {
  createDefaultKnowledge,
  createSlackKnowledge,
  createGoogleKnowledge,
  createGitHubKnowledge,
  SlackCorpusError,
  GitHubCorpusError,
} from '../dist/index.js';
import { GoogleCorpusError } from '@tulipfarm/google-workspace/corpus';

const day = 86_400_000;
const date = time => new Date(time).toISOString().slice(0, 10);
const ts = time => `${Math.floor(time / 1000)}.000100`;

test('automatic sources keep a rolling 90-day window and stop when their gate closes', { timeout: 300000 }, async t => {
  const db = await fixture();
  let runtime;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const ws = await db.create(await workspaceTableMigrations());
    const table = name => qualified(ws.names.schema, name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(ws) }),
    });
    const installationId = randomUUID();
    const identityId = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_slack_installations')} (id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after) VALUES ($1,'AAPP','TTEAM','UBOT',1,'active','{chat:write}','{}',0)`,
      [installationId],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_slack_identities')} (id,installation_id,generation,slack_user_id,user_id,membership_id,state,credential,scopes) VALUES ($1,$2,1,'UOWNER',$3,$4,'authorized','{}',$5)`,
      [
        identityId,
        installationId,
        ws.userId,
        ws.membershipId,
        ['channels:history', 'channels:read', 'groups:history', 'groups:read'],
      ],
    );
    let clock = Date.now() + 1000;
    let open = true;
    const afters = [];
    const threads = new Map([[ts(clock - 80 * day), 'orchid shipment from the old quarter']]);
    const binding = { installationId, installationGeneration: 1, identityId, slackUserId: 'UOWNER', teamId: 'TTEAM' };
    const inWindow = (stamp, after) => Number(stamp.split('.')[0]) * 1000 >= Date.parse(after);
    const observation = stamp => ({
      nativeId: `CGENERAL:${stamp}`,
      conversationId: 'CGENERAL',
      ts: stamp,
      title: '#general thread',
      canonicalURL: `https://app.slack.com/client/TTEAM/CGENERAL/thread/CGENERAL-${stamp}`,
      sourceRevision: '1',
      accessedAt: new Date().toISOString(),
      coverage: 'supported',
    });
    const provider = {
      discover: async () => ({ binding, items: [], nextCursor: null }),
      inspectSelection: async (_w, _u, selection) => ({
        binding,
        title: 'Selected Slack',
        conversations: selection.conversationIds.map(id => ({ conversationId: id, kind: 'public', title: '#general' })),
      }),
      access: async (_w, _u, _b, id) => ({
        conversationId: id,
        kind: 'public',
        title: '#general',
        accessedAt: new Date().toISOString(),
        member: true,
        archived: false,
      }),
      list: async (_w, _u, _b, _id, after) => {
        afters.push(after);
        return {
          observations: [...threads.keys()].filter(stamp => inWindow(stamp, after)).map(observation),
          nextCursor: null,
        };
      },
      read: async (_w, _u, _b, _id, stamp, after) => {
        if (!threads.has(stamp)) throw new SlackCorpusError('not-found');
        if (!inWindow(stamp, after)) throw new SlackCorpusError('outside-selection');
        return {
          ...observation(stamp),
          markdown: `# Thread\n\n## Message by UOWNER at 2026-01-01T00:00:00.000Z\n\n${threads.get(stamp)}\n`,
        };
      },
    };
    const slack = createSlackKnowledge({
      runtime,
      provider,
      now: () => clock,
      gate: async () => (open ? [] : [source.sourceId]),
    });
    const source = await slack.configure(ws.id, ws.userId, {
      commandId: randomUUID(),
      memberIds: [],
      selection: {
        kind: 'channels',
        conversationIds: ['CGENERAL'],
        after: date(clock - 90 * day),
        window: 'rolling-90d',
      },
    });
    const live = async () =>
      (
        await db.platform.query(`SELECT id FROM ${table('documents')} WHERE source_id=$1 AND tombstoned_at IS NULL`, [
          source.sourceId,
        ])
      ).rows.length;
    // The source is the automatic source of a real default intent, so its status is read the way the Integrations screen reads it.
    const intentId = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('default_intents')} (id,product,membership_id,account_key,account_label,sync_state) VALUES ($1,'slack',$2,'TTEAM:UOWNER','@UOWNER','ready')`,
      [intentId, ws.membershipId],
    );
    await db.platform.query(
      `INSERT INTO ${table('default_sources')} (source_id,intent_id,ordinal,selection,state) VALUES ($1,$2,1,'{}','created')`,
      [source.sourceId, intentId],
    );
    const defaults = createDefaultKnowledge({ runtime, engines: {}, enabled: async () => true });
    const status = async () => (await defaults.list(ws.id, ws.userId)).items.find(i => i.intentId === intentId);
    const texts = async () =>
      (
        await db.platform.query(
          `SELECT d.tombstoned_at IS NULL AS live, d.retain_until IS NOT NULL AS retained, o.markdown FROM ${table('documents')} d JOIN ${table('slack_originals')} o ON o.revision_id=d.observed_revision_id WHERE d.source_id=$1 ORDER BY d.native_id`,
          [source.sourceId],
        )
      ).rows;
    async function sync() {
      for (let i = 0; i < 12; i++) {
        await db.platform.query(
          `UPDATE ${table('slack_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
          [source.sourceId],
        );
        const work = (await slack.due(ws.id)).find(w => w.sourceId === source.sourceId);
        if (!work) return;
        if ((await slack.process(work)).disposition === 'ready') return;
      }
      assert.fail('bounded sync did not complete');
    }

    await t.test('the first pass imports activity inside the window that ends now', async () => {
      assert.deepEqual(
        (await status()).ingestion,
        { state: 'pending', pending: 1, failed: 0, failure: null },
        'a configured source is still being indexed before its first pass',
      );
      await sync();
      assert.equal(afters.at(-1), date(clock - 90 * day));
      assert.equal(await live(), 1);
      assert.equal(
        (await slack.list(ws.id, ws.userId)).items[0].selection.after,
        date(clock - 90 * day),
        'the source shows its current window',
      );
    });

    await t.test('after the clock moves, new activity enters and aged-out activity is tombstoned', async () => {
      clock += 20 * day;
      threads.set(ts(clock - day), 'orchid shipment confirmed this week');
      await sync();
      assert.equal(afters.at(-1), date(clock - 90 * day), 'the stored selection is not frozen at configuration time');
      const rows = await texts();
      assert.deepEqual(
        rows.map(row => [row.live, /this week/.test(row.markdown)]),
        [
          [false, false],
          [true, true],
        ],
      );
      assert.equal(rows[0].retained, true, 'aged-out content keeps the normal tombstone retention');
      const stored = (
        await db.platform.query(
          `SELECT selection->>'after' AS after, selection->>'window' AS window FROM ${table('slack_sources')} WHERE source_id=$1`,
          [source.sourceId],
        )
      ).rows[0];
      assert.equal(stored.window, 'rolling-90d');
      const automatic = await status();
      assert.equal(automatic.counts.total, 1, 'aged-out activity is no longer counted as coverage');
      assert.equal(automatic.counts.queued + automatic.counts.ready, 1);
      assert.equal(
        automatic.counts.queued,
        automatic.counts.total - automatic.counts.ready,
        'retired documents never stay queued',
      );
      assert.equal(automatic.ingestion.state, 'ready');
    });

    await t.test('a closed gate removes queued work and stops processing without deleting content', async () => {
      await db.platform.query(
        `UPDATE ${table('slack_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
        [source.sourceId],
      );
      const [work] = (await slack.due(ws.id)).filter(w => w.sourceId === source.sourceId);
      assert.ok(work);
      open = false;
      assert.deepEqual(
        (await slack.due(ws.id)).filter(w => w.sourceId === source.sourceId),
        [],
      );
      const calls = afters.length;
      assert.equal((await slack.process(work)).disposition, 'stale');
      assert.equal(afters.length, calls, 'no provider work runs behind a closed gate');
      assert.equal(await live(), 1);
      open = true;
      assert.equal(
        (await slack.due(ws.id)).filter(w => w.sourceId === source.sourceId).length,
        1,
        'work resumes when the gate opens again',
      );
    });
  } finally {
    await runtime?.close?.();
    await db.close();
  }
});

async function workspace() {
  const db = await fixture();
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const ws = await db.create(await workspaceTableMigrations());
  const table = name => qualified(ws.names.schema, name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
  const runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(ws) }),
  });
  const live = async sourceId =>
    (
      await db.platform.query(
        `SELECT native_id FROM ${table('documents')} WHERE source_id=$1 AND tombstoned_at IS NULL ORDER BY native_id`,
        [sourceId],
      )
    ).rows.map(r => r.native_id);
  return { db, ws, table, runtime, live };
}

async function drain(engine, db, ws, table, sourceTable, sourceId) {
  for (let i = 0; i < 12; i++) {
    await db.platform.query(`UPDATE ${table(sourceTable)} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`, [
      sourceId,
    ]);
    const work = (await engine.due(ws.id)).find(w => w.sourceId === sourceId);
    if (!work) return;
    if ((await engine.process(work)).disposition === 'ready') return;
  }
  assert.fail('bounded sync did not complete');
}

test('an automatic Gmail source rolls its 90-day window forward with the clock', { timeout: 300000 }, async () => {
  const { db, ws, table, runtime, live } = await workspace();
  try {
    const binding = {
      integrationId: randomUUID(),
      accountId: 'mail-account',
      generation: 1,
      requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    };
    await db.platform.query(
      `INSERT INTO ${table('tf_google_integrations')} (id,user_id,membership_id,generation,status,account_id,email,scopes,credential) VALUES ($1,$2,$3,1,'connected',$4,'fixture@example.test',$5,'{}')`,
      [binding.integrationId, ws.userId, ws.membershipId, binding.accountId, binding.requiredScopes],
    );
    let clock = Date.now() + 1000;
    const messages = new Map([['oldmail', { at: clock - 80 * day, text: 'orchid invoice from the old quarter' }]]);
    const lists = [];
    const inWindow = (id, s) =>
      messages.get(id).at >= Date.parse(s.after) && messages.get(id).at < Date.parse(s.before);
    const observation = id => ({
      nativeId: id,
      title: `Mail ${id}`,
      canonicalURL: `https://mail.google.com/mail/u/0/#all/${id}`,
      sourceRevision: '1',
      accessedAt: new Date().toISOString(),
      kind: 'message',
      mediaType: 'application/json',
      parentIds: [],
      coverage: 'supported',
    });
    const visible = (id, s) => {
      if (!messages.has(id)) throw new GoogleCorpusError('not-found');
      if (!inWindow(id, s)) throw new GoogleCorpusError('outside-selection');
      return observation(id);
    };
    const provider = {
      discover: async () => ({ binding, items: [], nextCursor: null }),
      inspectSelection: async (_w, _u, selection) => ({ binding, selection, title: 'Mailbox' }),
      list: async (_w, _u, _b, s) => {
        lists.push([s.after, s.before]);
        return { observations: [...messages.keys()].filter(id => inWindow(id, s)).map(observation), nextCursor: null };
      },
      check: async (_w, _u, _b, s, id) => visible(id, s),
      read: async (_w, _u, _b, s, id) => {
        const o = visible(id, s);
        return {
          ...o,
          bytes: Buffer.from(JSON.stringify({ id })),
          filename: `${id}.json`,
          normalizedContent: `# Mail ${id}\n\n${messages.get(id).text}\n`,
          metadataBefore: o,
          metadataAfter: o,
        };
      },
    };
    const google = createGoogleKnowledge({ runtime, provider, now: () => clock });
    const source = await google.configure(ws.id, ws.userId, {
      commandId: randomUUID(),
      memberIds: [],
      accountId: 'mail-account',
      selection: {
        kind: 'gmail',
        labelId: null,
        after: date(clock - 90 * day),
        before: date(clock + day),
        window: 'rolling-90d',
        excludeSpamTrash: true,
      },
    });
    await drain(google, db, ws, table, 'google_sources', source.sourceId);
    assert.deepEqual(lists.at(-1), [date(clock - 90 * day), date(clock + day)]);
    assert.deepEqual(await live(source.sourceId), ['oldmail']);

    clock += 20 * day;
    messages.set('newmail', { at: clock - day, text: 'orchid invoice paid this week' });
    await drain(google, db, ws, table, 'google_sources', source.sourceId);
    await drain(google, db, ws, table, 'google_sources', source.sourceId);
    assert.deepEqual(
      lists.at(-1),
      [date(clock - 90 * day), date(clock + day)],
      'the read window ends at the current clock',
    );
    assert.deepEqual(await live(source.sourceId), ['newmail'], 'new mail enters and aged-out mail is tombstoned');
    const stored = (
      await db.platform.query(
        `SELECT selection->>'window' AS window FROM ${table('google_sources')} WHERE source_id=$1`,
        [source.sourceId],
      )
    ).rows[0];
    assert.equal(stored.window, 'rolling-90d');
    await assert.rejects(
      google.configure(ws.id, ws.userId, {
        commandId: randomUUID(),
        memberIds: [],
        accountId: 'another-account',
        selection: { kind: 'gmail', labelId: 'INBOX', after: date(clock - 90 * day), before: date(clock + day) },
      }),
      error => error.code === 'account-changed',
      'a pinned account must still be the connected account',
    );
  } finally {
    await runtime.close?.();
    await db.close();
  }
});

test('an automatic GitHub source rolls its 90-day window forward with the clock', { timeout: 300000 }, async () => {
  const { db, ws, table, runtime, live } = await workspace();
  try {
    const accountId = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_github_accounts')} (id,owner_membership_id,generation,state,config_hash,identity,scopes,credential) VALUES ($1,$2,1,'active','fixture',$3,'{repo,read:user}','{}')`,
      [accountId, ws.membershipId, { id: '101', login: 'owner' }],
    );
    const binding = { accountId, accountGeneration: 1, githubUserId: '101', login: 'owner' };
    let clock = Date.now() + 1000;
    const issues = new Map([['issue:7001:1', { at: clock - 80 * day, text: 'orchid shipment from the old quarter' }]]);
    const afters = [];
    const inWindow = (id, s) => issues.get(id).at >= Date.parse(s.after);
    const observation = id => ({
      nativeId: id,
      repositoryId: '7001',
      kind: 'issue',
      title: `acme/handbook ${id}`,
      canonicalURL: 'https://github.com/acme/handbook',
      sourceRevision: 'issue:1',
      accessedAt: new Date().toISOString(),
      coverage: 'supported',
    });
    const provider = {
      discover: async () => assert.fail('not used'),
      inspectSelection: async (_w, _u, id) => ({
        binding: { ...binding, accountId: id },
        title: 'acme/handbook',
        repositories: [
          { repositoryId: '7001', fullName: 'acme/handbook', visibility: 'private', title: 'acme/handbook' },
        ],
      }),
      access: async () => ({
        repositoryId: '7001',
        fullName: 'acme/handbook',
        visibility: 'private',
        title: 'acme/handbook',
        accessedAt: new Date().toISOString(),
        readable: true,
      }),
      list: async (_w, _u, _b, _id, s) => {
        afters.push(s.after);
        return { observations: [...issues.keys()].filter(id => inWindow(id, s)).map(observation), nextCursor: null };
      },
      read: async (_w, _u, _b, _id, nativeId, s) => {
        if (!issues.has(nativeId)) throw new GitHubCorpusError('not-found');
        if (!inWindow(nativeId, s)) throw new GitHubCorpusError('outside-selection');
        return { ...observation(nativeId), markdown: `# ${nativeId}\n\n${issues.get(nativeId).text}\n` };
      },
    };
    const github = createGitHubKnowledge({ runtime, provider, now: () => clock });
    const source = await github.configure(ws.id, ws.userId, {
      commandId: randomUUID(),
      accountId,
      memberIds: [],
      selection: {
        repositories: ['acme/handbook'],
        kinds: ['code', 'discussions', 'docs', 'issues', 'pulls'],
        after: date(clock - 90 * day),
        window: 'rolling-90d',
      },
    });
    await drain(github, db, ws, table, 'github_sources', source.sourceId);
    assert.equal(afters.at(-1), date(clock - 90 * day));
    assert.deepEqual(await live(source.sourceId), ['issue:7001:1']);

    clock += 20 * day;
    issues.set('issue:7001:2', { at: clock - day, text: 'orchid shipment confirmed this week' });
    await drain(github, db, ws, table, 'github_sources', source.sourceId);
    await drain(github, db, ws, table, 'github_sources', source.sourceId);
    assert.equal(afters.at(-1), date(clock - 90 * day), 'the stored selection is not frozen at configuration time');
    assert.deepEqual(
      await live(source.sourceId),
      ['issue:7001:2'],
      'new activity enters and aged-out activity is tombstoned',
    );
  } finally {
    await runtime.close?.();
    await db.close();
  }
});
