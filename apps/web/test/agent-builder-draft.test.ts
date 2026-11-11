import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { toolNameSchema } from '@tulipfarm/agents/contracts';
import { tableAccessEnrollment } from '@tulipfarm/agents/setup-contracts';
import { agentContextSchema } from '@tulipfarm/agents/saved-contracts';
import {
  builderDraft,
  nextBuilderStep,
  parseBuilder,
  updateBuilderLimits,
} from '../src/features/agents/builder-draft.ts';

const member = randomUUID(),
  agent = randomUUID();
function complete() {
  const draft = builderDraft();
  draft.definition = { name: 'People Ops', instructions: 'Cite policy sources.', tools: [] };
  return draft;
}

test('table selection adds the fewest granting teams and keeps explicit enrollment choices', () => {
  const assetId = randomUUID(),
    unrelated = randomUUID(),
    reader = randomUUID(),
    editor = randomUUID(),
    both = randomUUID();
  const teams = [
    { id: unrelated, tableScope: [{ assetId: randomUUID(), permissions: ['table.row.read' as const] }] },
    { id: reader, tableScope: [{ assetId, permissions: ['table.row.read' as const] }] },
    { id: editor, tableScope: [{ assetId, permissions: ['table.row.update' as const] }] },
    { id: both, tableScope: [{ assetId, permissions: ['table.row.read' as const, 'table.row.update' as const] }] },
  ].map(team => ({ ...team, canAssign: true }));
  const entry = { assetId, permissions: ['table.row.read' as const, 'table.row.update' as const] };
  assert.deepEqual(tableAccessEnrollment(teams, entry, []), [both]);
  assert.deepEqual(tableAccessEnrollment(teams, entry, [unrelated]), [unrelated, both]);
  assert.deepEqual(tableAccessEnrollment(teams, entry, [reader, editor]), [reader, editor]);
  assert.deepEqual(tableAccessEnrollment([], entry, []), [], 'never invent a granting team');
  const memberOnly = [{ ...teams[1]!, canAssign: false }];
  assert.deepEqual(
    tableAccessEnrollment(memberOnly, { assetId, permissions: ['table.row.read'] }, []),
    [],
    'plain membership does not authorize assigning a team',
  );
  const context = agentContextSchema.parse({
    currentSoulRevision: 'a'.repeat(40),
    teams: [
      {
        id: both,
        name: 'Operations',
        canAssign: true,
        tableScope: [...Array.from({ length: 100 }, () => ({ ...entry, assetId: randomUUID() })), entry],
      },
    ],
  });
  assert.deepEqual(tableAccessEnrollment(context.teams, entry, []), [both], 'available tables are not selected scope');
});

test('builder enforces exact manual text, skill and action bounds on the owning stage', () => {
  const draft = complete();
  draft.definition.name = 'N'.repeat(120);
  draft.definition.instructions = '😀'.repeat(16000);
  draft.definition.tools = toolNameSchema.options.slice(0, 20);
  draft.definition.skills = Array.from({ length: 16 }, () => ({ id: randomUUID(), revision: 'a'.repeat(64) }));
  assert.ok(parseBuilder(draft, member, false, agent).setup);
  draft.definition.name += 'N';
  assert.equal(parseBuilder(draft, member, false, agent).problems[0]?.step, 'basics');
  draft.definition.name = 'People Ops';
  draft.definition.instructions += 'x';
  assert.equal(parseBuilder(draft, member, false, agent).problems[0]?.step, 'basics');
  draft.definition.instructions = 'Cite policy sources.';
  draft.definition.skills.push({ id: randomUUID(), revision: 'b'.repeat(64) });
  assert.equal(parseBuilder(draft, member, false, agent).problems[0]?.step, 'skills');
  draft.definition.skills.pop();
  draft.definition.tools = toolNameSchema.options.slice(0, 21);
  assert.equal(parseBuilder(draft, member, false, agent).problems[0]?.step, 'access');
});

