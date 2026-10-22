import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { heartbeatFixture } from './heartbeat-fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

test('heartbeat begins now, pins instructions, uses real Gmail q, deduplicates across revisions and returns private results', async () => {
  const f = await heartbeatFixture();
  try {
    assert.equal((await f.service.read(f.workspace.id, f.member.userId)).enabled, false);
    const commandId = randomUUID();
    const settings = {
      query: 'from:billing@example.test {subject:invoice subject:receipt} -is:spam',
      instructions: 'Extract the invoice amount.',
      labelId: 'INBOX',
    };
    const config = await f.configure(settings, 0, commandId);
    assert.equal(config.revision, 1);
    assert.deepEqual(await f.configure(settings, 0, commandId), config);
    await assert.rejects(f.configure({ ...settings, query: 'changed' }, 0, commandId), /heartbeat-conflict/);
    assert.deepEqual(
      f.calls.map(url => url.pathname),
      ['/gmail/v1/users/me/profile'],
    );
    const work = await f.work();
    await f.service.poll(work);
    assert.equal(f.calls.at(-1).searchParams.get('startHistoryId'), '100');
    await f.make().poll(work);
    const search = f.calls.find(url => url.pathname.endsWith('/messages'));
    assert.match(
      search.searchParams.get('q'),
      /^\(from:billing@example.test \{subject:invoice subject:receipt\} -is:spam\) after:\d+$/,
    );
    assert.equal(search.searchParams.get('labelIds'), 'INBOX');
    assert.equal((await f.results()).results[0].instructions, 'Extract the invoice amount.');
    await f.service.process(work, async input => {
      await input.authorize();
      return 'Invoice amount is $42.';
    });
    assert.equal((await f.results()).results[0].answer, 'Invoice amount is $42.');
    await f.configure({ instructions: 'Different instructions.' }, 1);
    await f.service.poll(work);
    await f.service.poll(work);
    assert.equal((await f.results()).results.length, 1);
    assert.equal((await f.results()).results[0].instructions, 'Extract the invoice amount.');
    await assert.rejects(f.service.results(f.workspace.id, f.admin.userId), /integration-required/);
    assert.equal((await f.service.read(f.workspace.id, f.admin.userId)).revision, 0);
    await f.connect({ userId: f.admin.userId, sessionId: randomUUID() });
    assert.deepEqual(await f.service.results(f.workspace.id, f.admin.userId), { results: [], nextCursor: null });
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::int AS count FROM ${f.table('tf_google_proposals')}`)).rows[0].count,
      0,
    );
  } finally {
    await f.close();
  }
});

test('history pages and matching intersection resume after restart without accepting unmatched or old mail', async () => {
  const f = await heartbeatFixture();
  try {
    await f.configure();
    const work = await f.work();
    f.set({
      history: url =>
        Response.json(
          url.searchParams.has('pageToken')
            ? {
                historyId: '200',
                history: [{ messagesAdded: [{ message: { id: 'mail2' } }, { message: { id: 'old' } }] }],
              }
            : {
                historyId: '190',
                nextPageToken: 'history-page2',
                history: [{ messagesAdded: [{ message: { id: 'mail1' } }, { message: { id: 'unmatched' } }] }],
              },
        ),
      matching: url =>
        Response.json(
          url.searchParams.has('pageToken')
            ? { messages: [{ id: 'mail2' }, { id: 'old' }] }
            : { messages: [{ id: 'mail1' }, { id: 'unrelated' }], nextPageToken: 'match-page2' },
        ),
      message: url =>
        Response.json({
          id: url.pathname.split('/').at(-1),
          internalDate: url.pathname.endsWith('/old') ? '1' : String(Date.now() + 10000),
          snippet: 'mail',
        }),
    });
    for (let i = 0; i < 4; i++) await f.make().poll(work);
    assert.deepEqual((await f.results()).results.map(item => item.messageId).sort(), ['mail1', 'mail2']);
    const checkpoint = (await f.db.platform.query(`SELECT checkpoint FROM ${f.table('tf_google_heartbeats')}`)).rows[0]
      .checkpoint;
    assert.deepEqual(checkpoint, { kind: 'idle', cursor: '200' });
    assert.equal(
      f.calls.some(url => url.pathname.endsWith('/unmatched') || url.pathname.endsWith('/unrelated')),
      false,
    );
  } finally {
    await f.close();
  }
});

test('empty history advances its cursor without scanning old matches and later new mail is processed', async () => {
  const f = await heartbeatFixture();
  try {
    await f.configure();
    const work = await f.work();
    f.set({
      history: { historyId: '200', history: [] },
      matching: { messages: [{ id: 'old-match' }], nextPageToken: 'unneeded' },
    });
    await f.service.poll(work);
    const checkpoint = (await f.db.platform.query(`SELECT checkpoint FROM ${f.table('tf_google_heartbeats')}`)).rows[0]
      .checkpoint;
    assert.deepEqual(checkpoint, { kind: 'idle', cursor: '200' });
    assert.equal(f.calls.filter(url => url.pathname.endsWith('/messages')).length, 0);
    f.set({
      history: { historyId: '201', history: [{ messagesAdded: [{ message: { id: 'new-mail' } }] }] },
      matching: { messages: [{ id: 'new-mail' }] },
    });
    await f.make().poll(work);
    assert.equal(f.calls.at(-1).searchParams.get('startHistoryId'), '200');
    await f.make().poll(work);
    assert.deepEqual(
      (await f.results()).results.map(item => item.messageId),
      ['new-mail'],
    );
  } finally {
    await f.close();
  }
});

test('an empty final history page retains candidates from preceding pages', async () => {
  const f = await heartbeatFixture();
  try {
    await f.configure();
    const work = await f.work();
    f.set({
      history: url =>
        Response.json(
          url.searchParams.has('pageToken')
            ? { historyId: '200', history: [] }
            : { historyId: '190', nextPageToken: 'last', history: [{ messagesAdded: [{ message: { id: 'mail1' } }] }] },
        ),
    });
    await f.service.poll(work);
    await f.make().poll(work);
    await f.make().poll(work);
    assert.deepEqual(
      (await f.results()).results.map(item => item.messageId),
      ['mail1'],
    );
    assert.deepEqual(
      (await f.db.platform.query(`SELECT checkpoint FROM ${f.table('tf_google_heartbeats')}`)).rows[0].checkpoint,
      { kind: 'idle', cursor: '200' },
    );
  } finally {
    await f.close();
  }
});

test('expired history anchors before full matching recovery then catches mail arriving during scan', async () => {
  const f = await heartbeatFixture();
  try {
    await f.configure();
    const work = await f.work();
    f.set({
      history: 404,
      profile: '200',
      matching: url =>
        Response.json(
          url.searchParams.has('pageToken')
            ? { messages: [{ id: 'mail2' }] }
            : { messages: [{ id: 'mail1' }], nextPageToken: 'recovery2' },
        ),
    });
    await f.service.poll(work);
    assert.equal(
      (await f.service.read(f.workspace.id, f.member.userId)).gapNotice,
      'history-expired-deleted-mail-unavailable',
    );
    assert.equal(f.calls.at(-1).pathname.endsWith('/profile'), true);
    await f.make().poll(work);
    await f.make().poll(work);
    f.set({
      history: { historyId: '201', history: [{ messagesAdded: [{ message: { id: 'mail3' } }] }] },
      matching: { messages: [{ id: 'mail1' }, { id: 'mail2' }, { id: 'mail3' }] },
    });
    await f.make().poll(work);
    assert.equal(f.calls.at(-1).searchParams.get('startHistoryId'), '200');
    await f.make().poll(work);
    assert.deepEqual((await f.results()).results.map(item => item.messageId).sort(), ['mail1', 'mail2', 'mail3']);
    assert.equal(f.calls.filter(url => /\/messages\/mail[12]$/.test(url.pathname)).length, 2);
  } finally {
    await f.close();
  }
});

test('intake and checkpoint roll back together on a deferred PostgreSQL COMMIT failure', async () => {
  const f = await heartbeatFixture();
  try {
    await f.configure();
    const work = await f.work();
    await f.service.poll(work);
    const before = (await f.db.platform.query(`SELECT checkpoint FROM ${f.table('tf_google_heartbeats')}`)).rows[0]
      .checkpoint;
    await f.db.platform.query(
      `CREATE FUNCTION ${f.table('fail_heartbeat_commit')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced heartbeat commit failure'; END $$; CREATE CONSTRAINT TRIGGER fail_heartbeat_commit AFTER INSERT ON ${f.table('tf_google_heartbeat_items')} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${f.table('fail_heartbeat_commit')}()`,
    );
    await f.service.poll(work);
    assert.equal((await f.results()).results.length, 0);
    assert.deepEqual(
      (await f.db.platform.query(`SELECT checkpoint FROM ${f.table('tf_google_heartbeats')}`)).rows[0].checkpoint,
      before,
    );
    await f.db.platform.query(`DROP TRIGGER fail_heartbeat_commit ON ${f.table('tf_google_heartbeat_items')}`);
    await f.make().poll(work);
    assert.equal((await f.results()).results[0].messageId, 'mail1');
  } finally {
    await f.close();
  }
});

