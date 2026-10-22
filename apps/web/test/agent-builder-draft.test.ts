import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { toolNameSchema } from '@tulipfarm/agents/contracts';
import { builderDraft, parseBuilder } from '../src/features/agents/builder-draft.ts';

const member = randomUUID(),
  agent = randomUUID();
function complete() {
  const draft = builderDraft();
  draft.definition = { name: 'People Ops', instructions: 'Cite policy sources.', tools: [] };
  return draft;
}

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

test('restored setup preserves distinct scopes and sponsor until explicit consent', () => {
  const draft = complete(),
    previousSponsor = randomUUID(),
    assetId = randomUUID();
  draft.access.scope = [{ assetId, permissions: ['table.row.read'] }];
  draft.access.limits = [{ assetId, permissions: ['table.row.read', 'table.row.update'] }];
  draft.schedules = [
    {
      id: randomUUID(),
      kind: 'task',
      activationId: '',
      tableId: '',
      text: 'Prepare the weekly update.',
      cadence: 'interval',
      minutes: { task: '60', inspect: '60' },
      cronExpression: '0 9 * * 1',
      timezone: 'UTC',
      limits: { toolCalls: '10', activeMilliseconds: '60', credits: '20' },
      sponsorConsent: false,
      sponsorMembershipId: previousSponsor,
    },
  ];
  const saved = parseBuilder(draft, member, false, agent).setup;
  assert.ok(saved);
  assert.notDeepEqual(saved.scope, saved.limits);
  assert.equal(saved.schedules[0]?.sponsorMembershipId, previousSponsor);
  assert.equal(parseBuilder(draft, member, true, agent).problems[0]?.step, 'triggers');
  draft.schedules[0]!.sponsorConsent = true;
  assert.equal(parseBuilder(draft, member, true, agent).setup?.schedules[0]?.sponsorMembershipId, member);
  draft.schedules[0]!.minutes.task = '59';
  assert.equal(parseBuilder(draft, member, false, agent).problems[0]?.step, 'triggers');
});
