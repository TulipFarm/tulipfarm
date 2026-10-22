import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createSlackInbox, createSlackLinkPrompts, slackCredentialCipher } from '../src/index.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

export async function promptFixture(extend) {
  const f = await conversationFixture(extend);
  const installationId = randomUUID();
  const cipher = slackCredentialCipher({ activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } });
  const credential = cipher.encrypt(
    { workspaceId: f.workspace.id, installationId, generation: 1, kind: 'bot' },
    'synthetic-bot-token',
  );
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_slack_installations')} (id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after) VALUES ($1,'ATEST','TONE','UBOT',1,'active',ARRAY['chat:write'],$2,0)`,
    [installationId, credential],
  );
  if (
    (
      await f.db.platform.query('SELECT to_regclass($1) IS NOT NULL AS installed', [
        f.table('tf_slack_installation_grants'),
      ])
    ).rows[0].installed
  )
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_slack_installation_grants')} (installation_id,membership_id) SELECT $1,id FROM ${f.table('tf_memberships')}`,
      [installationId],
    );
  const requests = [];
  let response = 'success';
  const server = createServer(async (request, reply) => {
    let body = '';
    for await (const part of request) body += part;
    requests.push({
      method: request.url.slice(1),
      authorization: request.headers.authorization,
      body: JSON.parse(body),
    });
    if (response === 'lost') {
      request.socket.destroy();
      return;
    }
    if (response === 'retry') {
      reply.writeHead(429, { 'Retry-After': '2' });
      reply.end('{}');
      return;
    }
    if (response === 'denied') {
      reply.end(JSON.stringify({ ok: false, error: 'channel_not_found' }));
      return;
    }
    reply.end(
      JSON.stringify(
        request.url === '/chat.postEphemeral'
          ? { ok: true, message_ts: '1234.000001' }
          : { ok: true, channel: JSON.parse(body).channel, ts: '1234.000001' },
      ),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const nativeFetch = fetch;
  const fetcher = (url, init) =>
    nativeFetch(`http://127.0.0.1:${server.address().port}/${new URL(url).pathname.split('/').at(-1)}`, init);
  const options = { runtime: f.runtime, appId: 'ATEST', webOrigin: 'https://app.example.test', cipher, fetcher };
  const prompts = createSlackLinkPrompts(options);
  const inbox = createSlackInbox(f.runtime);
  let sequence = 0;
  async function event(user = 'UPERSON', channel = 'DONE', extra = {}) {
    const id = `event-${++sequence}`;
    const payload = {
      type: 'event_callback',
      api_app_id: 'ATEST',
      team_id: 'TONE',
      event_id: id,
      event_time: 123,
      event: { type: 'message', user, channel, ts: `${sequence}.000001`, text: 'PRIVATE ORIGINAL REQUEST', ...extra },
    };
    await inbox.accept({ workspaceId: f.workspace.id, installationId, generation: 1 }, payload);
    return (await f.db.platform.query(`SELECT id FROM ${f.table('tf_slack_events')} WHERE event_id=$1`, [id])).rows[0]
      .id;
  }
  return {
    ...f,
    installationId,
    options,
    prompts,
    requests,
    event,
    setResponse: value => {
      response = value;
    },
    async close() {
      await new Promise(resolve => server.close(resolve));
      await f.close();
    },
  };
}

test('held DM discovery claims one safe link across concurrent deliveries and fresh runtime restart', async () => {
  const f = await promptFixture();
  let restarted;
  try {
    const first = await f.event();
    await f.event('UOTHER', 'CCHANNEL');
    await f.event('UBOT');
    const [a, b] = await Promise.all([f.prompts.discover(f.workspace.id), f.prompts.discover(f.workspace.id)]);
    assert.deepEqual(a, [{ workspaceId: f.workspace.id, eventId: first }]);
    assert.deepEqual(b, a);
    assert.deepEqual((await Promise.all([f.prompts.process(a[0]), f.prompts.process(b[0])])).sort(), ['idle', 'sent']);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].authorization, 'Bearer synthetic-bot-token');
    const body = f.requests[0].body;
    assert.equal(body.channel, 'DONE');
    assert.equal(body.blocks[0].type, 'rich_text');
    assert.equal(
      body.blocks[0].elements[0].elements[0].url,
      `https://app.example.test/slack/link?workspaceId=${f.workspace.id}&eventId=${first}`,
    );
    assert.equal(body.unfurl_links, false);
    assert.equal(body.unfurl_media, false);
    assert.equal(body.mrkdwn, false);
    assert.equal(body.parse, 'none');
    assert.equal(JSON.stringify(body).includes('PRIVATE ORIGINAL REQUEST'), false);
    assert.deepEqual(
      (
        await f.db.platform.query(
          `SELECT state,delivered_channel,delivered_ts FROM ${f.table('tf_slack_link_prompts')}`,
        )
      ).rows,
      [{ state: 'sent', delivered_channel: 'DONE', delivered_ts: '1234.000001' }],
    );
    restarted = f.createRuntime();
    const prompts = createSlackLinkPrompts({ ...f.options, runtime: restarted });
    assert.deepEqual(await prompts.discover(f.workspace.id), []);
    assert.equal(await prompts.process(a[0]), 'idle');
    assert.equal(f.requests.length, 1);
    await assert.rejects(
      restarted.transaction(f.workspace.id, commonCompatibility, tx =>
        tx.client.query(`DELETE FROM ${f.table('tf_slack_link_prompts')}`),
      ),
      error => error.code === '42501',
    );
  } finally {
    await restarted?.close();
    await f.close();
  }
});