test('concurrent workers and stolen epochs cannot checkpoint, duplicate intake, or publish stale answers', async () => {
  const f = await heartbeatFixture();
  try {
    await f.configure();
    const work = await f.work();
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    f.set({
      hook: async url => {
        if (url.pathname.endsWith('/history')) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    const poll = f.service.poll(work);
    await entered.promise;
    await f.make().poll(work);
    await f.db.platform.query(`UPDATE ${f.table('tf_google_heartbeats')} SET epoch=epoch+1,lease_until=NULL`);
    release.resolve();
    await poll;
    assert.deepEqual(
      (await f.db.platform.query(`SELECT checkpoint FROM ${f.table('tf_google_heartbeats')}`)).rows[0].checkpoint,
      { kind: 'idle', cursor: '100' },
    );
    f.set({ hook: async () => undefined });
    await f.service.poll(work);
    await Promise.all([f.service.poll(work), f.make().poll(work)]);
    assert.equal((await f.results()).results.length, 1);
    const modelEntered = Promise.withResolvers(),
      modelRelease = Promise.withResolvers();
    const process = f.service.process(work, async () => {
      modelEntered.resolve();
      await modelRelease.promise;
      return 'must not publish';
    });
    await modelEntered.promise;
    await f.configure({ enabled: false }, 1);
    modelRelease.resolve();
    await process;
    assert.equal((await f.results()).results[0].status, 'cancelled');
    assert.equal((await f.results()).results[0].answer, null);
  } finally {
    await f.close();
  }
});

test('disconnect, account replacement, and membership reincarnation deny old results but explicit configuration progresses', async () => {
  const f = await heartbeatFixture();
  try {
    await f.configure();
    const work = await f.work();
    await f.service.poll(work);
    await f.service.poll(work);
    await f.service.process(work, async () => 'private answer');
    await f.serviceOptions.runtime.transaction(f.workspace.id, commonCompatibility, tx =>
      tx.client.query(
        `UPDATE ${f.table('tf_google_integrations')} SET generation=generation+1,status='disconnected',credential=NULL,account_id=NULL,email=NULL,scopes='{}'`,
      ),
    );
    await assert.rejects(f.results(), /integration-required/);
    f.behavior({ account: 'replacement-account' });
    await f.connect();
    assert.equal((await f.results()).results.length, 0);
    await f.configure({}, 1);
    await f.service.poll(work);
    await f.service.poll(work);
    await f.service.process(work, async () => 'new account answer');
    assert.equal((await f.results()).results[0].answer, 'new account answer');
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
      f.member.membershipId,
    ]);
    await assert.rejects(f.results());
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      randomUUID(),
      f.member.userId,
    ]);
    assert.equal((await f.service.read(f.workspace.id, f.member.userId)).revision, 0);
    await assert.rejects(f.results(), /integration-required/);
  } finally {
    await f.close();
  }
});

