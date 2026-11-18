import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { modelUsageReport, recordModelUsage, usageConnections } from '../../src/model-usage.ts';
import { qualified } from '../../src/provisioning.ts';
import { connect, fixture } from './fixture.mjs';

const pico = 1_000_000_000_000n;
const day = 24 * 60 * 60_000;
const now = Date.now();
const range = { from: new Date(now - 30 * day).toISOString(), to: new Date(now + day).toISOString() };

function call(overrides) {
  return {
    id: `chat:${randomUUID()}`,
    activity: 'chat',
    flowId: randomUUID(),
    membershipId: null,
    agentId: null,
    modelId: 'gpt-6-sol',
    modelProvider: 'azure',
    paidBy: 'credits',
    connectionId: null,
    inputTokens: 100,
    outputTokens: 10,
    cachedTokens: 0,
    listPicoUsd: pico.toString(),
    pricingRevision: 'prices-test',
    fallback: null,
    ...overrides,
  };
}

/** Runs `work` as the workspace's runtime role, at `commonVersion`, and rolls back. */
async function asRuntime(db, workspace, commonVersion, work) {
  const client = await connect(db.login(workspace));
  try {
    await client.query('BEGIN');
    return await work({ client, schema: workspace.names.schema, commonVersion });
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
}

const byKeys = report => Object.fromEntries(report.rows.map(row => [row.keys.join(' > '), row]));

test(
  'the usage report groups, filters, merges model ids and scopes rows to the viewer',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    try {
      const workspace = await db.create();
      const at = name => qualified(workspace.names.schema, name);
      const admin = workspace.membershipId;
      const [mia, tom] = [randomUUID(), randomUUID()];
      await db.platform.query(
        `INSERT INTO ${at('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member'),($3,$4,'member')`,
        [mia, randomUUID(), tom, randomUUID()],
      );
      const [adminPlan, miaPlan, tomPlan] = [randomUUID(), randomUUID(), randomUUID()];
      await db.platform.query(
        `INSERT INTO ${at('tf_subscription_connections')} (id,provider,owner_membership_id,state,client_id,subject,plan,credential,expires_at,usage_limited_at)
      VALUES ($1,'chatgpt',$4,'plan-disabled','test-client','a','plus','{}',now()+interval '1 day',NULL),
             ($2,'copilot',$5,'plan-disabled',NULL,'m','pro','{}',now()+interval '1 day',NULL),
             ($3,'claude',$6,'plan-disabled',NULL,'t','max','{}',now()+interval '1 day',now())`,
        [adminPlan, miaPlan, tomPlan, admin, mia, tom],
      );
      const agent = randomUUID();
      const records = [
        // Two credit calls billed in the ledger, one by the admin and one by Mia.
        call({ membershipId: admin }),
        call({ membershipId: mia, modelId: 'grok-4-6', modelProvider: 'xai' }),
        // The admin's plan answered the same model, under its plan family id, after Tom's plan hit its limit.
        call({
          membershipId: admin,
          modelId: 'chatgpt-gpt-6-sol',
          modelProvider: 'chatgpt',
          paidBy: 'plan',
          connectionId: adminPlan,
          fallback: { reason: 'quota', fromModel: 'gpt-6-sol', fromConnection: tomPlan },
        }),
        call({ membershipId: mia, paidBy: 'plan', modelProvider: 'copilot', connectionId: miaPlan }),
        call({ membershipId: tom, paidBy: 'plan', modelProvider: 'claude', connectionId: tomPlan, agentId: agent }),
        // An API key call served on another route of the same model, by Tom's agent.
        call({
          membershipId: tom,
          modelId: 'gpt-6-sol-openai',
          modelProvider: 'openai',
          paidBy: 'key',
          agentId: agent,
        }),
      ];
      const credited = records.filter(record => record.paidBy === 'credits');
      await asRuntime(db, workspace, 87, async tx => {
        await recordModelUsage(tx, records);
        for (const record of credited)
          await tx.client.query(
            `INSERT INTO ${at('tf_credit_usage')} (id,flow_id,model_id,activity,reserved,charged,provider_pico_usd,pricing_revision)
          VALUES ($1,$2,$3,'chat',$4,$4,$5,'prices-test')`,
            [record.id, record.flowId, record.modelId, (100n * pico).toString(), pico.toString()],
          );
        // A credit call from before usage was recorded, with only its ledger row, and one outside the range.
        await tx.client.query(
          `INSERT INTO ${at('tf_credit_usage')} (id,flow_id,model_id,activity,reserved,charged,provider_pico_usd,pricing_revision,created_at)
        VALUES ('old-in-range',$1,'gpt-6-sol','agent',$2,$2,$3,'p',now()-interval '2 days'),
               ('old-out-of-range',$1,'gpt-6-sol','agent',$2,$2,$3,'p',now()-interval '40 days')`,
          [randomUUID(), (50n * pico).toString(), pico.toString()],
        );
        // Recording the same call again, as a retried settlement does, writes it once.
        await recordModelUsage(tx, [records[0]]);

        const canonical = id => (/^(chatgpt-)?gpt-6-sol(-openai)?$/.test(id) ? 'gpt-sol' : id);
        const report = (query, viewer, merge = canonical) =>
          modelUsageReport(tx, { timeZone: 'UTC', filters: {}, ...range, ...query }, viewer, merge);
        const asAdmin = { membershipId: admin, admin: true };
        const asMia = { membershipId: mia, admin: false };

        const models = byKeys(await report({ group: ['model', 'paidBy'] }, asAdmin));
        assert.deepEqual(
          Object.fromEntries(Object.entries(models).map(([key, row]) => [key, row.requests])),
          { 'gpt-sol > credits': 2, 'gpt-sol > plan': 3, 'gpt-sol > key': 1, 'grok-4-6 > credits': 1 },
          'plan and route ids of one model group under its canonical id; the ledger-only call counts as credits',
        );
        assert.equal(models['gpt-sol > credits'].credits, 150, 'credits charged come from the ledger');
        assert.equal(models['gpt-sol > key'].billedUsd, 1, 'API key calls are valued at their list price');
        assert.equal(models['gpt-sol > plan'].planValueUsd, 3, 'plan calls count as plan value, not billing');
        assert.equal(models['gpt-sol > plan'].credits, 0);
        assert.equal(models['gpt-sol > plan'].fallbacks, 1);

        const unmerged = byKeys(await report({ group: ['model'] }, asAdmin, id => id));
        assert.ok(
          unmerged['chatgpt-gpt-6-sol'] && unmerged['gpt-6-sol-openai'],
          'without a canonical id they stay apart',
        );

        const filtered = await report({ group: ['paidBy'], filters: { model: ['gpt-sol'], member: [tom] } }, asAdmin);
        assert.deepEqual(
          filtered.rows.map(row => [row.keys[0], row.requests]).sort(),
          [
            ['key', 1],
            ['plan', 1],
          ],
          'filters on the canonical model and a member keep only matching calls',
        );

        const narrow = await report(
          { group: ['model'], from: new Date(now - 3 * day).toISOString(), to: new Date(now - day).toISOString() },
          asAdmin,
        );
        assert.deepEqual(
          narrow.rows.map(row => [row.keys[0], row.requests]),
          [['gpt-sol', 1]],
          'the range keeps only calls inside it',
        );

        const fallback = byKeys(await report({ group: ['fallback'] }, asAdmin));
        assert.equal(
          fallback[`quota|${tomPlan}`]?.requests,
          1,
          'the admin sees why and from which plan a call fell back',
        );
        assert.equal((await usageConnections(tx, [tomPlan])).at(0)?.usage_limited_at instanceof Date, true);

        const members = byKeys(await report({ group: ['member', 'paidBy'] }, asMia));
        assert.deepEqual(
          Object.keys(members).sort(),
          [`${mia} > credits`, `${mia} > plan`, 'others > credits', 'others > key', 'workspace > credits'],
          'a member sees their own calls, others merged, and no other member’s plan calls',
        );
        const miaRows = await report({ group: ['connection', 'fallback'] }, asMia);
        const connections = new Set(miaRows.rows.map(row => row.keys[0]));
        assert.ok(connections.has(miaPlan));
        assert.ok(!connections.has(adminPlan) && !connections.has(tomPlan), 'other members’ plans stay hidden');
        assert.ok(
          miaRows.rows.every(row => row.keys[1] === 'none' && row.fallbacks === 0),
          'other members’ fallbacks stay hidden',
        );
        const agents = (await report({ group: ['agent'] }, asMia)).options.agent.map(option => option.value);
        assert.deepEqual(agents, ['none'], 'other members’ agents stay hidden');
        const options = (await report({ group: ['member'] }, asMia)).options.connection.map(option => option.value);
        assert.ok(!options.includes(adminPlan) && !options.includes(tomPlan), 'filter options hide them too');
      });
    } finally {
      await db.close();
    }
  },
);

