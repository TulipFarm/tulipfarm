import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  startNavigationMeasure,
  measureWorkspaceAdmission,
  subscribeNavigationPerformance,
} from '../src/lib/navigation-performance.ts';

test('performance capture is opt-in, bounded, and preserves admission results and failures', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  let enabled = false;
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: { getItem: () => (enabled ? '1' : null) },
  });
  try {
    performance.clearMeasures();
    assert.equal(await measureWorkspaceAdmission(async () => 'admitted'), 'admitted');
    assert.equal(performance.getEntriesByType('measure').length, 0);
    enabled = true;
    assert.equal(await measureWorkspaceAdmission(async () => 'admitted'), 'admitted');
    const failure = new Error('private failure details');
    await assert.rejects(
      measureWorkspaceAdmission(async () => {
        throw failure;
      }),
      error => error === failure,
    );
    const finish = startNavigationMeasure('chat-list');
    finish('ready');
    finish('error');
    assert.deepEqual(
      performance.getEntriesByType('measure').map(entry => entry.name),
      ['tulipfarm:workspace-admission:ready', 'tulipfarm:workspace-admission:error', 'tulipfarm:chat-list:ready'],
    );
    assert.ok(performance.getEntriesByType('measure').every(entry => entry.detail === null));
    for (let i = 0; i < 100; i++) startNavigationMeasure('chat-list')('ready');
    assert.equal(performance.getEntriesByName('tulipfarm:chat-list:ready').length, 1);
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('Storage blocked');
      },
    });
    assert.equal(await measureWorkspaceAdmission(async () => 'still admitted'), 'still admitted');
  } finally {
    performance.clearMeasures();
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});

test('field journeys do not require local marks, backfill consent, or survive teardown', () => {
  const events: unknown[] = [];
  const beforeConsent = startNavigationMeasure('chat-list');
  const unsubscribe = subscribeNavigationPerformance(event => events.push(event));
  try {
    beforeConsent('ready');
    assert.equal(events.length, 0);
    const finish = startNavigationMeasure('chat-list');
    finish('ready');
    finish('error');
    assert.equal(events.length, 1);
    const event = events[0] as { journey: string; outcome: string; duration_ms: number };
    assert.deepEqual(Object.keys(event).sort(), ['duration_ms', 'journey', 'outcome']);
    assert.equal(event.journey, 'chat-list');
    assert.equal(event.outcome, 'ready');
    assert.ok(event.duration_ms >= 0);
    const pending = startNavigationMeasure('workspace-admission');
    unsubscribe();
    pending('ready');
    assert.equal(events.length, 1);
  } finally {
    unsubscribe();
  }
});

test('telemetry failures do not replace admission outcomes or leak exception text', async t => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    warnings.push(args);
  });
  const stop = subscribeNavigationPerformance(() => {
    throw new Error('PRIVATE_CAPTURE_ERROR');
  });
  try {
    assert.equal(await measureWorkspaceAdmission(async () => 'ready'), 'ready');
    const failure = new Error('PRIVATE_ADMISSION_ERROR');
    await assert.rejects(
      measureWorkspaceAdmission(async () => {
        throw failure;
      }),
      error => error === failure,
    );
    assert.deepEqual(warnings, [['Browser performance capture failed'], ['Browser performance capture failed']]);
  } finally {
    stop();
  }
});
