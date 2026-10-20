import type { Definition, Step, valueSchema } from './contracts.ts';
import type { z } from 'zod';

type Value = z.infer<typeof valueSchema>;
export type OutputShape =
  | { kind: 'unknown' | 'scalar' }
  | { kind: 'object'; fields: Record<string, OutputShape>; labels?: Record<string, string> }
  | { kind: 'array'; item: OutputShape }
  | { kind: 'record'; item: OutputShape };
export type OutputTable = { id: string; fields: readonly { id: string; label: string; kind: string }[] };
export type OutputChoice = { path: string[]; label: string; hint: boolean };
const unknown: OutputShape = { kind: 'unknown' };
const scalar: OutputShape = { kind: 'scalar' };
const object = (fields: Record<string, OutputShape>): OutputShape => ({ kind: 'object', fields });
const array = (item: OutputShape): OutputShape => ({ kind: 'array', item });

export function stepValueEntries(step: Step): { value: Value; path: (string | number)[] }[] {
  const entries = (field: 'fields' | 'headers', values: Record<string, Value>) =>
    Object.entries(values).map(([key, value]) => ({ value, path: [field, key] }));
  switch (step.kind) {
    case 'transform':
    case 'create-row':
      return entries('fields', step.fields);
    case 'update-row':
      return [{ value: step.row, path: ['row'] }, ...entries('fields', step.fields)];
    case 'code':
      return [{ value: step.input, path: ['input'] }];
    case 'agent':
      return [{ value: step.prompt, path: ['prompt'] }];
    case 'slack-message':
      return [{ value: step.text, path: ['text'] }];
    case 'http':
      return [...entries('headers', step.headers), ...(step.body ? [{ value: step.body, path: ['body'] }] : [])];
    case 'wait-until':
      return [{ value: step.at, path: ['at'] }];
    case 'find-rows':
      return step.filters.flatMap((filter, index) =>
        'value' in filter ? [{ value: filter.value, path: ['filters', index, 'value'] }] : [],
      );
    case 'condition':
      return [
        { value: step.when.left, path: ['when', 'left'] },
        ...('right' in step.when ? [{ value: step.when.right, path: ['when', 'right'] }] : []),
      ];
    case 'delay':
    case 'human':
      return [];
  }
}

/** Undefined means impossible; unknown means the runtime alone can decide. */
export function outputAt(shape: OutputShape, path: readonly string[]): OutputShape | undefined {
  let current: OutputShape | undefined = shape;
  for (const part of path) {
    if (!current || current.kind === 'unknown') return current;
    switch (current.kind) {
      case 'scalar':
        return undefined;
      case 'object':
        current = Object.hasOwn(current.fields, part) ? current.fields[part] : undefined;
        break;
      case 'record':
        current = current.item;
        break;
      case 'array':
        current = part === 'length' ? scalar : /^(0|[1-9]\d*)$/.test(part) ? current.item : undefined;
        break;
    }
  }
  return current;
}

function literalShape(value: unknown, depth = 0): OutputShape {
  if (depth >= 16) return unknown;
  // Arrays can contain unlike items; their contents are not a uniform schema.
  if (Array.isArray(value)) return array(unknown);
  if (value !== null && typeof value === 'object')
    return object(
      Object.fromEntries(Object.entries(value).map(([key, child]) => [key, literalShape(child, depth + 1)])),
    );
  return scalar;
}

function tableValueShape(kind: string): OutputShape {
  switch (kind) {
    case 'single-select':
      return object({ kind: scalar, optionId: scalar });
    case 'multi-select':
      return object({ kind: scalar, optionIds: array(scalar) });
    case 'relationship':
      return object({ kind: scalar, tableId: scalar, recordIds: array(scalar) });
    case 'text':
    case 'numeric':
    case 'boolean':
    case 'date':
    case 'timestamp':
      return object({ kind: scalar, value: scalar });
    default:
      return unknown;
  }
}