test('429 retries wait durably and recheck generation; lost acknowledgements never blindly resend', async () => {
  const f = await promptFixture();
  try {
    await f.event();
    const [work] = await f.prompts.discover(f.workspace.id);
    f.setResponse('retry');
    assert.equal(await f.prompts.process(work), 'retry');
    assert.deepEqual(await f.prompts.discover(f.workspace.id), []);
    assert.equal(await f.prompts.process(work), 'idle');
    assert.equal(f.requests.length, 1);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_slack_link_prompts')} SET next_attempt_at=clock_timestamp()-interval '1 second'`,
    );
    f.setResponse('success');
    assert.equal(await f.prompts.process(work), 'sent');
    assert.equal(f.requests.length, 2);
    await f.event('ULOST', 'DLOST');
    const [lost] = await f.prompts.discover(f.workspace.id);
    f.setResponse('lost');
    assert.equal(await f.prompts.process(lost), 'unknown');
    assert.equal(await f.prompts.process(lost), 'idle');
    assert.equal(f.requests.length, 3);
    await f.event('UREVOKE', 'DREVOKE');
    const [revoked] = await f.prompts.discover(f.workspace.id);
    f.setResponse('retry');
    assert.equal(await f.prompts.process(revoked), 'retry');
    await f.db.platform.query(
      `UPDATE ${f.table('tf_slack_installations')} SET generation=2,state='revoked',bot_credential=NULL`,
    );
    await f.db.platform.query(
      `UPDATE ${f.table('tf_slack_link_prompts')} SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE event_id=$1`,
      [revoked.eventId],
    );
    assert.equal(await f.prompts.process(revoked), 'blocked');
    assert.equal(f.requests.length, 4);
  } finally {
    await f.close();
  }
});

