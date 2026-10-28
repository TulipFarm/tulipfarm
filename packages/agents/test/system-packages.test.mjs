import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { z } from 'zod';
import { evaluateCondition } from '@tulipfarm/workflows/contracts';
import { systemPackageSchema, systemPackageSchemaId } from '../src/system-package-contracts.ts';
import { validatePackage } from '../src/system-packages.ts';
import { packageCompiler, tableGroups, packageAssetBytes } from '../src/system-package-compiler.ts';
import { tableShell } from '../src/system-package-tables.ts';

const root = new URL('../../config/examples/system-packages/', import.meta.url);
const example = async (name = 'leave-management') => JSON.parse(await readFile(new URL(`${name}.json`, root)));
const bindings = {
  'owning-team': { kind: 'team', id: '11111111-1111-4111-8111-111111111111' },
  'package-manager': { kind: 'member', id: '22222222-2222-4222-8222-222222222222' },
};
const clone = value => structuredClone(value);

test('published schema is generated from the contract and all examples pass semantic validation', async () => {
  const published = JSON.parse(await readFile(new URL('../../config/schemas/system-package.v1.json', import.meta.url)));
  const generated = z.toJSONSchema(systemPackageSchema, { target: 'draft-2020-12', io: 'input' });
  const { $id, title: _title, description: _description, ...shape } = published;
  assert.equal($id, systemPackageSchemaId);
  assert.deepEqual(shape, generated);
  for (const name of ['leave-management', 'issue-tracking', 'blog-writing', 'linked-records', 'sheet-event-review']) {
    const pkg = await example(name);
    const selected =
      name === 'sheet-event-review'
        ? { 'sheet-connection': { kind: 'integration', id: bindings['owning-team'].id } }
        : Object.fromEntries(pkg.inputs.map(input => [input.key, bindings[input.key]]));
    const report = validatePackage(pkg, selected);
    assert.equal(report.valid, true, JSON.stringify(report.issues));
    assert.equal(report.order.length, pkg.resources.length);
  }
});

test('public packages reject unknown instructions, hooks and credential fields', async () => {
  const pkg = await example();
  for (const invalid of [
    { ...pkg, install: { command: 'run' } },
    { ...pkg, resources: [{ ...pkg.resources[0], tool: 'tables.create' }] },
    { ...pkg, inputs: [{ key: 'token', kind: 'secret', title: 'Token' }] },
  ])
    assert.equal(systemPackageSchema.safeParse(invalid).success, false);
  const provider = await example('sheet-event-review');
  provider.resources[0].token = 'not-a-public-field';
  assert.equal(systemPackageSchema.safeParse(provider).success, false);
});

test('semantic validation rejects wrong-kind references, cycles, invalid fields and changed bytes before install', async () => {
  const original = await example();
  const cases = [
    [
      'invalid-reference',
      pkg => {
        pkg.resources.find(r => r.kind === 'agent').skills[0].key = 'leave-policies';
      },
    ],
    [
      'dependency-cycle',
      pkg => {
        const table = pkg.resources.find(r => r.key === 'leave-policies');
        table.fields.push({
          key: 'requests',
          label: 'Requests',
          kind: 'relationship',
          required: false,
          target: { kind: 'resource', resourceKind: 'table', key: 'leave-requests' },
          cardinality: 'many',
          inverseCardinality: 'many',
          reverse: null,
          onDelete: 'restrict',
        });
        pkg.resources.find(r => r.key === 'leave-policies-initial').values.requests = {
          kind: 'relationship',
          rows: [{ kind: 'resource', resourceKind: 'seed-row', key: 'leave-requests-initial' }],
        };
      },
    ],
    [
      'asset-digest-mismatch',
      pkg => {
        pkg.assets[0].content += '\nChanged';
      },
    ],
    [
      'duplicate-key',
      pkg => {
        pkg.resources.push(clone(pkg.resources[0]));
      },
    ],
    [
      'invalid-definition',
      pkg => {
        pkg.resources.find(r => r.kind === 'seed-row').values.missing = { kind: 'text', value: 'Unknown field' };
      },
    ],
    [
      'invalid-definition',
      pkg => {
        pkg.resources.find(r => r.key === 'leave-requests-initial').values.status.option = 'unknown';
      },
    ],
  ];
  for (const [code, change] of cases) {
    const pkg = clone(original);
    change(pkg);
    const result = validatePackage(pkg, bindings);
    assert.equal(result.valid, false, code);
    assert.ok(
      result.issues.some(issue => issue.code === code),
      JSON.stringify(result.issues),
    );
  }
});