test('reenable uses current baseline, immutable intake cannot be edited, and result pagination is owner-bound', async () => {
  const f = await heartbeatFixture();
  try {
    await f.configure();
    const work = await f.work();
    f.set({
      history: {
        historyId: '101',
        history: [
          { messagesAdded: [{ message: { id: 'mail1' } }, { message: { id: 'mail2' } }, { message: { id: 'mail3' } }] },
        ],
      },
      matching: { messages: [{ id: 'mail1' }, { id: 'mail2' }, { id: 'mail3' }] },
    });
    await f.service.poll(work);
    await f.service.poll(work);
    const first = await f.service.results(f.workspace.id, f.member.userId, { limit: 1 });
    const second = await f.service.results(f.workspace.id, f.member.userId, { limit: 1, before: first.nextCursor });
    const third = await f.service.results(f.workspace.id, f.member.userId, { limit: 1, before: second.nextCursor });
    assert.equal(new Set([...first.results, ...second.results, ...third.results].map(item => item.id)).size, 3);
    assert.equal(third.nextCursor, null);
    await assert.rejects(
      f.runtime.transaction(f.workspace.id, commonCompatibility, tx =>
        tx.client.query(`UPDATE ${f.table('tf_google_heartbeat_items')} SET instructions='evil'`),
      ),
      error => error.code === '42501',
    );
    await f.service.process(work, async () => 'bounded first batch');
    assert.equal((await f.results()).results.filter(item => item.status === 'succeeded').length, 2);
    await f.service.process(work, async () => 'bounded second batch');
    assert.equal((await f.results()).results.filter(item => item.status === 'succeeded').length, 3);
    await f.configure({ enabled: false }, 1);
    f.set({ profile: '500' });
    await f.configure({}, 2);
    f.set({
      history: { historyId: '501', history: [{ messagesAdded: [{ message: { id: 'mail4' } }] }] },
      matching: { messages: [{ id: 'mail1' }, { id: 'mail4' }] },
    });
    await f.service.poll(work);
    assert.equal(f.calls.at(-1).searchParams.get('startHistoryId'), '500');
    await f.service.poll(work);
    await f.service.process(work, async () => 'future progress');
    assert.equal((await f.results()).results.length, 4);
    assert.equal((await f.results()).results.find(item => item.messageId === 'mail4').answer, 'future progress');
  } finally {
    await f.close();
  }
});

