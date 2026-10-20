import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { toolCallSchema, executionIdsSchema, agentDefinitionSchema } from '../src/contracts.ts';
import { saveAgentSchema, agentPolicySchema } from '../src/saved-contracts.ts';
import { inspectionActivationSchema, scheduleInputSchema } from '../src/schedule-contracts.ts';

test('tool admission excludes SQL, credentials, confirmation and role overrides', () => {
  for (const tool of ['sql', 'credentials.get', 'schema.confirm']) {
    assert.equal(toolCallSchema.safeParse({ tool, tableId: randomUUID() }).success, false);
  }
  assert.equal(
    toolCallSchema.safeParse({ tool: 'schema.status', tableId: randomUUID(), actor: { kind: 'human', role: 'admin' } })
      .success,
    false,
  );
  assert.equal(
    executionIdsSchema.safeParse({
      workspaceId: randomUUID(),
      runId: randomUUID(),
      callId: randomUUID(),
      values: { secret: 'business value' },
    }).success,
    false,
  );
});

test('saved definitions allow only the bounded registered tool vocabulary', () => {
  assert.equal(
    agentDefinitionSchema.safeParse({ name: 'Billing', instructions: 'Read invoices', tools: ['rows.list'] }).success,
    true,
  );
  assert.equal(
    agentDefinitionSchema.safeParse({
      name: 'Billing',
      instructions: 'Read incoming invoice links',
      tools: ['rows.reverse'],
    }).success,
    true,
  );
  assert.equal(
    agentDefinitionSchema.safeParse({ name: 'Billing', instructions: 'Read invoices', tools: ['schema.confirm'] })
      .success,
    false,
  );
});

test('incoming-link reads require bounded row and reverse-field identities', () => {
  const tableId = randomUUID(),
    recordId = randomUUID(),
    fieldId = randomUUID();
  assert.deepEqual(toolCallSchema.parse({ tool: 'rows.reverse', tableId, recordId, fieldId }), {
    tool: 'rows.reverse',
    tableId,
    recordId,
    fieldId,
    limit: 100,
  });
  assert.equal(toolCallSchema.safeParse({ tool: 'rows.reverse', tableId, recordId }).success, false);
});

test('rows.list keeps the legacy query and accepts one explicitly versioned query form', () => {
  const tableId = randomUUID(),
    fieldId = randomUUID(),
    revision = 'a'.repeat(40);
  const base = { tool: 'rows.list', tableId, expectedAppliedRevision: revision };
  const legacy = toolCallSchema.parse({ ...base, query: { filters: [{ fieldId, op: 'eq', value: 'Open' }] } });
  assert.deepEqual(legacy.query, { filters: [{ fieldId, op: 'eq', value: 'Open' }], limit: 50 });
  const structured = toolCallSchema.parse({
    ...base,
    query: {
      version: 2,
      mode: 'rows',
      where: { kind: 'any', nodes: [{ kind: 'rule', fieldId, op: 'eq', values: ['Open'] }] },
    },
  });
  assert.deepEqual([structured.query.version, structured.query.limit, structured.query.where.kind], [2, 50, 'any']);
  const typed = toolCallSchema.parse({ ...base, query: { version: 2, mode: 'rows', limit: 10 }, rsql: 'status==Open' });
  assert.deepEqual([typed.rsql, typed.query.where, typed.query.limit], ['status==Open', null, 10]);
  for (const mixed of [
    { ...base, query: { filters: [] }, rsql: 'status==Open' },
    {
      ...base,
      query: { version: 2, mode: 'rows', where: { kind: 'rule', fieldId, op: 'eq', values: ['Open'] } },
      rsql: 'status==Open',
    },
    { ...base, query: { filters: [], version: 2 } },
    { ...base, rsql: 'status==Open' },
    { ...base, query: { version: 2, mode: 'summary' }, rsql: 'status==Open' },
    { ...base, query: { mode: 'rows' }, rsql: 'status==Open' },
    { ...base, query: { version: 2, mode: 'rows' }, rsql: 'status==Open', options: { version: 2, mode: 'rows' } },
    base,
  ])
    assert.equal(toolCallSchema.safeParse(mixed).success, false, JSON.stringify(mixed));
});

