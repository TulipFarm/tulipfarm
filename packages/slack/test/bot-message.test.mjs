import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postBotMessage, setBotThreadStatus } from '../dist/index.js';

test('sets a native rotating thinking status for a Slack thread', async () => {
  let request;
  await setBotThreadStatus({
    token: 'xoxb-test',
    channel: 'C123',
    threadTs: '1700000000.000001',
    fetcher: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ ok: true }));
    },
  });
  assert.equal(request.url, 'https://slack.com/api/assistant.threads.setStatus');
  assert.equal(request.init.headers.Authorization, 'Bearer xoxb-test');
  assert.deepEqual(JSON.parse(request.init.body), {
    channel_id: 'C123',
    thread_ts: '1700000000.000001',
    status: 'is working on your request...',
    loading_messages: [
      'Reviewing the request...',
      'Checking the relevant context...',
      'Working through the details...',
      'Preparing a useful answer...',
    ],
  });
});

test('includes an optional agent identity without changing default bot messages', async () => {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, channel: 'C123', ts: '1700000000.000001' }));
  };

  await postBotMessage({ token: 'xoxb-test', channel: 'C123', text: 'An answer', agentName: 'HR', fetcher });
  await postBotMessage({ token: 'xoxb-test', channel: 'C123', text: 'A default answer', fetcher });

  assert.deepEqual(requests[0].body.blocks[0], {
    type: 'context',
    elements: [{ type: 'plain_text', text: 'HR' }],
  });
  assert.equal(requests[0].body.text, 'An answer');
  assert.equal(requests[1].body.blocks[0].type, 'rich_text');
  assert.equal(requests[1].body.text, 'A default answer');
  for (const { body } of requests) {
    assert.equal('username' in body, false);
    assert.equal('icon_url' in body, false);
    assert.equal('icon_emoji' in body, false);
  }
});

test('customizes named-agent channel replies without changing the app avatar', async () => {
  for (const channel of ['C123', 'G123']) {
    let body;
    const result = await postBotMessage({
      token: 'xoxb-test',
      channel,
      rootTs: '1700000000.000001',
      text: 'An answer',
      agentName: 'HR Help',
      customizeName: true,
      fetcher: async (url, init) => {
        assert.equal(url, 'https://slack.com/api/chat.postMessage');
        body = JSON.parse(init.body);
        return Response.json({ ok: true, channel, ts: '1700000000.000002' });
      },
    });
    assert.equal(result.kind, 'sent');
    assert.equal(body.username, 'HR Help \u00b7 TulipFarm');
    assert.equal(body.thread_ts, '1700000000.000001');
    assert.equal(body.text, 'An answer');
    assert.equal(body.blocks[0].type, 'rich_text');
    assert.equal('icon_url' in body, false);
    assert.equal('icon_emoji' in body, false);
  }
});

test('does not customize default replies, DMs, or message updates', async () => {
  for (const extra of [
    {},
    { channel: 'D123', agentName: 'HR Help' },
    { agentName: 'HR Help', replaceTs: '1700000000.000001' },
    { agentName: 'HR Help', customizeName: false },
  ]) {
    let body;
    await postBotMessage({
      token: 'xoxb-test',
      channel: 'C123',
      text: 'An answer',
      customizeName: true,
      ...extra,
      fetcher: async (url, init) => {
        assert.equal(url, `https://slack.com/api/${extra.replaceTs ? 'chat.update' : 'chat.postMessage'}`);
        body = JSON.parse(init.body);
        return Response.json({ ok: true, channel: body.channel, ts: '1700000000.000001' });
      },
    });
    assert.equal('username' in body, false);
    assert.equal('icon_url' in body, false);
    assert.equal('icon_emoji' in body, false);
    assert.equal(body.blocks[0].type, extra.agentName ? 'context' : 'rich_text');
  }
});

test('retains customized-send retry and uncertain-delivery behavior without resending', async () => {
  for (const [response, expected] of [
    [new Response(null, { status: 429, headers: { 'retry-after': '5' } }), { kind: 'retry', seconds: 5 }],
    [Response.json({ ok: false, error: 'missing_scope' }), { kind: 'blocked' }],
    [new Response(null, { status: 503 }), { kind: 'unknown' }],
  ]) {
    let calls = 0;
    const result = await postBotMessage({
      token: 'xoxb-test',
      channel: 'C123',
      text: 'An answer',
      agentName: 'HR Help',
      customizeName: true,
      fetcher: async () => {
        calls++;
        return response;
      },
    });
    assert.deepEqual(result, expected);
    assert.equal(calls, 1);
  }
});
