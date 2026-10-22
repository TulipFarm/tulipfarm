import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { Pool } from 'pg';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { tableQueryTranslationStatusSchema } from '@tulipfarm/tables/translation-contracts';
import {
  sweepTableQueryTranslations,
  tableQueryTranslationCompatibility,
} from '@tulipfarm/agents/table-query-translator';
import { createTableWithRows, tableDefinition, textField } from '../../../packages/tables/test/fixture.mjs';
import { createAuth } from '../src/auth.ts';
import { registerCredits } from '../src/credits.ts';
import { registerTableQueryTranslations } from '../src/table-query-translations.ts';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';

// These tests assert workspace balances, so they fund work from the credit account as a billing extension would.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

const modelEnv = {
  MODEL_FAMILIES: 'deepseek-flash',
  AZURE_FOUNDRY_ENDPOINT: 'https://synthetic.openai.azure.com/',
  AZURE_FOUNDRY_API_KEY: 'synthetic',
  TABLE_SEARCH_MODEL_FAMILY: 'deepseek-flash',
};
const option = label => ({ id: randomUUID(), label, retired: false });
const reply = (content, status = 200) =>
  Response.json(
    status === 200
      ? { choices: [{ message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 } }
      : { error: { message: 'provider failure' } },
    { status },
  );

test('table search translation routes keep receipts, billing and limits per logical request', async t => {
  const db = await fixture();
  let app, runtime, pool;
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await app?.close();
    await runtime?.close();
    await pool?.end();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const workspace = await db.create(await workspaceTableMigrations());
  pool = new Pool({ connectionString: db.connectionString, options: '-c search_path=app' });
  runtime = createWorkspaceRuntime({
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(workspace) }),
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
  });
  let link;
  const auth = createAuth(
    pool,
    async data => {
      link = data.url;
    },
    async () => {},
  );
  async function login() {
    await auth.api.signInMagicLink({
      headers: new Headers({ origin: 'http://localhost:5173' }),
      body: { email: `${randomUUID()}@example.com`, name: 'Searcher' },
    });
    const result = await auth.handler(new Request(link));
    const cookie = result.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ');
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    return { cookie, userId: session.user.id };
  }
  const member = await login(),
    second = await login(),
    outsider = await login();
  const s = `"${workspace.names.schema}"`,
    team = randomUUID(),
    memberMembership = randomUUID(),
    secondMembership = randomUUID();
  const ownerUserId = workspace.userId;

  await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Support')`, [team]);
  const customerName = textField('Name');
  const customers = tableDefinition({ owningTeamId: team, label: 'Customers', fields: [customerName] });
  const customerIds = ['Acme', 'Globex', 'acme'].map(() => randomUUID());
  await createTableWithRows({
    db,
    workspace,
    runtime,
    definition: customers,
    records: ['Acme', 'Globex', 'acme'].map((name, index) => ({
      id: customerIds[index],
      values: { [customerName.id]: { kind: 'text', value: name } },
    })),
  });
  const status = {
    id: randomUUID(),
    label: 'Status',
    kind: 'single-select',
    required: false,
    options: ['Open', 'Closed'].map(option),
  };
  const priority = {
    id: randomUUID(),
    label: 'Priority',
    kind: 'single-select',
    required: false,
    options: ['Low', 'High', 'Urgent'].map(option),
  };
  const subject = textField('Subject');
  const created = { id: randomUUID(), label: 'Created at', kind: 'timestamp', required: false, timezone: 'UTC' };
  const customer = {
    id: randomUUID(),
    label: 'Customer',
    kind: 'relationship',
    required: false,
    targetTableId: customers.id,
    cardinality: 'one',
    inverseCardinality: 'many',
    reverse: null,
    onDelete: 'restrict',
  };
  const tickets = tableDefinition({
    owningTeamId: team,
    label: 'Tickets',
    fields: [subject, status, priority, created, customer],
  });
  const table = await createTableWithRows({
    db,
    workspace,
    runtime,
    definition: tickets,
    records: [
      {
        values: {
          [subject.id]: { kind: 'text', value: 'SECRET-ROW-VALUE' },
          [status.id]: { kind: 'single-select', optionId: status.options[0].id },
        },
      },
    ],
  });

  // The searchers are members with read access through their team; the outsider has no access to the table.
  await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
    memberMembership,
    member.userId,
  ]);
  await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member'),($3,$4,'member')`, [
    secondMembership,
    second.userId,
    randomUUID(),
    outsider.userId,
  ]);
  await db.platform.query(`INSERT INTO ${s}.tf_member_teams(membership_id,team_id) VALUES($1,$3),($2,$3)`, [
    memberMembership,
    secondMembership,
    team,
  ]);
  await db.platform.query(
    `INSERT INTO ${s}.tf_grants(team_id,asset_id,permission) VALUES($1,$2,'table.row.read'),($1,$3,'table.row.read')`,
    [team, tickets.id, customers.id],
  );
  assert.notEqual(ownerUserId, member.userId);
  assert.notEqual(workspace.membershipId, memberMembership);

  const calls = [];
  let respond = () => reply('{"kind":"unsupported","message":"No"}');
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: String(init.body) });
    return respond();
  };

  app = Fastify();
  await app.register(swagger, { openapi: { info: { title: 'Table search', version: '1' } } });
  await app.register(
    async routes => {
      registerTableQueryTranslations(routes, { runtime, auth }, modelEnv);
      registerCredits(routes, { runtime, auth });
    },
    { prefix: '/v1' },
  );
  const fakeApp = Fastify();
  await fakeApp.register(
    async routes => registerTableQueryTranslations(routes, { runtime, auth }, { TABLE_SEARCH_TRANSLATOR: 'fake' }),
    { prefix: '/v1' },
  );
  t.after(() => fakeApp.close());
  await app.ready();
  await fakeApp.ready();
  assert.ok(app.swagger().paths['/v1/workspaces/{workspaceId}/tables/{tableId}/query/translate']);

  const base = `/v1/workspaces/${workspace.id}/tables/${tickets.id}/query`;
  const headers = { cookie: member.cookie, origin: 'http://localhost:5173' };
  const body = (prompt, extra = {}) => ({
    requestId: randomUUID(),
    revision: table.revision,
    prompt,
    timezone: 'Asia/Kolkata',
    ...extra,
  });
  const translate = (payload, as = headers, server = app) =>
    server.inject({ method: 'POST', url: `${base}/translate`, headers: as, payload });
  const statusOf = (requestId, as = headers) => app.inject({ url: `${base}/translations/${requestId}`, headers: as });
  const usage = async id =>
    (
      await db.platform.query(
        `SELECT flow_id, activity, reserved::text, charged::text, model_id FROM ${s}.tf_credit_usage WHERE id=$1`,
        [`table-search:${memberMembership}:${id}`],
      )
    ).rows[0];
  const receipt = async id =>
    (
      await db.platform.query(
        `SELECT state, billing, failure, billing_flow_id FROM ${s}.tf_table_query_translations WHERE request_id=$1`,
        [id],
      )
    ).rows[0];

  await t.test('a translated query is validated, interpreted, billed once and replayed without dispatch', async () => {
    respond = () =>
      reply(
        JSON.stringify({
          kind: 'query',
          where: {
            all: [
              { field: 'status', op: 'eq', values: ['Open'] },
              { field: 'priority', op: 'eq', values: ['Urgent'] },
            ],
          },
          sort: [{ field: 'created_at', direction: 'desc' }],
        }),
      );
    const payload = body('open urgent tickets, newest first');
    const first = await translate(payload);
    assert.equal(first.statusCode, 200, first.body);
    const result = tableQueryTranslationStatusSchema.parse(first.json());
    assert.equal(result.status, 'query');
    assert.deepEqual(result.query.where, {
      kind: 'all',
      nodes: [
        { kind: 'rule', fieldId: status.id, op: 'eq', values: [status.options[0].id] },
        { kind: 'rule', fieldId: priority.id, op: 'eq', values: [priority.options[2].id] },
      ],
    });
    assert.deepEqual(result.query.sort, [{ fieldId: created.id, direction: 'desc' }]);
    assert.equal(result.rsql, 'status==Open and priority==Urgent');
    assert.equal(result.interpretation, 'Status is Open and Priority is Urgent; sorted by Created at, newest first');
    assert.equal(calls.length, 1);
    assert.ok(
      !calls[0].body.includes('SECRET-ROW-VALUE') && !calls[0].body.includes(tickets.id),
      'rows and IDs never reach the model',
    );
    assert.ok(calls[0].body.includes('open urgent tickets'));

    assert.deepEqual((await translate(payload)).json(), first.json());
    assert.deepEqual((await statusOf(payload.requestId)).json(), first.json());
    assert.equal(calls.length, 1);
    const mismatch = await translate({ ...payload, prompt: 'closed tickets' });
    assert.equal(mismatch.statusCode, 409);
    assert.deepEqual(mismatch.json(), { error: 'request-mismatch' });

    const ledger = await usage(payload.requestId);
    assert.equal(ledger.activity, 'table-search');
    assert.equal(ledger.model_id, 'deepseek-v4-flash');
    assert.match(ledger.flow_id, new RegExp(`^table-search:${memberMembership}:\\d{4}-\\d{2}-\\d{2}$`));
    assert.ok(ledger.charged !== null && BigInt(ledger.charged) <= BigInt(ledger.reserved));
    assert.deepEqual(await receipt(payload.requestId), {
      state: 'completed',
      billing: 'settled',
      failure: null,
      billing_flow_id: ledger.flow_id,
    });
    assert.equal(
      (await db.platform.query(`SELECT count(*)::int AS n FROM ${s}.tf_credit_usage WHERE id LIKE 'table-search:%'`))
        .rows[0].n,
      1,
    );
  });

  await t.test('concurrent duplicates dispatch once and a second active translation is rate limited', async () => {
    let release;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    respond = async () => {
      await gate;
      return reply('{"kind":"unsupported","message":"Search cannot do that."}');
    };
    const payload = body('anything');
    const before = calls.length;
    const first = translate(payload);
    while (!(await receipt(payload.requestId))) await new Promise(resolve => setTimeout(resolve, 20));
    const duplicate = await translate(payload);
    assert.deepEqual(duplicate.json(), { requestId: payload.requestId, status: 'pending' });
    assert.deepEqual((await statusOf(payload.requestId)).json(), { requestId: payload.requestId, status: 'pending' });
    const other = await translate(body('another'));
    assert.equal(other.statusCode, 429);
    assert.deepEqual(other.json(), { error: 'rate-limited' });
    release();
    assert.deepEqual((await first).json(), {
      requestId: payload.requestId,
      status: 'unsupported',
      message: 'Search cannot do that.',
    });
    assert.equal(calls.length, before + 1);
  });

  await t.test('ambiguous linked names become authorized choices', async () => {
    respond = () => reply(JSON.stringify({ kind: 'query', where: { field: 'customer', op: 'in', values: ['Acme'] } }));
    const payload = body('tickets for Acme');
    const result = (await translate(payload)).json();
    assert.equal(result.status, 'clarification');
    assert.deepEqual(result.choices.map(choice => choice.label).sort(), ['Acme', 'acme']);
    for (const choice of result.choices)
      assert.match(choice.prompt, /^tickets for Acme \(Customer = record [0-9a-f-]{36}\)$/);
    respond = () =>
      reply(JSON.stringify({ kind: 'query', where: { field: 'customer', op: 'in', values: ['Globex'] } }));
    const globex = (await translate(body('tickets for Globex'))).json();
    assert.equal(globex.status, 'query');
    assert.deepEqual(globex.references, { [customerIds[1]]: 'Globex' });
    assert.equal(globex.interpretation, 'Customer is any of Globex');
  });

  await t.test('invalid model output is settled and reported as unsupported', async () => {
    respond = () => reply('status = open please');
    const payload = body('open ones');
    const result = await translate(payload);
    assert.equal(result.json().status, 'unsupported');
    assert.equal((await receipt(payload.requestId)).failure, 'invalid-output');
    assert.notEqual((await usage(payload.requestId)).charged, null);
  });

  await t.test(
    'provider errors release the hold; unknown outcomes stay uncertain and are never redispatched',
    async () => {
      respond = () => reply('', 500);
      const failed = body('provider error');
      const response = await translate(failed);
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: 'translation-unavailable' });
      assert.equal((await statusOf(failed.requestId)).json().status, 'failed');
      assert.equal((await usage(failed.requestId)).charged, '0');
      assert.equal((await receipt(failed.requestId)).billing, 'released');

      respond = () => {
        throw new TypeError('fetch failed');
      };
      const lost = body('network lost');
      assert.equal((await translate(lost)).statusCode, 503);
      const before = calls.length;
      assert.equal((await translate(lost)).json().status, 'uncertain');
      assert.equal((await statusOf(lost.requestId)).json().status, 'uncertain');
      assert.equal(calls.length, before);
      assert.equal((await usage(lost.requestId)).charged, null);
      assert.equal((await receipt(lost.requestId)).billing, 'held');
    },
  );

  await t.test(
    'stale revisions, missing credits, bad input and foreign readers are refused before dispatch',
    async () => {
      const before = calls.length;
      const stale = await translate(body('open', { revision: 'f'.repeat(40) }));
      assert.equal(stale.statusCode, 409);
      assert.deepEqual(stale.json(), { error: 'stale-revision' });
      assert.equal((await translate({ ...body('open'), timezone: 'Mars/Olympus' })).statusCode, 400);
      assert.equal((await translate({ ...body('x'.repeat(2001)) })).statusCode, 400);
      const outsiderHeaders = { cookie: outsider.cookie, origin: 'http://localhost:5173' };
      assert.deepEqual((await translate(body('open'), outsiderHeaders)).json(), { error: 'table-unavailable' });
      await db.platform.query(`UPDATE ${s}.tf_credit_account SET available=0`);
      const broke = body('open');
      const poor = await translate(broke);
      assert.equal(poor.statusCode, 402);
      assert.deepEqual(poor.json(), { error: 'insufficient-credits' });
      assert.equal(await receipt(broke.requestId), undefined);
      await db.platform.query(`UPDATE ${s}.tf_credit_account SET available=granted`);
      assert.equal(calls.length, before);
      assert.equal((await statusOf(randomUUID())).statusCode, 404);
      const known = (
        await db.platform.query(
          `SELECT request_id FROM ${s}.tf_table_query_translations WHERE membership_id=$1 LIMIT 1`,
          [memberMembership],
        )
      ).rows[0].request_id;
      assert.equal(
        (await statusOf(known, { cookie: second.cookie, origin: 'http://localhost:5173' })).statusCode,
        404,
        'receipts are owner scoped',
      );
    },
  );

  await t.test('members are limited to ten starts per minute', async () => {
    respond = () => reply('{"kind":"unsupported","message":"No"}');
    const started = Number(
      (
        await db.platform.query(`SELECT count(*) AS n FROM ${s}.tf_table_query_translations WHERE membership_id=$1`, [
          memberMembership,
        ])
      ).rows[0].n,
    );
    for (let index = started; index < 10; index++)
      assert.equal((await translate(body(`try ${index}`))).statusCode, 200);
    const limited = await translate(body('one more'));
    assert.equal(limited.statusCode, 429);
  });

  await t.test('personal credit usage shows table search under the member', async () => {
    const credits = await app.inject({ url: `/v1/workspaces/${workspace.id}/credits`, headers });
    assert.equal(credits.statusCode, 200, credits.body);
    const rows = credits.json().breakdown.filter(row => row.activity === 'table-search');
    assert.equal(rows.length, 1);
    assert.ok(rows[0].calls >= 5);
    const others = await app.inject({
      url: `/v1/workspaces/${workspace.id}/credits`,
      headers: { cookie: second.cookie, origin: 'http://localhost:5173' },
    });
    assert.equal(others.json().breakdown.filter(row => row.activity === 'table-search').length, 0);
  });

  await t.test('the fake translator runs the same receipt and validation pipeline', async () => {
    const as = { cookie: second.cookie, origin: 'http://localhost:5173' };
    const before = calls.length;
    const ambiguous = (await translate(body('tickets for Acme'), as, fakeApp)).json();
    assert.equal(ambiguous.status, 'clarification');
    const chosen = ambiguous.choices.find(choice => choice.label === 'acme');
    const resolved = (await translate(body(chosen.prompt), as, fakeApp)).json();
    assert.equal(resolved.status, 'query');
    assert.deepEqual(resolved.query.where, { kind: 'rule', fieldId: customer.id, op: 'in', values: [customerIds[2]] });
    const urgent = (await translate(body('open urgent tickets'), as, fakeApp)).json();
    assert.equal(urgent.rsql, 'status==Open and priority==Urgent');
    assert.equal((await translate(body('count by status'), as, fakeApp)).json().query.mode, 'summary');
    assert.equal((await translate(body('delete all tickets'), as, fakeApp)).json().status, 'unsupported');
    assert.equal(calls.length, before);
    const ledger = (
      await db.platform.query(
        `SELECT count(*)::int AS n, sum(charged)::text AS charged FROM ${s}.tf_credit_usage WHERE id LIKE $1`,
        [`table-search:${secondMembership}:%`],
      )
    ).rows[0];
    assert.deepEqual(ledger, { n: 5, charged: '0' });
  });

  await t.test('the sweep settles expired unknown holds at their reservation exactly once', async () => {
    await db.platform.query(`UPDATE ${s}.tf_table_query_translations SET created_at=created_at-interval '2 minutes'`);
    const sweep = () =>
      runtime.transaction(workspace.id, tableQueryTranslationCompatibility, sweepTableQueryTranslations);
    const available = async () =>
      BigInt((await db.platform.query(`SELECT available::text FROM ${s}.tf_credit_account`)).rows[0].available);
    const age = (...ids) =>
      db.platform.query(
        `UPDATE ${s}.tf_table_query_translations SET created_at=created_at-interval '25 hours' WHERE request_id=ANY($1::uuid[])`,
        [ids],
      );
    const credit = BigInt(1e12);

    respond = () => {
      throw new TypeError('fetch failed');
    };
    const lost = body('lost after dispatch'),
      abandoned = body('worker died'),
      recent = body('lost just now');
    for (const payload of [lost, abandoned, recent]) assert.equal((await translate(payload)).statusCode, 503);
    respond = () => reply('{"kind":"unsupported","message":"No"}');
    const settled = body('already settled');
    assert.equal((await translate(settled)).statusCode, 200);
    respond = () => reply('', 500);
    const released = body('released before crash');
    assert.equal((await translate(released)).statusCode, 503);
    // The ledger release committed but the receipt update did not.
    await db.platform.query(`UPDATE ${s}.tf_table_query_translations SET billing='held' WHERE request_id=$1`, [
      released.requestId,
    ]);
    await age(lost.requestId, abandoned.requestId, settled.requestId, released.requestId);
    // A process that dies mid-dispatch leaves the receipt dispatching with its hold.
    await db.platform.query(
      `UPDATE ${s}.tf_table_query_translations SET state='dispatching', failure=NULL WHERE request_id=$1`,
      [abandoned.requestId],
    );
    const settledBefore = await usage(settled.requestId);
    const before = await available();

    const first = await sweep();
    assert.equal(first.abandoned, 1);
    assert.equal(first.settled, 3);
    assert.equal(first.unresolvedHolds, 0);
    let refunded = 0n;
    for (const payload of [lost, abandoned]) {
      const ledger = await usage(payload.requestId);
      assert.ok(
        ledger.charged !== null &&
          BigInt(ledger.charged) <= BigInt(ledger.reserved) &&
          BigInt(ledger.charged) >= BigInt(ledger.reserved) - credit,
        'charged at the reservation, within aggregate rounding',
      );
      refunded += BigInt(ledger.reserved) - BigInt(ledger.charged);
      assert.deepEqual(await receipt(payload.requestId), {
        state: 'uncertain',
        billing: 'settled',
        failure: payload === lost ? 'provider-unknown' : null,
        billing_flow_id: ledger.flow_id,
      });
      assert.equal((await statusOf(payload.requestId)).json().status, 'uncertain');
    }
    assert.equal(await available(), before + refunded);
    assert.deepEqual(await usage(settled.requestId), settledBefore);
    assert.equal((await receipt(settled.requestId)).billing, 'settled');
    assert.equal((await usage(released.requestId)).charged, '0');
    assert.equal((await receipt(released.requestId)).billing, 'released');
    assert.equal((await receipt(recent.requestId)).billing, 'held');
    assert.equal((await usage(recent.requestId)).charged, null);

    const ledger = (await db.platform.query(`SELECT id, charged::text FROM ${s}.tf_credit_usage ORDER BY id`)).rows;
    const second = await sweep();
    assert.deepEqual(
      { settled: second.settled, unresolvedHolds: second.unresolvedHolds },
      { settled: 0, unresolvedHolds: 0 },
    );
    assert.deepEqual(
      (await db.platform.query(`SELECT id, charged::text FROM ${s}.tf_credit_usage ORDER BY id`)).rows,
      ledger,
    );
    assert.equal(await available(), before + refunded);
  });
});