test('channel prompts target the sender in the existing thread and ignore unrelated or bot messages', async () => {
  const f = await promptFixture();
  try {
    await f.event('UPERSON', 'CCHANNEL');
    await f.event('UPERSON', 'CCHANNEL', { text: '<@UOTHER> unrelated' });
    await f.event('UBOT', 'CCHANNEL', { type: 'app_mention' });
    await f.event('UPERSON', 'CCHANNEL', { type: 'app_mention', bot_id: 'BOTHER' });
    await f.event('UPERSON', 'CCHANNEL', { type: 'app_mention', subtype: 'bot_message' });
    assert.deepEqual(await f.prompts.discover(f.workspace.id), []);
    const eventId = await f.event('UPERSON', 'GCHANNEL', { text: '<@UBOT> hello', thread_ts: '123.000001' });
    const [work] = await f.prompts.discover(f.workspace.id);
    assert.equal(work.eventId, eventId);
    assert.equal(await f.prompts.process(work), 'sent');
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].method, 'chat.postEphemeral');
    assert.equal(f.requests[0].body.channel, 'GCHANNEL');
    assert.equal(f.requests[0].body.user, 'UPERSON');
    assert.equal(f.requests[0].body.thread_ts, '123.000001');
    assert.deepEqual(
      (
        await f.db.platform.query(
          `SELECT state,delivered_channel,delivered_ts FROM ${f.table('tf_slack_link_prompts')}`,
        )
      ).rows,
      [{ state: 'sent', delivered_channel: 'GCHANNEL', delivered_ts: '1234.000001' }],
    );
    await f.event('UPERSON', 'GCHANNEL', { type: 'app_mention' });
    const [next] = await f.prompts.discover(f.workspace.id);
    assert.equal(await f.prompts.process(next), 'sent');
    assert.equal(f.requests.length, 2);
  } finally {
    await f.close();
  }
});

test('ephemeral prompt retries remain private and unknown or denied delivery never falls back', async () => {
  const f = await promptFixture();
  try {
    await f.event('UPERSON', 'CCHANNEL', { type: 'app_mention' });
    const [work] = await f.prompts.discover(f.workspace.id);
    f.setResponse('retry');
    assert.equal(await f.prompts.process(work), 'retry');
    assert.equal(await f.prompts.process(work), 'idle');
    await f.db.platform.query(
      `UPDATE ${f.table('tf_slack_link_prompts')} SET next_attempt_at=clock_timestamp()-interval '1 second'`,
    );
    f.setResponse('lost');
    assert.equal(await f.prompts.process(work), 'unknown');
    assert.equal(await f.prompts.process(work), 'idle');
    await f.event('UPERSON', 'CCHANNEL', { type: 'app_mention' });
    const [next] = await f.prompts.discover(f.workspace.id);
    f.setResponse('denied');
    assert.equal(await f.prompts.process(next), 'blocked');
    assert.equal(await f.prompts.process(next), 'idle');
    assert.equal(f.requests.length, 3);
    assert.ok(
      f.requests.every(
        request =>
          request.method === 'chat.postEphemeral' &&
          request.body.channel === 'CCHANNEL' &&
          request.body.user === 'UPERSON',
      ),
    );
  } finally {
    await f.close();
  }
});

test('a committed send claim survives crash without a duplicate; incomplete consent still gets a prompt', async () => {
  const f = await promptFixture();
  try {
    await f.event();
    const [work] = await f.prompts.discover(f.workspace.id);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_slack_link_prompts')} SET state='sending',attempt_id=$1,next_attempt_at=clock_timestamp()-interval '1 second'`,
      [randomUUID()],
    );
    assert.equal(await f.prompts.process(work), 'idle');
    assert.deepEqual((await f.db.platform.query(`SELECT state FROM ${f.table('tf_slack_link_prompts')}`)).rows, [
      { state: 'unknown' },
    ]);
    await f.event('ULINKED', 'DLINKED');
    const [linked] = await f.prompts.discover(f.workspace.id);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_slack_identities')} (id,installation_id,generation,slack_user_id,user_id,membership_id,state) VALUES ($1,$2,1,'ULINKED',$3,$4,'consent-required')`,
      [randomUUID(), f.installationId, f.workspace.userId, f.workspace.membershipId],
    );
    assert.equal(await f.prompts.process(linked), 'sent');
    assert.equal(f.requests.length, 1);
    await f.event('UDENIED', 'DDENIED');
    const [denied] = await f.prompts.discover(f.workspace.id);
    f.setResponse('denied');
    assert.equal(await f.prompts.process(denied), 'blocked');
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].body.channel, 'DDENIED');
  } finally {
    await f.close();
  }
});