test('restored setup preserves distinct scopes and needs explicit consent for unattended triggers', () => {
  const draft = complete(),
    assetId = randomUUID(),
    triggerId = randomUUID();
  draft.access.scope = [{ assetId, permissions: ['table.row.read'] }];
  draft.access.limits = [{ assetId, permissions: ['table.row.read', 'table.row.update'] }];
  draft.definition.tools = ['rows.list'];
  draft.triggers = [
    { id: triggerId, trigger: { kind: 'cron', expression: '0 9 * * 1', timezone: 'UTC' } },
    { id: randomUUID(), label: 'On request', trigger: { kind: 'event', name: 'weekly_update' } },
  ];
  draft.prompt = 'Prepare the weekly update.';
  const saved = parseBuilder(draft, member, false, agent).setup;
  assert.ok(saved);
  assert.notDeepEqual(saved.scope, saved.limits);
  assert.deepEqual(saved.triggers[0], {
    id: triggerId,
    trigger: { kind: 'cron', expression: '0 9 * * 1', timezone: 'UTC' },
  });
  assert.equal(saved.prompt, 'Prepare the weekly update.');
  assert.equal(parseBuilder(draft, member, true, agent).setup?.triggers.length, 2);
  draft.prompt = undefined;
  assert.deepEqual(parseBuilder(draft, member, false, agent).problems, [
    { step: 'triggers', message: 'Triggers need a prompt.' },
  ]);
});

test('table setup skips empty optional sections but keeps configured skills and triggers in the flow', () => {
  const draft = complete();
  assert.equal(nextBuilderStep('basics', draft), 'access');
  assert.equal(nextBuilderStep('access', draft), 'review');
  draft.access.limits = [{ assetId: randomUUID(), permissions: ['table.row.read'] }];
  assert.equal(nextBuilderStep('basics', draft), 'review');
  draft.definition.skills = [{ id: randomUUID(), revision: 'a'.repeat(64) }];
  assert.equal(nextBuilderStep('basics', draft), 'access');
  assert.equal(nextBuilderStep('access', draft), 'skills');
  assert.equal(nextBuilderStep('skills', draft), 'review');
  draft.prompt = 'Prepare the weekly update.';
  assert.equal(nextBuilderStep('skills', draft), 'triggers');
  assert.equal(nextBuilderStep('triggers', draft), 'review');
});

test('activation needs a row reader for table scope, without changing manual tools or blocking draft saves', () => {
  const draft = complete();
  draft.access.scope = [{ assetId: randomUUID(), permissions: ['table.row.read'] }];
  draft.access.limits = draft.access.scope;
  assert.ok(parseBuilder(draft, member, false, agent).setup);
  draft.definition.tools = ['tables.list', 'schema.inspect'];
  assert.deepEqual(parseBuilder(draft, member, true, agent).problems, [
    {
      step: 'access',
      message:
        'This agent has table access but no action that reads rows. Add Find rows or Read a row in the Access step, or remove its table access.',
    },
  ]);
  assert.deepEqual(draft.definition.tools, ['tables.list', 'schema.inspect']);
  draft.definition.tools = ['rows.summarize'];
  assert.equal(parseBuilder(draft, member, true, agent).setup, null);
  for (const tool of ['rows.list', 'rows.get'] as const) {
    draft.definition.tools = [tool];
    assert.ok(parseBuilder(draft, member, true, agent).setup);
  }
});

test('adding a table preserves an existing narrower scope until its permissions are explicitly changed', () => {
  const { access } = complete();
  const customers = randomUUID(),
    orders = randomUUID();
  access.limits = [{ assetId: customers, permissions: ['table.row.read', 'table.row.update'] }];
  access.scope = [{ assetId: customers, permissions: ['table.row.read'] }];
  const teams = [
    {
      id: randomUUID(),
      name: 'Operations',
      canAssign: true,
      tableScope: [{ assetId: orders, permissions: ['table.row.read' as const] }],
    },
  ];
  const added = updateBuilderLimits(
    access,
    [
      { ...access.limits[0]!, permissions: [...access.limits[0]!.permissions] },
      { assetId: orders, permissions: ['table.row.read'] },
    ],
    teams,
  );
  assert.deepEqual(added.enrollment, [teams[0]!.id]);
  assert.deepEqual(added.scope, [
    { assetId: customers, permissions: ['table.row.read'] },
    { assetId: orders, permissions: ['table.row.read'] },
  ]);
  const changed = updateBuilderLimits(
    { ...access, ...added },
    [{ assetId: customers, permissions: ['table.row.read', 'table.row.delete'] }, added.limits[1]!],
    teams,
  );
  assert.deepEqual(changed.scope[1], { assetId: customers, permissions: ['table.row.read', 'table.row.delete'] });
  assert.deepEqual(updateBuilderLimits({ ...access, ...changed }, [], teams).scope, []);
});