for (const change of ['edit', 'remove', 'disconnect'])
  test(`${change} during model processing denies publication`, async () => {
    const f = await heartbeatFixture();
    try {
      await f.configure();
      const work = await f.work();
      await f.service.poll(work);
      await f.service.poll(work);
      const entered = Promise.withResolvers(),
        release = Promise.withResolvers();
      const process = f.service.process(work, async () => {
        entered.resolve();
        await release.promise;
        return 'stale answer';
      });
      await entered.promise;
      if (change === 'edit') await f.configure({ instructions: 'new procedure' }, 1);
      if (change === 'remove')
        await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
          f.member.membershipId,
        ]);
      if (change === 'disconnect') await f.googleCredentials.disconnect(f.workspace.id, f.member.userId);
      release.resolve();
      await process;
      assert.equal(
        (await f.db.platform.query(`SELECT answer FROM ${f.table('tf_google_heartbeat_items')}`)).rows[0].answer,
        null,
      );
    } finally {
      await f.close();
    }
  });

test('heartbeat storage login cannot access another workspace and foreign work cannot claim intake', async () => {
  const f = await heartbeatFixture();
  try {
    await f.configure();
    const work = await f.work();
    await f.service.poll(work);
    await f.service.poll(work);
    const other = await f.db.create(await workspaceTableMigrations());
    await assert.rejects(
      f.runtime.transaction(f.workspace.id, commonCompatibility, tx =>
        tx.client.query(`SELECT * FROM "${other.names.schema}".tf_google_heartbeat_items`),
      ),
      error => error.code === '42501',
    );
    await assert.rejects(f.service.results(other.id, f.member.userId));
    await f.service.process({ ...work, heartbeatId: randomUUID() }, async () => 'foreign work');
    await f.service.process(work, async () => 'owner result');
    assert.equal((await f.results()).results[0].answer, 'owner result');
  } finally {
    await f.close();
  }
});

for (const change of [
  'configuration',
  'disabled',
  'disconnect',
  'replacement',
  'generation',
  'removed',
  'rejoined',
  'admin',
  'workspace',
])
  test(`owner retry rejects ${change} and does not alter failed intake`, async () => {
    const f = await heartbeatFixture();
    try {
      await f.configure();
      const work = await f.work();
      await f.service.poll(work);
      await f.service.poll(work);
      await f.service.process(work, async () => {
        throw new Error('provider outcome uncertain');
      });
      const failed = (await f.results()).results[0];
      const command = { commandId: randomUUID(), itemId: failed.id, revision: 1 };
      let userId = f.member.userId,
        workspaceId = f.workspace.id;
      if (change === 'configuration') {
        await f.configure({ instructions: 'new' }, 1);
        command.revision = 2;
      }
      if (change === 'disabled') {
        await f.configure({ enabled: false }, 1);
        command.revision = 2;
      }
      if (change === 'disconnect') await f.googleCredentials.disconnect(workspaceId, userId);
      if (change === 'replacement' || change === 'generation') {
        if (change === 'replacement') f.behavior({ account: 'replacement-account' });
        await f.connect();
        await f.configure({}, 1);
        command.revision = 2;
      }
      if (change === 'removed' || change === 'rejoined') {
        await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
          f.member.membershipId,
        ]);
        if (change === 'rejoined')
          await f.db.platform.query(
            `INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`,
            [randomUUID(), userId],
          );
      }
      if (change === 'admin') {
        userId = f.admin.userId;
        await f.connect({ userId, sessionId: randomUUID() });
      }
      if (change === 'workspace') workspaceId = (await f.db.create(await workspaceTableMigrations())).id;
      await assert.rejects(f.service.retry(workspaceId, userId, command));
      const stored = (
        await f.db.platform.query(
          `SELECT status,instructions,attempts FROM ${f.table('tf_google_heartbeat_items')} WHERE id=$1`,
          [failed.id],
        )
      ).rows[0];
      assert.deepEqual(stored, { status: 'failed', instructions: failed.instructions, attempts: 1 });
    } finally {
      await f.close();
    }
  });