test('summary and linked-name lookup tools are bounded read requests', () => {
  const tableId = randomUUID(),
    fieldId = randomUUID(),
    revision = 'a'.repeat(40);
  const summary = toolCallSchema.parse({
    tool: 'rows.summarize',
    tableId,
    expectedAppliedRevision: revision,
    query: { version: 2, mode: 'summary', groupBy: [fieldId] },
  });
  assert.deepEqual(summary.query.metrics, [{ fn: 'count' }]);
  assert.equal(
    toolCallSchema.safeParse({
      tool: 'rows.summarize',
      tableId,
      expectedAppliedRevision: revision,
      query: { version: 2, mode: 'rows' },
    }).success,
    false,
  );
  assert.equal(
    toolCallSchema.safeParse({
      tool: 'rows.summarize',
      tableId,
      expectedAppliedRevision: revision,
      query: { version: 2, mode: 'summary' },
      rsql: '',
    }).success,
    true,
  );
  assert.deepEqual(
    toolCallSchema.parse({
      tool: 'rows.resolveReference',
      tableId,
      expectedAppliedRevision: revision,
      fieldId,
      search: ' acme ',
    }),
    { tool: 'rows.resolveReference', tableId, expectedAppliedRevision: revision, fieldId, search: 'acme', limit: 10 },
  );
  assert.equal(
    toolCallSchema.safeParse({
      tool: 'rows.resolveReference',
      tableId,
      expectedAppliedRevision: revision,
      fieldId,
      search: 'acme',
      limit: 21,
    }).success,
    false,
  );
  assert.equal(
    toolCallSchema.safeParse({
      tool: 'rows.resolveReference',
      tableId,
      expectedAppliedRevision: revision,
      fieldId,
      search: '',
    }).success,
    false,
  );
  assert.equal(
    agentDefinitionSchema.safeParse({
      name: 'Analyst',
      instructions: 'Count tickets',
      tools: ['rows.summarize', 'rows.resolveReference'],
    }).success,
    true,
  );
});

test('model preference is optional and cannot carry a concrete route or fallback override', () => {
  const legacy = { name: 'Reader', instructions: 'Read invoices.', tools: ['rows.list'] };
  assert.deepEqual(agentDefinitionSchema.parse(legacy), legacy);
  assert.deepEqual(agentDefinitionSchema.parse({ ...legacy, modelFamilyId: 'claude-opus' }), {
    ...legacy,
    modelFamilyId: 'claude-opus',
  });
  for (const modelFamilyId of ['', null, 'https://provider.example', 'A'.repeat(101)]) {
    assert.equal(agentDefinitionSchema.safeParse({ ...legacy, modelFamilyId }).success, false);
  }
  for (const extra of [
    { model: 'version-1' },
    { providerUrl: 'https://provider.example' },
    { fallbackFamilyId: 'gpt-astra' },
  ]) {
    assert.equal(agentDefinitionSchema.safeParse({ ...legacy, ...extra }).success, false);
  }
});

test('saved-agent and schedule inputs canonicalize every UUID identity', () => {
  const id = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  const upper = id.toUpperCase();
  const input = {
    requestId: upper,
    owningTeamId: upper,
    expectedSoulRevision: 'a'.repeat(40),
    expectedSavedRevision: null,
    definition: { name: 'Reader', instructions: 'Read', tools: ['rows.list'] },
  };
  assert.deepEqual(saveAgentSchema.parse(input), { ...input, requestId: id, owningTeamId: id });
  assert.deepEqual(
    agentPolicySchema.parse({
      version: 0,
      owningTeamId: upper,
      grants: [{ teamId: upper, permissions: ['read'] }],
      personGrants: [{ membershipId: upper, permissions: ['manage'] }],
    }),
    {
      version: 0,
      owningTeamId: id,
      grants: [{ teamId: id, permissions: ['read'] }],
      personGrants: [{ membershipId: id, permissions: ['manage'] }],
    },
  );
  assert.deepEqual(inspectionActivationSchema.parse({ id: upper, tableId: upper, revision: 'b'.repeat(64) }), {
    id,
    tableId: id,
    revision: 'b'.repeat(64),
  });
  assert.deepEqual(
    scheduleInputSchema.parse({
      id: upper,
      activationId: upper,
      action: { kind: 'inspect', tableId: upper },
      trigger: { kind: 'interval', minutes: 5 },
      sponsorMembershipId: upper,
      historyAudience: [upper],
    }),
    {
      id,
      activationId: id,
      action: { kind: 'inspect', tableId: id },
      trigger: { kind: 'interval', minutes: 5 },
      sponsorMembershipId: id,
      historyAudience: [id],
    },
  );
  assert.deepEqual(
    scheduleInputSchema.parse({
      id,
      activationId: id,
      action: { kind: 'task', text: ' Summarize new leads ', limits: {} },
      trigger: { kind: 'cron', expression: '0 9 * * 1', timezone: 'Europe/London' },
      sponsorMembershipId: id,
      historyAudience: [],
    }).action,
    { kind: 'task', text: 'Summarize new leads', limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 } },
  );
  assert.throws(() =>
    scheduleInputSchema.parse({
      id,
      activationId: id,
      tableId: id,
      trigger: { kind: 'interval', minutes: 5 },
      sponsorMembershipId: id,
      historyAudience: [],
    }),
  );
  assert.equal(saveAgentSchema.parse({ ...input, owningTeamId: null }).owningTeamId, null);
});