/** Describes successful receipts, not waiting receipts or examples from a run. */
export function stepOutputShapes(steps: readonly Step[], tables: readonly OutputTable[] = []) {
  const outputs = new Map<string, OutputShape>();
  const valueShape = (value: Value) =>
    value.kind === 'literal'
      ? literalShape(value.value)
      : value.kind === 'input'
        ? unknown
        : (outputAt(outputs.get(value.step) ?? unknown, value.path) ?? unknown);
  for (const step of steps) {
    let shape: OutputShape;
    switch (step.kind) {
      case 'transform':
        shape = object(Object.fromEntries(Object.entries(step.fields).map(([key, value]) => [key, valueShape(value)])));
        break;
      case 'human':
      case 'code':
        shape = unknown;
        break;
      case 'delay':
      case 'wait-until':
        shape = scalar;
        break;
      case 'http':
        shape = object({ status: scalar, headers: { kind: 'record', item: scalar }, body: scalar });
        break;
      case 'condition':
        shape = object({ matched: scalar, ran: array(scalar), skipped: array(scalar) });
        break;
      case 'agent':
        shape = object({ taskId: scalar, result: scalar });
        break;
      case 'slack-message':
        shape = object({ provider: scalar, actionId: scalar, status: scalar, sentMessageTs: scalar });
        break;
      case 'create-row':
      case 'update-row':
        shape = object({
          operation: scalar,
          tableId: scalar,
          recordId: scalar,
          token: scalar,
          fieldIds: array(scalar),
        });
        break;
      case 'find-rows': {
        const table = tables.find(table => table.id === step.tableId);
        const fields = table?.fields.filter(field => field.kind !== 'file');
        const values: OutputShape = fields
          ? {
              kind: 'object',
              fields: Object.fromEntries(fields.map(field => [field.id, tableValueShape(field.kind)])),
              labels: Object.fromEntries(fields.map(field => [field.id, field.label])),
            }
          : { kind: 'record', item: unknown };
        shape = object({
          tableId: scalar,
          rows: array(object({ recordId: scalar, token: scalar, values })),
          more: scalar,
        });
        break;
      }
    }
    outputs.set(step.id, shape);
  }
  return outputs;
}

export function outputPathIssues(definition: Definition, tables: readonly OutputTable[] = []) {
  const outputs = stepOutputShapes(definition.steps, tables);
  return definition.steps.flatMap((step, index) =>
    stepValueEntries(step).flatMap(({ value, path }) => {
      if (value.kind !== 'step') return [];
      const shape = outputs.get(value.step);
      if (!shape || outputAt(shape, value.path)) return [];
      return [
        {
          code: 'custom' as const,
          path: ['steps', index, ...path, 'path'],
          message: `Step "${step.id}" reads step "${value.step}", but field ${JSON.stringify(value.path)} is not available. Choose an available output field.`,
          params: { workflowOutputPath: true },
        },
      ];
    }),
  );
}

export function outputChoices(shape: OutputShape): OutputChoice[] {
  const choices: OutputChoice[] = [{ path: [], label: 'Whole output', hint: false }];
  const visit = (node: OutputShape, path: string[], labels: string[]) => {
    if (path.length >= 16 || choices.length >= 128) return;
    const children =
      node.kind === 'object'
        ? Object.entries(node.fields)
        : node.kind === 'array'
          ? ([
              ['0', node.item],
              ['length', scalar],
            ] as const)
          : [];
    for (const [key, child] of children) {
      if (key.length > 100 || choices.length >= 128) continue;
      const next = [...path, key],
        names = [
          ...labels,
          node.kind === 'object' ? (node.labels?.[key] ?? key) : key === '0' ? 'First item (0)' : key,
        ];
      choices.push({ path: next, label: names.join(' / '), hint: false });
      visit(child, next, names);
    }
  };
  visit(shape, [], []);
  return choices;
}

type SampleRun = { revision: string; status: string; steps: { stepId: string; status: string; output: unknown }[] };
function pathLabel(shape: OutputShape, path: string[]) {
  return path
    .map((part, index) => {
      const parent = outputAt(shape, path.slice(0, index));
      if (parent?.kind === 'object') return parent.labels?.[part] ?? part;
      if (parent?.kind === 'array' && /^(0|[1-9]\d*)$/.test(part)) return `Item ${Number(part) + 1} (${part})`;
      return part;
    })
    .join(' / ');
}

export function sampledOutputChoices(
  shape: OutputShape,
  stepId: string,
  revision: string | null,
  runs: readonly SampleRun[],
): OutputChoice[] {
  const choices = new Map<string, OutputChoice>();
  const known = new Set(outputChoices(shape).map(choice => JSON.stringify(choice.path)));
  const visit = (value: unknown, path: string[]) => {
    if (path.length >= 16 || choices.size >= 128 || value === null || typeof value !== 'object') return;
    if ('withheld' in value && value.withheld === 'source-access') return;
    for (const [key, child] of Object.entries(value)) {
      if (key.length > 100 || choices.size >= 128) continue;
      const next = [...path, key],
        encoded = JSON.stringify(next);
      if (!outputAt(shape, next)) continue;
      if (!known.has(encoded))
        choices.set(encoded, { path: next, label: `${pathLabel(shape, next)} (run hint)`, hint: true });
      visit(child, next);
    }
  };
  for (const run of runs)
    if (revision !== null && run.revision === revision && run.status === 'completed') {
      for (const receipt of run.steps)
        if (receipt.stepId === stepId && receipt.status === 'completed') visit(receipt.output, []);
    }
  return [...choices.values()];
}
