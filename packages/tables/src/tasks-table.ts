import { z } from 'zod';
import {
  definitionSchema,
  fieldIdSchema,
  optionIdSchema,
  type TableDefinition,
  type TableValues,
} from './definition.ts';
type FieldId = z.infer<typeof fieldIdSchema>;

/** The built-in Tasks table's locked fields. Their IDs are the same in every workspace. */
export const taskFields = Object.freeze({
  title: fieldIdSchema.parse('5b1d3c2e-7f40-4a8e-9c61-2d0a7e4b5101'),
  description: fieldIdSchema.parse('5b1d3c2e-7f40-4a8e-9c61-2d0a7e4b5102'),
  assignee: fieldIdSchema.parse('5b1d3c2e-7f40-4a8e-9c61-2d0a7e4b5103'),
  reporter: fieldIdSchema.parse('5b1d3c2e-7f40-4a8e-9c61-2d0a7e4b5104'),
  runState: fieldIdSchema.parse('5b1d3c2e-7f40-4a8e-9c61-2d0a7e4b5105'),
  parent: fieldIdSchema.parse('5b1d3c2e-7f40-4a8e-9c61-2d0a7e4b5106'),
});

export const runStates = ['queued', 'working', 'waiting', 'done', 'failed'] as const;
export type RunState = (typeof runStates)[number];
/** Run state option IDs. Only the assignment service writes them. */
export const runStateOptions: Readonly<Record<RunState, z.infer<typeof optionIdSchema>>> = Object.freeze({
  queued: optionIdSchema.parse('6c2e4d3f-8a51-4b9f-8d72-3e1b8f5c6201'),
  working: optionIdSchema.parse('6c2e4d3f-8a51-4b9f-8d72-3e1b8f5c6202'),
  waiting: optionIdSchema.parse('6c2e4d3f-8a51-4b9f-8d72-3e1b8f5c6203'),
  done: optionIdSchema.parse('6c2e4d3f-8a51-4b9f-8d72-3e1b8f5c6204'),
  failed: optionIdSchema.parse('6c2e4d3f-8a51-4b9f-8d72-3e1b8f5c6205'),
});
export const runStateOf = (optionId: string | undefined): RunState | null =>
  runStates.find(state => runStateOptions[state] === optionId) ?? null;

export const tasksRegistrationSchema = z.strictObject({ kind: z.literal('tasks'), coreDefinition: definitionSchema });
export type TasksRegistration = z.infer<typeof tasksRegistrationSchema>;

export const taskErrorCodeSchema = z.enum([
  'tasks-table-protected',
  'tasks-field-protected',
  'run-state-protected',
  'parent-cycle',
  'assignment-protected',
  'tasks-unavailable',
]);
export type TaskErrorCode = z.infer<typeof taskErrorCodeSchema>;
export class TaskTableError extends Error {
  readonly code: TaskErrorCode;
  readonly status: 409 | 503;
  constructor(code: TaskErrorCode) {
    super(code);
    this.code = code;
    this.name = 'TaskTableError';
    this.status = code === 'tasks-unavailable' ? 503 : 409;
  }
}

/** People may add fields to Tasks, but its own fields, name and owner stay as shipped. */
export function requireTasksDefinition(registration: TasksRegistration, input: TableDefinition) {
  const core = definitionSchema.parse(registration.coreDefinition);
  const next = definitionSchema.parse(input);
  if (core.id !== next.id || core.owningTeamId !== next.owningTeamId || core.label !== next.label)
    throw new TaskTableError('tasks-table-protected');
  for (const field of core.fields)
    if (JSON.stringify(field) !== JSON.stringify(next.fields.find(candidate => candidate.id === field.id)))
      throw new TaskTableError('tasks-field-protected');
  if (next.fields.some(field => field.kind === 'actor' && field.assignee && field.id !== taskFields.assignee))
    throw new TaskTableError('tasks-field-protected');
}

const optionOf = (values: TableValues | null, fieldId: FieldId) => {
  const value = values?.[fieldId];
  return value?.kind === 'single-select' ? value.optionId : undefined;
};

/** Run state belongs to the assignment service; every other writer must leave it as it was. */
export function runStateChanged(before: TableValues | null, values: TableValues | null) {
  if (values === null) return false;
  return optionOf(before, taskFields.runState) !== optionOf(values, taskFields.runState);
}