test(
  'a workspace before the usage migration records nothing and still reports its credits',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    try {
      const workspace = await db.create(db.baseline.filter(migration => migration.name < '0087'));
      const at = name => qualified(workspace.names.schema, name);
      await asRuntime(db, workspace, 86, async tx => {
        await recordModelUsage(tx, [call({ membershipId: workspace.membershipId })]);
        await tx.client.query(
          `INSERT INTO ${at('tf_credit_usage')} (id,flow_id,model_id,activity,reserved,charged,provider_pico_usd,pricing_revision)
        VALUES ('legacy',$1,'gpt-6-sol','chat',$2,$2,$3,'p')`,
          [randomUUID(), (10n * pico).toString(), pico.toString()],
        );
        const report = await modelUsageReport(
          tx,
          { ...range, group: ['paidBy'], filters: {}, timeZone: 'UTC' },
          { membershipId: workspace.membershipId, admin: true },
        );
        assert.deepEqual(
          report.rows.map(row => [row.keys[0], row.requests, row.credits]),
          [['credits', 1, 10]],
        );
        assert.equal(report.detailSince, null);
      });
      assert.equal(
        (await db.platform.query('SELECT to_regclass($1) AS present', [at('tf_model_usage')])).rows[0].present,
        null,
      );
    } finally {
      await db.close();
    }
  },
);
