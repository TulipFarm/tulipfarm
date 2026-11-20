import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TaskTableError,
  requireTasksDefinition,
  runStateChanged,
  runStateOf,
  runStateOptions,
  taskFields,
} from '@tulipfarm/tables/tasks-table';

const base = { required: false };
const core = {
  formatVersion: 2,
  id: '00000000-0000-4000-8000-000000000001',
  owningTeamId: '00000000-0000-4000-8000-000000000002',
  label: 'Tasks',
  fields: [
    { ...base, id: taskFields.title, label: 'Title', kind: 'text', maxLength: 500 },
    { ...base, id: taskFields.assignee, label: 'Assignee', kind: 'actor', assignee: true },
    {
      ...base,
      id: taskFields.runState,
      label: 'Run state',
      kind: 'single-select',
      options: Object.entries(runStateOptions).map(([label, id]) => ({ id, label, retired: false })),
    },
  ],
  uniqueKeys: [],
};
const registration = { kind: 'tasks', coreDefinition: core };
const errorCode = code => error => error instanceof TaskTableError && error.code === code;

test('Tasks accepts added fields but keeps its own fields, name and single Assignee', () => {
  const added = { ...base, id: '00000000-0000-4000-8000-000000000010', label: 'Sprint', kind: 'text', maxLength: 50 };
  assert.doesNotThrow(() => requireTasksDefinition(registration, { ...core, fields: [...core.fields, added] }));
  assert.throws(
    () => requireTasksDefinition(registration, { ...core, label: 'Todos' }),
    errorCode('tasks-table-protected'),
  );
  assert.throws(
    () => requireTasksDefinition(registration, { ...core, fields: core.fields.slice(1) }),
    errorCode('tasks-field-protected'),
  );
  assert.throws(
    () =>
      requireTasksDefinition(registration, {
        ...core,
        fields: core.fields.map(field => (field.id === taskFields.title ? { ...field, label: 'Name' } : field)),
      }),
    errorCode('tasks-field-protected'),
  );
});

test('Run state changes are detected for every writer but deletes', () => {
  const state = name => ({ [taskFields.runState]: { kind: 'single-select', optionId: runStateOptions[name] } });
  assert.equal(runStateOf(runStateOptions.waiting), 'waiting');
  assert.equal(runStateOf('00000000-0000-4000-8000-000000000099'), null);
  assert.equal(runStateChanged(state('queued'), state('queued')), false);
  assert.equal(runStateChanged(state('queued'), state('done')), true);
  assert.equal(runStateChanged(null, state('working')), true);
  assert.equal(runStateChanged(state('working'), null), false);
});
