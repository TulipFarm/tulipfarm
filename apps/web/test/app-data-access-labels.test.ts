import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import type { AppSummary, DataView } from '../src/features/apps/api.ts';

const source = new URL('../src/', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/lib/auth')
      return { url: 'data:text/javascript,export const apiOrigin = "http://apps.test";', shortCircuit: true };
    if (specifier.startsWith('@/')) return next(new URL(`${specifier.slice(2)}.ts`, source).href, context);
    if (context.parentURL?.includes('/src/') && specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier))
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { actionPhrase, fieldLabel, tableName, valueText, viewStatus, viewSummary } =
  await import('../src/features/apps/data-access-labels.ts');
hooks.deregister();

const member = '22222222-2222-4222-8222-222222222222';
const shipped = '0e000000-0000-4000-8000-000000000001';
const fields = {
  number: {
    id: 'f0000000-0000-4000-8000-000000000001',
    label: 'Order number',
    required: true,
    kind: 'text',
    maxLength: 64,
  },
  status: {
    id: 'f0000000-0000-4000-8000-000000000002',
    label: 'Status',
    required: true,
    kind: 'single-select',
    options: [{ id: shipped, label: 'Shipped', retired: false }],
  },
  paid: { id: 'f0000000-0000-4000-8000-000000000003', label: 'Paid', required: false, kind: 'boolean' },
} as const;
const orders = { label: 'Orders', fields: Object.values(fields) };

const app: AppSummary = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  kind: 'public',
  slug: 'orders',
  title: 'Orders',
  publicName: 'orders',
  webAddress: null,
  role: 'edit',
  approval: { state: 'approved', approvedBy: member, at: '2026-11-01T00:00:00Z', monthlyLimitUnits: null },
  liveReleaseId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  edgeStatus: 'active',
  stops: { disabledAt: null, editorPausedAt: null, budgetPausedAt: null },
};

const view = (over: Partial<DataView> = {}): DataView => ({
  id: 'd0000000-0000-4000-8000-000000000001',
  tableId: '7a000000-0000-4000-8000-000000000001',
  fieldIds: [fields.number.id],
  predicate: { all: [] },
  actions: ['read'],
  createdBy: member,
  createdAt: '2026-11-01T00:00:00Z',
  sharedBy: member,
  sharedAt: '2026-11-01T00:00:00Z',
  approvedBy: member,
  approvedAt: '2026-11-01T00:00:00Z',
  blockers: [],
  table: orders,
  ...over,
});

test('actions read in a fixed order as a phrase', () => {
  assert.equal(actionPhrase(['read']), 'read');
  assert.equal(actionPhrase(['delete', 'read']), 'read and delete');
  assert.equal(actionPhrase(['update', 'create', 'read']), 'read, create and update');
});

test('a summary names the table, field count, rows and actions', () => {
  assert.equal(viewSummary(view(), orders), 'Orders · 1 field · All rows · Read');
  const ruled = view({
    fieldIds: [fields.number.id, fields.status.id],
    actions: ['update', 'read'],
    predicate: {
      all: [
        { fieldId: fields.status.id, op: 'eq', operand: { kind: 'value', value: shipped } },
        { fieldId: fields.paid.id, op: 'not-null' },
      ],
    },
  });
  assert.equal(viewSummary(ruled, orders), 'Orders · 2 fields · 2 rules · Read and update');
  assert.equal(viewSummary(view({ table: null }), null), 'Unavailable table · 1 field · All rows · Read');
});

test('a gone table or field gets a readable name', () => {
  assert.equal(tableName(null), 'Unavailable table');
  assert.equal(fieldLabel(orders, fields.status.id), 'Status');
  assert.equal(fieldLabel(orders, 'f0000000-0000-4000-8000-000000000009'), 'A removed field');
  assert.equal(fieldLabel(null, fields.status.id), 'A removed field');
});

