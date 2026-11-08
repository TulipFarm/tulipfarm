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

test('restored setup preserves distinct scopes and needs explicit consent for unattended triggers', () => {
  const draft = complete(),
    assetId = randomUUID(),
    triggerId = randomUUID();
  draft.access.scope = [{ assetId, permissions: ['table.row.read'] }];
  draft.access.limits = [{ assetId, permissions: ['table.row.read', 'table.row.update'] }];
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
  assert.equal(parseBuilder(draft, member, true, agent).problems[0]?.step, 'triggers');
  draft.sponsorConsent = true;
  assert.equal(parseBuilder(draft, member, true, agent).setup?.triggers.length, 2);
  draft.prompt = undefined;
  assert.deepEqual(parseBuilder(draft, member, false, agent).problems, [
    { step: 'triggers', message: 'Triggers need a prompt.' },
  ]);
});