test('each new unconnected message gets its own link without replaying completed or uncertain sends', async () => {
  const f = await promptFixture();
  try {
    const first = await f.event();
    const [work] = await f.prompts.discover(f.workspace.id);
    assert.equal(await f.prompts.process(work), 'sent');
    const second = await f.event();
    const [a, b] = await Promise.all([f.prompts.discover(f.workspace.id), f.prompts.discover(f.workspace.id)]);
    assert.deepEqual(a, [{ workspaceId: f.workspace.id, eventId: second }]);
    assert.deepEqual(b, a);
    assert.deepEqual((await Promise.all([f.prompts.process(a[0]), f.prompts.process(b[0])])).sort(), ['idle', 'sent']);
    assert.equal(await f.prompts.process(work), 'idle');
    assert.deepEqual(
      f.requests.map(request =>
        new URL(request.body.blocks[0].elements[0].elements[0].url).searchParams.get('eventId'),
      ),
      [first, second],
    );
    const third = await f.event();
    const [lost] = await f.prompts.discover(f.workspace.id);
    f.setResponse('lost');
    assert.equal(await f.prompts.process(lost), 'unknown');
    const fourth = await f.event();
    f.setResponse('success');
    const [next] = await f.prompts.discover(f.workspace.id);
    assert.equal(next.eventId, fourth);
    assert.equal(await f.prompts.process(next), 'sent');
    assert.equal(await f.prompts.process({ workspaceId: f.workspace.id, eventId: third }), 'idle');
    assert.equal(f.requests.length, 4);
    assert.deepEqual(await f.prompts.discover(f.workspace.id), []);
  } finally {
    await f.close();
  }
});

test('completed consent suppresses queued prompts but reconnect-required credentials get a new link', async () => {
  const f = await promptFixture();
  try {
    const eventId = await f.event();
    const [work] = await f.prompts.discover(f.workspace.id);
    const identityId = randomUUID();
    const credential = f.options.cipher.encrypt(
      {
        workspaceId: f.workspace.id,
        installationId: f.installationId,
        generation: 1,
        kind: 'user',
        identityId,
        membershipId: f.workspace.membershipId,
        slackUserId: 'UPERSON',
      },
      'xoxp-synthetic',
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_slack_identities')} (id,installation_id,generation,slack_user_id,user_id,membership_id,state,credential) VALUES ($1,$2,1,'UPERSON',$3,$4,'authorized',$5)`,
      [identityId, f.installationId, f.workspace.userId, f.workspace.membershipId, credential],
    );
    assert.equal(await f.prompts.process(work), 'linked');
    assert.equal(f.requests.length, 0);
    await f.db.platform.query(`UPDATE ${f.table('tf_slack_identities')} SET credential=$1`, [
      { ...credential, rotation: { state: 'reconnect-required' } },
    ]);
    const nextId = await f.event();
    const [next] = await f.prompts.discover(f.workspace.id);
    assert.equal(next.eventId, nextId);
    assert.notEqual(nextId, eventId);
    assert.equal(await f.prompts.process(next), 'sent');
    assert.equal(f.requests.length, 1);
  } finally {
    await f.close();
  }
});

test('provider acceptance followed by SQL outcome failure retains the committed claim and never resends', async () => {
  const f = await promptFixture();
  try {
    await f.event();
    const [work] = await f.prompts.discover(f.workspace.id);
    const runtime = {
      transaction: (workspace, range, action) =>
        f.runtime.transaction(workspace, range, tx =>
          action({
            ...tx,
            client: {
              query: async (sql, values) => {
                if (sql.includes('SET state=$2,next_attempt_at=')) throw new Error('simulated outcome commit failure');
                return tx.client.query(sql, values);
              },
            },
          }),
        ),
    };
    await assert.rejects(
      createSlackLinkPrompts({ ...f.options, runtime }).process(work),
      /simulated outcome commit failure/,
    );
    assert.equal(f.requests.length, 1);
    assert.deepEqual((await f.db.platform.query(`SELECT state FROM ${f.table('tf_slack_link_prompts')}`)).rows, [
      { state: 'sending' },
    ]);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_slack_link_prompts')} SET next_attempt_at=clock_timestamp()-interval '1 second'`,
    );
    assert.equal(await f.prompts.process(work), 'idle');
    assert.equal(f.requests.length, 1);
    assert.deepEqual((await f.db.platform.query(`SELECT state FROM ${f.table('tf_slack_link_prompts')}`)).rows, [
      { state: 'unknown' },
    ]);
  } finally {
    await f.close();
  }
});