test('canonical package intent ignores property order but changes when a binding or definition changes', async () => {
  const pkg = await example();
  const first = validatePackage(pkg, bindings);
  const reordered = Object.fromEntries(Object.entries(pkg).reverse());
  assert.equal(validatePackage(reordered, bindings).inputDigest, first.inputDigest);
  const changed = validatePackage(pkg, {
    ...bindings,
    'owning-team': { kind: 'team', id: '22222222-2222-4222-8222-222222222222' },
  });
  assert.equal(changed.packageDigest, first.packageDigest);
  assert.notEqual(changed.inputDigest, first.inputDigest);
  pkg.resources.find(r => r.kind === 'agent').definition.instructions += '\nAsk for evidence.';
  assert.notEqual(validatePackage(pkg, bindings).packageDigest, first.packageDigest);
});

test('cyclic table schemas retain reverse fields and bundled file identities without allowing row cycles', async () => {
  const pkg = systemPackageSchema.parse(await example('linked-records'));
  const selected = { 'owning-team': bindings['owning-team'] };
  assert.equal(validatePackage(pkg, selected).valid, true);
  assert.deepEqual(
    tableGroups(pkg).map(group => group.map(table => table.key).sort()),
    [['documents', 'projects']],
  );
  const compiler = packageCompiler(pkg, selected, '33333333-3333-4333-8333-333333333333');
  const documents = pkg.resources.find(resource => resource.key === 'documents');
  const relationship = compiler.definition(documents).fields.find(field => field.kind === 'relationship');
  assert.equal(relationship.targetTableId, compiler.id('projects'));
  assert.equal(relationship.reverse.fieldId, compiler.fieldId('projects', 'referenced-by'));
  const row = compiler.rows(pkg.resources.find(resource => resource.kind === 'seed-row'));
  assert.deepEqual(row[compiler.fieldId('documents', 'attachment')].fileIds, [compiler.id('guide')]);
  assert.equal(
    compiler.file(pkg.resources.find(resource => resource.kind === 'file')).bytes.length,
    pkg.assets[0].size,
  );
  assert.throws(
    () => packageAssetBytes({ ...pkg.assets[0], content: `${pkg.assets[0].content}\n` }),
    /canonical base64/,
  );
  documents.fields.push({ ...documents.fields[0], key: 'referenced-by' });
  assert.ok(validatePackage(pkg, selected).issues.some(issue => issue.code === 'duplicate-reverse-field'));
});

test('cyclic table shells defer relationship unique keys while retaining scalar keys and full constraints', async () => {
  const pkg = systemPackageSchema.parse(await example('linked-records'));
  const table = pkg.resources.find(resource => resource.key === 'projects');
  table.uniqueKeys.push(
    { key: 'related', fields: ['related'], nulls: 'distinct' },
    { key: 'title-related', fields: ['title', 'related'], nulls: 'distinct' },
  );
  const original = clone(table);
  const selected = { 'owning-team': bindings['owning-team'] };
  const report = validatePackage(pkg, selected);
  assert.equal(report.valid, true, JSON.stringify(report.issues));
  const compiler = packageCompiler(pkg, selected, '33333333-3333-4333-8333-333333333333');
  const full = compiler.definition(table);
  const shell = compiler.definition(tableShell(table));
  assert.deepEqual(shell.uniqueKeys, [full.uniqueKeys[0]]);
  assert.ok(shell.fields.every(field => field.kind !== 'relationship'));
  assert.deepEqual(
    compiler.definition(table).uniqueKeys.map(key => key.fieldIds),
    [
      [compiler.fieldId('projects', 'title')],
      [compiler.fieldId('projects', 'related')],
      [compiler.fieldId('projects', 'title'), compiler.fieldId('projects', 'related')],
    ],
  );
  assert.deepEqual(table, original);
});

