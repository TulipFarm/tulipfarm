import assert from 'node:assert/strict';
import test from 'node:test';
import { definitionSchema, validateRecord, valuesSchema } from '@tulipfarm/tables/definition';
import { recordLabel } from '@tulipfarm/tables/query';
import {
  addedMemberReferences,
  manualWorkspaceMemberValues,
  requireWorkspaceMembersDefinition,
  workspaceMemberAccess,
  workspaceMemberFields,
  workspaceMemberRestoredValues,
  workspaceMembersDefinition,
} from '@tulipfarm/tables/workspace-members';

const tableId = '00000000-0000-4000-8000-000000000001';
const teamId = '00000000-0000-4000-8000-000000000002';
const memberId = '00000000-0000-4000-8000-000000000003';
const otherMemberId = '00000000-0000-4000-8000-000000000004';
const customFieldId = '00000000-0000-4000-8000-000000000005';
const otherFieldId = '00000000-0000-4000-8000-000000000006';
const definition = workspaceMembersDefinition(tableId, teamId);
const registration = { kind: 'workspace-members', coreDefinition: definition };
const reference = (...recordIds) => ({ kind: 'relationship', tableId, recordIds });
const protectedField = error => error.code === 'member-field-protected';

test('member contracts also load through native Node TypeScript imports', async () => {
  const { WorkspaceMemberError } = await import('../src/workspace-members.ts');
  const error = new WorkspaceMemberError('member-profile-pending');
  assert.equal(error.code, 'member-profile-pending');
  assert.equal(error.status, 503);
});

test('member core fields are normal table fields without authentication credentials or access identities', () => {
  assert.deepEqual(definitionSchema.parse(definition), definition);
  const values = manualWorkspaceMemberValues({ name: '  Ada  ', contactEmail: 'ada@example.com' });
  assert.deepEqual(validateRecord(definition, values), values);
  assert.deepEqual(values[workspaceMemberFields.name], { kind: 'text', value: 'Ada' });
  assert.deepEqual(values[workspaceMemberFields.active], { kind: 'boolean', value: true });
  assert.deepEqual(values[workspaceMemberFields.access], {
    kind: 'single-select',
    optionId: workspaceMemberAccess.none,
  });
  assert.equal(values[workspaceMemberFields.accountEmail], null);
  assert.equal(Object.keys(values).length, 6);
  assert.throws(() => manualWorkspaceMemberValues({ name: ' ' }));
  assert.throws(() => manualWorkspaceMemberValues({ name: 'Ada', contactEmail: 'not-email' }));
});

test('custom columns and their own unique keys do not change the protected core', () => {
  const extended = definitionSchema.parse({
    ...definition,
    fields: [...definition.fields]
      .reverse()
      .concat({ id: customFieldId, label: 'Workday ID', kind: 'text', required: false, maxLength: 80 }),
    uniqueKeys: [{ id: otherFieldId, fieldIds: [customFieldId], nulls: 'distinct' }],
  });
  assert.doesNotThrow(() => requireWorkspaceMembersDefinition(registration, extended));
  for (const change of [{ id: memberId }, { owningTeamId: memberId }, { label: 'People' }]) {
    assert.throws(
      () => requireWorkspaceMembersDefinition(registration, { ...definition, ...change }),
      error => error.code === 'member-table-protected',
    );
  }
});

test('core fields cannot be removed, relabeled, retyped, made optional, or constrained by unique keys', () => {
  for (const field of definition.fields) {
    assert.throws(
      () =>
        requireWorkspaceMembersDefinition(registration, {
          ...definition,
          fields: definition.fields.filter(candidate => candidate.id !== field.id),
        }),
      protectedField,
    );
    for (const replacement of [
      { ...field, label: 'Changed' },
      { ...field, required: !field.required },
      { id: field.id, label: field.label, required: field.required, kind: 'date' },
    ])
      assert.throws(
        () =>
          requireWorkspaceMembersDefinition(registration, {
            ...definition,
            fields: definition.fields.map(candidate => (candidate.id === field.id ? replacement : candidate)),
          }),
        protectedField,
      );
    assert.throws(
      () =>
        requireWorkspaceMembersDefinition(registration, {
          ...definition,
          uniqueKeys: [{ id: otherFieldId, fieldIds: [field.id], nulls: 'distinct' }],
        }),
      protectedField,
    );
  }
});

