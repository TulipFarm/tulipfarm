import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createSecretRequests, createSecrets } from '../dist/index.js';
import { heldSecrets } from '../dist/send.js';
import { code, denied, keyring, setup } from './fixture.mjs';

const chat = () => ({
  kind: 'chat',
  conversationId: randomUUID(),
  turnId: randomUUID(),
  conversationRequestId: randomUUID(),
});
const ask = (overrides = {}) => ({
  purpose: 'Read PostHog events',
  fields: [{ id: 'key', label: 'PostHog API key', kind: 'api-key', placement: { kind: 'bearer' } }],
  destinations: [{ kind: 'host', host: 'api.posthog.com' }],
  ...overrides,
});

test('secret requests', async t => {
  const f = await setup();
  t.after(() => f.close());
  const [ana, ben] = f.members;
  const ws = f.workspace.id;
  const settled = [];
  const requests = createSecretRequests(f.secrets, {
    settle: async (_tx, request, settlement, context) => {
      settled.push({ id: request.id, settlement, commandId: context.commandId ?? null });
    },
  });
  const create = (member, origin = chat(), request = ask(), extra = {}) =>
    f.runtime.transaction(ws, commonCompatibility, tx =>
      requests.create(tx, { membershipId: member.membershipId, origin, request, ...extra }),
    );
  const submit = (member, id, fields, extra = {}) =>
    requests.submit(ws, member, id, { requestId: randomUUID(), expectedRevision: 1, fields, ...extra });

  await t.test('rejects bad destinations, header names and placements before saving', async () => {
    await assert.rejects(
      create(ana, chat(), ask({ destinations: [{ kind: 'host', host: '127.0.0.1' }] })),
      code('destination-denied'),
    );
    await assert.rejects(
      create(
        ana,
        chat(),
        ask({ fields: [{ id: 'key', label: 'Key', kind: 'header', placement: { kind: 'header', name: 'Host' } }] }),
      ),
    );
    await assert.rejects(
      create(
        ana,
        chat(),
        ask({ fields: [{ id: 'k', label: 'Login', kind: 'username-password', placement: { kind: 'bearer' } }] }),
      ),
    );
    const count = await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_secret_requests')}`);
    assert.equal(count.rows[0].n, 0);
  });

  await t.test('shows the form only to the addressed member, with exact saved matches', async () => {
    const exact = await f.secrets.create(ws, ana, f.input({ name: 'Exact' }));
    await f.secrets.create(
      ws,
      ana,
      f.input({ name: 'Other host', destinations: [{ kind: 'host', host: 'eu.posthog.com' }] }),
    );
    await f.secrets.create(ws, ana, f.input({ name: 'Header', placement: { kind: 'header', name: 'x-api-key' } }));
    const other = chat();
    const elsewhere = await create(ana, other);
    const temporary = await submit(ana, elsewhere.secretRequestId, [
      { fieldId: 'key', value: { value: 'phx-temporary-value' }, lifetime: 'conversation' },
    ]);
    assert.equal(temporary.references.length, 1);

    const { secretRequestId } = await create(ana);
    await assert.rejects(requests.view(ws, ben, secretRequestId), denied);
    const view = await requests.view(ws, ana, secretRequestId);
    assert.equal(view.status, 'waiting');
    assert.deepEqual(view.destinations, [{ kind: 'host', value: 'api.posthog.com', plainHttp: false }]);
    // Another chat's temporary secret, another host and another placement are not offered (P8).
    assert.deepEqual(
      view.fields[0].options.map(option => option.name),
      ['Exact'],
    );
    await assert.rejects(submit(ben, secretRequestId, [{ fieldId: 'key', secretId: exact.id }]), denied);
  });

  await t.test('marks destinations the value may reach without encryption', async () => {
    const privateHosts = [
      { host: 'metrics', port: null, http: true },
      { host: 'billing', port: null, http: false },
    ];
    const listed = createSecretRequests(createSecrets({ runtime: f.runtime, keyring, enabled: true, privateHosts }));
    const destinations = [
      { kind: 'host', host: 'metrics' },
      { kind: 'endpoint', url: 'http://metrics/q' },
      { kind: 'host', host: 'billing' },
      { kind: 'endpoint', url: 'https://metrics/q' },
    ];
    const { secretRequestId } = await f.runtime.transaction(ws, commonCompatibility, tx =>
      listed.create(tx, { membershipId: ana.membershipId, origin: chat(), request: ask({ destinations }) }),
    );
    assert.deepEqual(
      (await listed.view(ws, ana, secretRequestId)).destinations.map(({ value, plainHttp }) => [value, plainHttp]),
      [
        ['http://metrics/q', true],
        ['https://metrics/q', false],
        ['billing', false],
        ['metrics', true],
      ],
    );
  });

  await t.test('needs a placement for a new value and records a member-chosen one', async () => {
    const { secretRequestId } = await create(
      ana,
      chat(),
      ask({ fields: [{ id: 'key', label: 'Key', kind: 'api-key' }] }),
    );
    assert.equal((await requests.view(ws, ana, secretRequestId)).fields[0].placement, null);
    await assert.rejects(
      submit(ana, secretRequestId, [{ fieldId: 'key', value: { value: 'phx-new-value' }, lifetime: 'saved' }]),
      code('placement-required'),
    );
    const result = await submit(ana, secretRequestId, [
      {
        fieldId: 'key',
        value: { value: 'phx-new-value' },
        lifetime: 'saved',
        placement: { kind: 'query', name: 'api_key' },
      },
    ]);
    const stored = await f.db.platform.query(
      `SELECT s.placement_source, s.variable_name FROM ${f.table('tf_secret_references')} r JOIN ${f.table('tf_secrets')} s ON s.id = r.secret_id WHERE r.id = $1`,
      [result.references[0].referenceId],
    );
    assert.deepEqual(stored.rows[0], { placement_source: 'member', variable_name: 'KEY' });
    assert.deepEqual(result.references[0].placement, { kind: 'query', name: 'api_key' });
  });

  await t.test('submits once, settles once and never stores the value outside the ciphertext', async () => {
    settled.length = 0;
    const origin = chat();
    const { secretRequestId } = await create(ana, origin);
    const input = {
      requestId: randomUUID(),
      expectedRevision: 1,
      fields: [{ fieldId: 'key', value: { value: 'phx-submitted-secret' }, lifetime: 'conversation' }],
    };
    const first = await requests.submit(ws, ana, secretRequestId, input);
    assert.deepEqual(await requests.submit(ws, ana, secretRequestId, input), first);
    await assert.rejects(submit(ana, secretRequestId, input.fields), code('conflict'));
    assert.equal(settled.length, 1);
    assert.equal(settled[0].settlement.status, 'provided');
    assert.equal(settled[0].commandId, input.requestId);
    assert.deepEqual(Object.keys(first.references[0]).sort(), [
      'destinations',
      'fieldId',
      'kind',
      'name',
      'placement',
      'referenceId',
    ]);
    const dump = await f.db.platform.query(
      `SELECT row_to_json(r)::text AS text FROM ${f.table('tf_secret_requests')} r UNION ALL
       SELECT row_to_json(c)::text FROM ${f.table('tf_secret_commands')} c UNION ALL
       SELECT row_to_json(x)::text FROM ${f.table('tf_secret_references')} x UNION ALL
       SELECT row_to_json(e)::text FROM ${f.table('tf_secret_events')} e`,
    );
    assert.ok(dump.rows.every(row => !row.text.includes('phx-submitted-secret')));
    const held = await f.runtime.transaction(ws, commonCompatibility, tx =>
      requests.references(tx, ana.membershipId, { kind: 'chat', conversationId: origin.conversationId }),
    );
    assert.deepEqual(
      held.map(reference => reference.referenceId),
      [first.references[0].referenceId],
    );
    assert.equal(held[0].status, 'active');
    assert.match(held[0].variableName, /^POSTHOG_API_KEY/);
  });

  await t.test('a held reference or variable name resolves only in its own chat and for its member', async () => {
    const origin = chat();
    const { secretRequestId } = await create(ana, origin);
    const { references } = await submit(ana, secretRequestId, [
      { fieldId: 'key', value: { value: 'phx-held-secret' }, lifetime: 'conversation' },
    ]);
    const holder = (member, conversationId = origin.conversationId) =>
      heldSecrets(f.secrets, requests, { workspaceId: ws, actor: member, origin: { kind: 'chat', conversationId } });
    const url = 'https://api.posthog.com/v1/events?code=1';
    const byReference = await holder(ana).resolve({ reference: references[0].referenceId }, url);
    assert.equal(byReference.value.value, 'phx-held-secret');
    assert.equal(byReference.name, references[0].name);
    const [{ variableName }] = await f.runtime.transaction(ws, commonCompatibility, tx =>
      requests.references(tx, ana.membershipId, { kind: 'chat', conversationId: origin.conversationId }),
    );
    const byVariable = await holder(ana).resolve({ variable: variableName.toLowerCase() }, url);
    assert.equal(byVariable.secretId, byReference.secretId);
    await assert.rejects(holder(ben).resolve({ reference: references[0].referenceId }, url), code('not-found'));
    await assert.rejects(
      holder(ana, randomUUID()).resolve({ reference: references[0].referenceId }, url),
      code('not-found'),
    );
    await assert.rejects(
      holder(ana).resolve({ reference: references[0].referenceId }, 'https://eu.posthog.com/'),
      code('destination-denied'),
    );
    await holder(ana).recordUse(byReference.secretId, url, 'api.request');
    const used = await f.db.platform.query(
      `SELECT details FROM ${f.table('tf_secret_events')} WHERE secret_id = $1 AND operation = 'used'`,
      [byReference.secretId],
    );
    assert.equal(used.rows[0].details.tool, 'api.request');
  });

  await t.test('declines with a reason', async () => {
    settled.length = 0;
    const { secretRequestId } = await create(ana);
    const result = await requests.decline(ws, ana, secretRequestId, {
      requestId: randomUUID(),
      expectedRevision: 1,
      reason: 'Use the staging key instead',
    });
    assert.deepEqual(result, { status: 'declined' });
    assert.deepEqual(settled[0].settlement, { status: 'declined', reason: 'Use the staging key instead' });
    assert.equal((await requests.view(ws, ana, secretRequestId)).declineReason, 'Use the staging key instead');
  });

  await t.test('expires late forms, and the sweep settles overdue requests', async () => {
    settled.length = 0;
    const late = await create(ana, chat(), ask(), { expiresAt: new Date(Date.now() - 1000) });
    await assert.rejects(
      submit(ana, late.secretRequestId, [{ fieldId: 'key', value: { value: 'phx-late' }, lifetime: 'saved' }]),
      code('expired'),
    );
    const view = await requests.view(ws, ana, late.secretRequestId);
    assert.equal(view.status, 'expired');
    const overdue = await create(ana, chat(), ask(), { expiresAt: new Date(Date.now() - 1000) });
    const swept = await requests.sweep(ws);
    assert.equal(swept.expiredRequests, 1);
    assert.deepEqual(
      settled.map(item => [item.id, item.settlement.status]),
      [
        [late.secretRequestId, 'expired'],
        [overdue.secretRequestId, 'expired'],
      ],
    );
  });

  await t.test('ending a chat cancels its requests and deletes its temporary secrets', async () => {
    const origin = chat();
    const provided = await create(ana, origin);
    const { references } = await submit(ana, provided.secretRequestId, [
      { fieldId: 'key', value: { value: 'phx-ends-with-chat' }, lifetime: 'conversation' },
    ]);
    const open = await create(ana, origin);
    const secretOrigin = { kind: 'chat', conversationId: origin.conversationId };
    const ended = await f.runtime.transaction(ws, commonCompatibility, tx => requests.endOrigin(tx, secretOrigin));
    assert.deepEqual(ended, { cancelled: 1, deleted: 1 });
    assert.equal((await requests.view(ws, ana, open.secretRequestId)).status, 'cancelled');
    const held = await f.runtime.transaction(ws, commonCompatibility, tx =>
      requests.references(tx, ana.membershipId, secretOrigin),
    );
    assert.deepEqual(held, []);
    assert.ok(references.length);
  });
});