test('row and find-rows value paths bind fields in each installation while literals remain opaque', async () => {
  const pkg = systemPackageSchema.parse(await example('linked-records'));
  const workflow = pkg.resources.find(resource => resource.kind === 'workflow');
  const table = { kind: 'resource', resourceKind: 'table', key: 'documents' };
  const literal = { kind: 'literal', value: { kind: 'resource', resourceKind: 'table', key: 'not-a-reference' } };
  workflow.steps.push(
    { id: 'lookup', kind: 'find-rows', table, filters: [], limit: 1 },
    {
      id: 'result',
      kind: 'transform',
      fields: {
        title: { kind: 'step', step: 'lookup', path: ['rows', '0', 'values', { field: 'title' }, 'value'] },
        literal,
      },
    },
  );
  const selected = { 'owning-team': bindings['owning-team'] };
  assert.equal(validatePackage(pkg, selected).valid, true);
  const first = packageCompiler(pkg, selected, '33333333-3333-4333-8333-333333333333');
  const second = packageCompiler(pkg, selected, '44444444-4444-4444-8444-444444444444');
  for (const compiler of [first, second]) {
    const steps = compiler.workflow(workflow).steps;
    assert.deepEqual(steps[0].fields.title.path, ['values', compiler.fieldId('documents', 'title'), 'value']);
    assert.deepEqual(steps[0].fields.previous_title.path, [
      'previousValues',
      compiler.fieldId('documents', 'title'),
      'value',
    ]);
    assert.deepEqual(steps[2].fields.title.path, [
      'rows',
      '0',
      'values',
      compiler.fieldId('documents', 'title'),
      'value',
    ]);
    assert.deepEqual(steps[2].fields.literal, literal);
  }
  assert.notDeepEqual(first.workflow(workflow), second.workflow(workflow));
  workflow.steps[2].fields.title.path = ['rows', '0', 'wrong', { field: 'title' }];
  assert.ok(validatePackage(pkg, selected).issues.some(issue => issue.code === 'invalid-definition'));
});

test('skill sharing requires an explicit manager and event workflows preserve native sponsorship rules', async () => {
  const pkg = await example();
  const skill = pkg.resources.find(resource => resource.kind === 'skill');
  skill.sharing.personGrants = [];
  assert.ok(validatePackage(pkg, bindings).issues.some(issue => issue.code === 'skill-manager-required'));
  delete skill.sharing;
  const workflow = pkg.resources.find(resource => resource.kind === 'workflow');
  workflow.trigger = { kind: 'event', name: 'review_requested' };
  workflow.requestedState = 'enabled';
  assert.equal(validatePackage(pkg, bindings).valid, true);
  workflow.trigger = { kind: 'interval', minutes: 60 };
  assert.ok(validatePackage(pkg, bindings).issues.some(issue => issue.code === 'sponsor-required'));
});

test('typed select operands drive native conditions correctly in separate installations', async () => {
  const pkg = systemPackageSchema.parse(await example());
  const table = pkg.resources.find(resource => resource.key === 'leave-requests');
  table.fields.push({
    key: 'labels',
    label: 'Labels',
    kind: 'multi-select',
    required: false,
    options: [
      { key: 'urgent', label: 'Urgent', retired: false },
      { key: 'remote', label: 'Remote', retired: false },
    ],
  });
  const workflow = pkg.resources.find(resource => resource.kind === 'workflow');
  const tableRef = { kind: 'resource', resourceKind: 'table', key: table.key };
  workflow.trigger = { kind: 'row', table: tableRef, event: 'updated' };
  workflow.steps = [
    {
      id: 'status',
      kind: 'condition',
      ifMet: ['status_hit'],
      otherwise: [],
      when: {
        left: { kind: 'input', path: ['values', { field: 'status' }] },
        op: 'eq',
        right: { kind: 'option', table: tableRef, field: 'status', option: 'draft' },
      },
    },
    {
      id: 'labels',
      kind: 'condition',
      ifMet: ['labels_hit'],
      otherwise: [],
      when: {
        left: { kind: 'input', path: ['values', { field: 'labels' }] },
        op: 'eq',
        right: { kind: 'options', table: tableRef, field: 'labels', options: ['urgent', 'remote'] },
      },
    },
    { id: 'status_hit', kind: 'transform', fields: { matched: { kind: 'literal', value: true } } },
    { id: 'labels_hit', kind: 'transform', fields: { matched: { kind: 'literal', value: true } } },
  ];
  assert.equal(validatePackage(pkg, bindings).valid, true);
  for (const installation of ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444']) {
    const compiler = packageCompiler(pkg, bindings, installation);
    const steps = compiler.workflow(workflow).steps;
    const input = {
      values: {
        [compiler.fieldId(table.key, 'status')]: {
          kind: 'single-select',
          optionId: compiler.optionId(table.key, 'status', 'draft'),
        },
        [compiler.fieldId(table.key, 'labels')]: {
          kind: 'multi-select',
          optionIds: ['urgent', 'remote'].map(key => compiler.optionId(table.key, 'labels', key)),
        },
      },
    };
    assert.equal(evaluateCondition(steps[0].when, input, new Map()), true);
    assert.equal(evaluateCondition(steps[1].when, input, new Map()), true);
    input.values[compiler.fieldId(table.key, 'status')].optionId = compiler.optionId(table.key, 'status', 'reviewed');
    input.values[compiler.fieldId(table.key, 'labels')].optionIds = [];
    assert.equal(evaluateCondition(steps[0].when, input, new Map()), false);
    assert.equal(evaluateCondition(steps[1].when, input, new Map()), false);
  }
  workflow.steps[0].when.right.option = 'missing';
  assert.ok(validatePackage(pkg, bindings).issues.some(issue => issue.code === 'invalid-definition'));
});