test('member-link checks consider additions per field, not retained or removed references', () => {
  const before = valuesSchema.parse({ [customFieldId]: reference(memberId) });
  assert.deepEqual(addedMemberReferences(tableId, before, before), []);
  assert.deepEqual(addedMemberReferences(tableId, before, null), []);
  assert.deepEqual(addedMemberReferences(tableId, before, valuesSchema.parse({ [customFieldId]: reference() })), []);
  assert.deepEqual(
    addedMemberReferences(tableId, before, valuesSchema.parse({ [customFieldId]: reference(memberId, otherMemberId) })),
    [{ fieldId: customFieldId, tableId, memberId: otherMemberId }],
  );
  assert.deepEqual(
    addedMemberReferences(tableId, before, valuesSchema.parse({ [otherFieldId]: reference(memberId) })),
    [{ fieldId: otherFieldId, tableId, memberId }],
  );
  assert.deepEqual(addedMemberReferences(tableId, null, before), [{ fieldId: customFieldId, tableId, memberId }]);
  assert.deepEqual(addedMemberReferences(teamId, null, before), []);
});

test('registered member labels use names, fallbacks and activity rather than photo references', () => {
  const values = {
    ...manualWorkspaceMemberValues({ name: 'Ada', contactEmail: 'business@example.test' }),
    [workspaceMemberFields.photo]: {
      kind: 'text',
      value: '/v1/workspaces/example/workspace-members/example/photos/example',
    },
  };
  assert.equal(recordLabel(definition, values, 'workspace-members'), 'Ada');
  assert.match(
    recordLabel(definition, values),
    /photos\/example/,
    'A matching table label alone is not system registration',
  );
  values[workspaceMemberFields.active] = { kind: 'boolean', value: false };
  assert.equal(recordLabel(definition, values, 'workspace-members'), 'Ada (inactive)');
  values[workspaceMemberFields.name] = { kind: 'text', value: '' };
  assert.equal(recordLabel(definition, values, 'workspace-members'), 'business@example.test (inactive)');
});

test('member restore keeps current account fields and only restores editable profile fields', () => {
  const historical = {
    ...manualWorkspaceMemberValues({ name: 'Old name', contactEmail: 'old@example.test' }),
    [workspaceMemberFields.photo]: { kind: 'text', value: 'old-photo' },
    [workspaceMemberFields.accountEmail]: { kind: 'text', value: 'old-account@example.test' },
    [workspaceMemberFields.access]: { kind: 'single-select', optionId: workspaceMemberAccess.active },
    [customFieldId]: { kind: 'text', value: 'OLD-ID' },
  };
  const current = {
    ...manualWorkspaceMemberValues({ name: 'Current name' }),
    [workspaceMemberFields.photo]: { kind: 'text', value: 'current-photo' },
    [workspaceMemberFields.accountEmail]: { kind: 'text', value: 'current-account@example.test' },
    [workspaceMemberFields.access]: { kind: 'single-select', optionId: workspaceMemberAccess.invited },
    [customFieldId]: { kind: 'text', value: 'NEW-ID' },
  };
  const linked = workspaceMemberRestoredValues(historical, current, true);
  for (const field of ['name', 'photo', 'accountEmail', 'access'])
    assert.deepEqual(linked[workspaceMemberFields[field]], current[workspaceMemberFields[field]]);
  assert.deepEqual(linked[customFieldId], historical[customFieldId]);
  assert.deepEqual(linked[workspaceMemberFields.contactEmail], historical[workspaceMemberFields.contactEmail]);
  const manual = workspaceMemberRestoredValues(historical, current, false);
  for (const field of ['name', 'photo'])
    assert.deepEqual(manual[workspaceMemberFields[field]], historical[workspaceMemberFields[field]]);
  for (const field of ['accountEmail', 'access'])
    assert.deepEqual(manual[workspaceMemberFields[field]], current[workspaceMemberFields[field]]);
  const deleted = workspaceMemberRestoredValues(historical, null, false);
  assert.equal(deleted[workspaceMemberFields.accountEmail], null);
  assert.deepEqual(deleted[workspaceMemberFields.access], {
    kind: 'single-select',
    optionId: workspaceMemberAccess.none,
  });
  assert.deepEqual(historical[customFieldId], { kind: 'text', value: 'OLD-ID' });
  assert.deepEqual(current[customFieldId], { kind: 'text', value: 'NEW-ID' });
});
