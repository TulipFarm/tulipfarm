import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callSlackApi, SlackApiError } from '../src/web-api.ts';

const call = (fetcher, extra = {}) =>
  callSlackApi({
    token: 'xoxp-person',
    method: 'conversations.members',
    params: { channel: 'CHR', limit: 1000, cursor: undefined },
    fetcher,
    ...extra,
  });
const code = expected => error => error instanceof SlackApiError && error.code === expected;

test('Slack Web API calls send the bearer token and form parameters and return the parsed success', async () => {
  let seen;
  const result = await call(async (url, init) => {
    seen = { url: String(url), init };
    return Response.json({ ok: true, members: ['UONE'] });
  });
  assert.deepEqual(result, { ok: true, members: ['UONE'] });
  assert.equal(seen.url, 'https://slack.com/api/conversations.members');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.redirect, 'error');
  assert.equal(new Headers(seen.init.headers).get('authorization'), 'Bearer xoxp-person');
  assert.equal(String(seen.init.body), 'channel=CHR&limit=1000');
});

test('Slack Web API failures map to retry, reconnect, access and uncertain outcomes', async () => {
  await assert.rejects(
    call(async () => new Response('', { status: 429, headers: { 'retry-after': '7' } })),
    error => code('rate-limited')(error) && error.retryAfterSeconds === 7,
  );
  await assert.rejects(
    call(async () => new Response('', { status: 429, headers: { 'retry-after': 'soon' } })),
    error => code('rate-limited')(error) && error.retryAfterSeconds === 60,
  );
  await assert.rejects(
    call(async () => Response.json({ ok: false, error: 'ratelimited' })),
    code('rate-limited'),
  );
  await assert.rejects(
    call(async () => new Response('', { status: 401 })),
    code('provider-auth-rejected'),
  );
  for (const error of ['invalid_auth', 'token_revoked', 'token_expired', 'account_inactive', 'not_authed'])
    await assert.rejects(
      call(async () => Response.json({ ok: false, error })),
      code('provider-auth-rejected'),
    );
  for (const error of ['not_in_channel', 'channel_not_found', 'missing_scope', 'is_archived'])
    await assert.rejects(
      call(async () => Response.json({ ok: false, error })),
      failure => failure.constructor.name === 'AccessDenied',
    );
  await assert.rejects(
    call(async () => Response.json({ ok: false, error: 'internal_error' })),
    code('provider-error'),
  );
  await assert.rejects(
    call(async () => {
      throw new TypeError('socket closed');
    }),
    code('provider-error'),
  );
  await assert.rejects(
    call(
      async () => {
        throw new TypeError('socket closed');
      },
      { effect: true },
    ),
    code('outcome-unknown'),
  );
  await assert.rejects(
    call(async () => new Response('not json')),
    code('provider-error'),
  );
  await assert.rejects(
    call(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)), { effect: true }),
    code('outcome-unknown'),
  );
});

test('declared idempotent Slack errors count as completed effects', async () => {
  assert.deepEqual(
    await call(async () => Response.json({ ok: false, error: 'already_reacted' }), {
      effect: true,
      completed: ['already_reacted'],
    }),
    { ok: true },
  );
  await assert.rejects(
    call(async () => Response.json({ ok: false, error: 'already_reacted' }), { effect: true }),
    code('provider-error'),
  );
});