test('agent compilation preserves independent limits, grants, skill pins, MCP and scheduled consent intent', async () => {
  const pkg = systemPackageSchema.parse(await example());
  const agent = pkg.resources.find(resource => resource.kind === 'agent');
  const member = { kind: 'input', inputKind: 'member', key: 'package-manager' };
  const connection = { kind: 'input', inputKind: 'connection', key: 'mcp' };
  pkg.inputs.push({ key: 'mcp', kind: 'connection', title: 'MCP' });
  const selected = { ...bindings, mcp: { kind: 'connection', id: '55555555-5555-4555-8555-555555555555' } };
  agent.definition.mcp = [
    {
      id: 'tools',
      serverIdentity: 'a'.repeat(64),
      tools: [{ name: 'read', revision: 'b'.repeat(64) }],
      integration: connection,
    },
  ];
  agent.skills.push({ kind: 'builtin', id: 'table-authoring', revision: 'latest' });
  agent.schedules = [
    {
      key: 'daily',
      trigger: { kind: 'interval', minutes: 1440 },
      action: { kind: 'task', text: 'Review records', limits: agent.taskLimits },
      sponsor: member,
    },
  ];
  const compiler = packageCompiler(pkg, selected, '33333333-3333-4333-8333-333333333333');
  const setup = compiler.agent(agent, { 'leave-management-procedure': 'c'.repeat(64) });
  assert.notDeepEqual(setup.scope, setup.limits);
  assert.equal(setup.enrollment[0], bindings['owning-team'].id);
  assert.equal(setup.policy.grants[0].teamId, bindings['owning-team'].id);
  assert.equal(setup.definition.responseRule, 'tag');
  assert.equal(setup.definition.skills[1].id, 'table-authoring');
  assert.equal(setup.definition.mcp[0].integrationId, selected.mcp.id);
  assert.equal(setup.schedules[0].sponsorMembershipId, bindings['package-manager'].id);
  assert.deepEqual(setup.schedules[0].action, agent.schedules[0].action);
});

test('portable field mappings resolve select options and relationship rows to each installation identity', async () => {
  const pkg = systemPackageSchema.parse(await example());
  const workflow = pkg.resources.find(r => r.kind === 'workflow');
  workflow.steps = [
    {
      id: 'create',
      kind: 'create-row',
      table: { kind: 'resource', resourceKind: 'table', key: 'leave-requests' },
      fields: [
        { field: 'status', value: { kind: 'table-value', value: { kind: 'single-select', option: 'draft' } } },
        {
          field: 'catalog',
          value: {
            kind: 'table-value',
            value: {
              kind: 'relationship',
              rows: [{ kind: 'resource', resourceKind: 'seed-row', key: 'leave-policies-initial' }],
            },
          },
        },
      ],
    },
  ];
  const first = packageCompiler(pkg, bindings, '33333333-3333-4333-8333-333333333333');
  const retry = packageCompiler(pkg, bindings, '33333333-3333-4333-8333-333333333333');
  const second = packageCompiler(pkg, bindings, '44444444-4444-4444-8444-444444444444');
  const fields = first.workflow(workflow).steps[0].fields;
  const table = first.definition(pkg.resources.find(r => r.key === 'leave-requests'));
  const status = table.fields.find(field => field.label === 'Status');
  const catalog = table.fields.find(field => field.kind === 'relationship');
  assert.deepEqual(fields[status.id], { kind: 'literal', value: status.options[0].id });
  assert.deepEqual(fields[catalog.id], { kind: 'literal', value: [first.id('leave-policies-initial')] });
  assert.deepEqual(first.workflow(workflow), retry.workflow(workflow));
  assert.notEqual(first.id('leave-requests'), second.id('leave-requests'));
  assert.notDeepEqual(first.workflow(workflow), second.workflow(workflow));
});
