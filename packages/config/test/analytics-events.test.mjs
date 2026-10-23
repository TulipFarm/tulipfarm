import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyticsEventNames,
  analyticsEventProperties,
  analyticsEvents,
  isAnalyticsEvent,
} from '../dist/analytics-events.js';

test('every event is snake_case with a description and typed properties', () => {
  for (const [name, definition] of Object.entries(analyticsEvents)) {
    assert.match(name, /^[a-z]+(_[a-z]+)+$/);
    assert.ok(definition.description.endsWith('.'), name);
    for (const type of Object.values(definition.properties))
      assert.ok(['boolean', 'number', 'id'].includes(type) || type.enum || type.identifier, name);
  }
  assert.deepEqual(analyticsEventNames, Object.keys(analyticsEvents));
  assert.equal(isAnalyticsEvent('task_completed'), true);
  assert.equal(isAnalyticsEvent('toString'), false);
});

test('only declared properties of the declared type are kept', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(analyticsEventProperties('task_completed', { outcome: 'failed', prompt: 'secret' }), {
    outcome: 'failed',
  });
  assert.deepEqual(analyticsEventProperties('task_completed', { outcome: 'other' }), {});
  assert.deepEqual(analyticsEventProperties('member_invited', { resend: 'yes' }), {});
  assert.deepEqual(analyticsEventProperties('workflow_saved', { workflow_id: id, created: true }), {
    workflow_id: id,
    created: true,
  });
  assert.deepEqual(analyticsEventProperties('workflow_saved', { workflow_id: 'ada@example.com' }), {});
  assert.deepEqual(analyticsEventProperties('integration_connected', { provider: 'github' }), { provider: 'github' });
  assert.deepEqual(analyticsEventProperties('integration_connected', { provider: 'Free text here' }), {});
  assert.deepEqual(analyticsEventProperties('not_an_event', { anything: true }), {});
});