test('fixed values read as people see them', () => {
  const value = (fieldId: string, value: string | boolean) =>
    valueText(orders, { fieldId, op: 'eq', operand: { kind: 'value', value } });
  assert.equal(value(fields.paid.id, true), 'Yes');
  assert.equal(value(fields.paid.id, false), 'No');
  assert.equal(value(fields.status.id, shipped), 'Shipped');
  assert.equal(value(fields.status.id, 'retired-option'), 'retired-option');
  assert.equal(value(fields.number.id, 'A-100'), 'A-100');
  assert.equal(
    valueText(orders, { fieldId: fields.number.id, op: 'eq', operand: { kind: 'parameter', name: 'n' } }),
    '',
  );
});

test('the first blocker decides the status and its next step', () => {
  assert.deepEqual(viewStatus(view(), app, orders), {
    badge: 'In use',
    tone: 'success',
    sentence: 'The app can use this data view now.',
  });
  assert.deepEqual(viewStatus(view({ blockers: ['not-approved'] }), app, orders), {
    badge: 'Not in use yet',
    tone: 'info',
    sentence: 'Waiting for a workspace admin to approve.',
  });
  assert.deepEqual(viewStatus(view({ sharedBy: null, blockers: ['not-approved'] }), app, orders), {
    badge: 'Not in use',
    tone: 'secondary',
    sentence: 'This view isn’t shared with the app.',
  });
  // Only the first blocker shows, so the reader fixes things in order.
  assert.equal(
    viewStatus(
      view({ blockers: ['app-not-serving', 'not-approved'] }),
      { ...app, approval: { state: 'not-requested' } },
      orders,
    ).sentence,
    'The app isn’t approved as a public app yet.',
  );
});

test('a broken view says so whatever else blocks it, since no other step fixes it', () => {
  const broken = (sentence: string) => ({ badge: 'Not in use', tone: 'warning', sentence });
  // The API lists blockers as app-not-serving, not-approved, view-unresolvable.
  for (const blockers of [
    ['view-unresolvable'],
    ['not-approved', 'view-unresolvable'],
    ['app-not-serving', 'not-approved', 'view-unresolvable'],
  ] as const) {
    assert.deepEqual(
      viewStatus(view({ blockers: [...blockers] }), app, orders),
      broken('Orders changed, and this view no longer matches it. Create a new data view, then stop sharing this one.'),
    );
    assert.deepEqual(
      viewStatus(view({ sharedBy: null, blockers: [...blockers] }), app, orders),
      broken('Orders changed, and this view no longer matches it. Create a new data view to share instead.'),
    );
    assert.deepEqual(
      viewStatus(view({ table: null, blockers: [...blockers] }), app, null),
      broken('The table was deleted. Stop sharing this view, then create a new data view from another table.'),
    );
    assert.deepEqual(
      viewStatus(view({ table: null, sharedBy: null, blockers: [...blockers] }), app, null),
      broken('The table was deleted, so this view can’t be shared. Create a new data view from another table.'),
    );
  }
});

test('an app that is not serving says why', () => {
  const blocked = view({ blockers: ['app-not-serving'] });
  const sentence = (summary: AppSummary) => viewStatus(blocked, summary, orders).sentence;
  const stops = (over: Partial<AppSummary['stops']>) => ({ ...app, stops: { ...app.stops, ...over } });
  assert.equal(sentence(stops({ editorPausedAt: '2026-11-02T00:00:00Z' })), 'Paused by an editor.');
  assert.equal(sentence(stops({ budgetPausedAt: '2026-11-02T00:00:00Z' })), 'Paused: credits used up.');
  assert.equal(sentence(stops({ disabledAt: '2026-11-02T00:00:00Z' })), 'Turned off by an admin.');
  assert.equal(sentence({ ...app, liveReleaseId: null }), 'Not published.');
  assert.equal(sentence(app), 'The app isn’t open to visitors right now.');
});
