import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflowSchema, type Trigger } from '@tulipfarm/workflows/contracts';
import {
  knownTriggers,
  liveTriggers,
  runTriggerName,
  triggerLine,
  triggersLine,
  triggerState,
} from '../src/features/workflows/triggers.ts';

const id = '00000000-0000-4000-8000-000000000001',
  older = '00000000-0000-4000-8000-000000000002';
const digest: Trigger = { id: 'digest', kind: 'interval', minutes: 60, label: 'Hourly digest' };
const hook: Trigger = { id: 'orders', kind: 'webhook' };
const legacy: Trigger = { id: 'legacy', kind: 'event', name: 'legacy_request' };
const workflow = (saved: Trigger[], active: Trigger[] | null, enabled = true, off: string[] = []) =>
  workflowSchema.parse({
    id,
    revision: id,
    activeRevision: active ? older : null,
    enabled,
    generation: 1,
    nextRunAt: null,
    definition: { version: 1, name: 'Orders', triggers: saved, steps: [{ id: 'copy', kind: 'transform', fields: {} }] },
    activeTriggers: active,
    triggers: (active ?? []).map(trigger => ({
      id: trigger.id,
      kind: trigger.kind,
      enabled: !off.includes(trigger.id),
      summary: trigger.kind,
      nextRunAt: null,
      webhook: null,
    })),
  });

test('a once trigger is named with its time zone in the shared format', () => {
  assert.equal(
    triggerLine({ kind: 'once', at: '2026-11-08T09:46:00Z', timezone: 'Asia/Kolkata' }),
    'Once on 8 Nov 2026 at 15:16 (Asia/Kolkata)',
  );
  assert.equal(
    triggerLine({ kind: 'once', at: '2026-11-08T09:46:00Z', timezone: 'America/New_York' }),
    'Once on 8 Nov 2026 at 04:46 (America/New York)',
  );
  assert.equal(triggerLine({ kind: 'once', at: '2026-11-08T09:46:00Z' }), 'Once on 8 Nov 2026 at 09:46 (UTC)');
});

test('a trigger list summary names each trigger by label or settings', () => {
  assert.equal(triggersLine([]), 'Started by hand');
  assert.equal(triggersLine([digest]), 'Hourly digest');
  assert.equal(triggersLine([hook]), 'Webhook');
  assert.equal(triggersLine([digest, hook, legacy]), '3 triggers: Hourly digest, Webhook, App event legacy_request');
});

test('live triggers and switch state follow the active revision while the workflow is on', () => {
  const current = workflow([digest, hook], [hook, legacy], true, ['legacy']);
  assert.deepEqual(
    liveTriggers(current).map(trigger => trigger.id),
    ['orders', 'legacy'],
  );
  assert.equal(triggerState(current, 'orders')?.enabled, true);
  assert.equal(triggerState(current, 'legacy')?.enabled, false, 'each trigger keeps its own switch');
  assert.equal(triggerState(current, 'digest'), undefined, 'a saved-only trigger has no switch until activated');
  assert.deepEqual(
    liveTriggers(workflow([digest], [hook], false)).map(trigger => trigger.id),
    ['digest'],
    'a disabled workflow shows its saved triggers',
  );
});

test('the run trigger filter offers every saved or active trigger and names removed ones', () => {
  const choices = knownTriggers(workflow([digest, hook], [legacy, hook]));
  assert.deepEqual(
    choices.map(trigger => trigger.id),
    ['digest', 'orders', 'legacy'],
  );
  assert.equal(runTriggerName('digest', choices), 'Hourly digest');
  assert.equal(runTriggerName(null, choices), 'Started by hand');
  assert.equal(runTriggerName('cron_1a2b3c', choices), 'Removed trigger cron_1a2b3c');
});
