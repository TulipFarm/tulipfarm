import { useMemo, useState } from 'react';
import type { Definition, TableStep } from '@tulipfarm/workflows/contracts';
import { tableApi, type TableDefinition } from '@/features/tables/api';
import { useTablePicker } from '@/features/tables/hooks';
import { Button } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { stepTitle } from './editor-controls';
import { typedLiteral } from './definition-edits';
import { OutputPathControl } from './output-picker';

type Value = Extract<Definition['steps'][number], { kind: 'transform' }>['fields'][string];
type FieldDefinition = TableDefinition['definition']['fields'][number];

const usable = (field: FieldDefinition) => field.kind !== 'file';
const filterable = (field: FieldDefinition) =>
  ['text', 'numeric', 'boolean', 'date', 'timestamp', 'single-select'].includes(field.kind);
const input = (): Value => ({ kind: 'input', path: [] });
const operatorLabels = {
  eq: 'Is',
  ne: 'Is not',
  lt: 'Is less than',
  lte: 'Is at most',
  gt: 'Is greater than',
  gte: 'Is at least',
  'is-null': 'Is empty',
  'not-null': 'Is not empty',
} as const;

/** Shows the typed text while focused, so parsing never rewrites what the person is still typing. */
function TypedInput({
  label,
  shown,
  placeholder,
  onText,
}: {
  label: string;
  shown: string;
  placeholder?: string | undefined;
  onText: (text: string) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <Input
      aria-label={label}
      value={text ?? shown}
      placeholder={placeholder}
      onFocus={() => setText(shown)}
      onBlur={() => setText(null)}
      onChange={event => {
        setText(event.target.value);
        onText(event.target.value);
      }}
    />
  );
}

/** Chooses where a value comes from. Earlier steps are named by position and purpose because their IDs are internal. A typed value keeps numbers and true or false as JSON, for comparisons. */
export function ValueControl({
  id,
  value,
  earlier,
  typed = false,
  onChange,
}: {
  id: string;
  value: Value;
  earlier: Definition['steps'];
  typed?: boolean;
  onChange: (value: Value) => void;
}) {
  const stepName = (stepId: string) => {
    const index = earlier.findIndex(step => step.id === stepId);
    const step = earlier[index];
    return step ? `Output of step ${index + 1} (${stepTitle(step)})` : 'Output of a removed or later step';
  };
  const source = value.kind === 'literal' ? 'literal' : value.kind === 'step' ? `step:${value.step}` : 'input';
  return (
    <div className="flex flex-wrap gap-2">
      <Select
        value={source}
        onValueChange={value => {
          if (!value) return;
          const next = value;
          onChange(
            next === 'literal'
              ? { kind: 'literal', value: '' }
              : next === 'input'
                ? input()
                : { kind: 'step', step: next.slice(5), path: [] },
          );
        }}
      >
        <SelectTrigger aria-label={`Value source for ${id}`}>
          <SelectValue>
            {value.kind === 'literal'
              ? 'Fixed value'
              : value.kind === 'input'
                ? 'Workflow input'
                : stepName(value.step)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="literal">Fixed value</SelectItem>
          <SelectItem value="input">Workflow input</SelectItem>
          {earlier.map(step => (
            <SelectItem key={step.id} value={`step:${step.id}`}>
              {stepName(step.id)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value.kind === 'literal' ? (
        <TypedInput
          label={`Fixed value for ${id}`}
          shown={typeof value.value === 'string' ? value.value : JSON.stringify(value.value)}
          placeholder={typed ? 'Number, true, false, or text' : undefined}
          onText={text => onChange({ kind: 'literal', value: typed ? typedLiteral(text) : text })}
        />
      ) : (
        <OutputPathControl key={source} id={id} value={value} earlier={earlier} onChange={onChange} />
      )}
    </div>
  );
}

export function TableStepControls({
  workspaceId,
  step,
  earlier,
  disabled,
  onChange,
}: {
  workspaceId: string;
  step: TableStep;
  earlier: Definition['steps'];
  disabled: boolean;
  onChange: (step: TableStep) => void;
}) {
  const api = useMemo(() => tableApi(workspaceId), [workspaceId]);
  const read = useTablePicker(api);
  const tables = read.state.kind === 'ready' ? read.state.data : [];
  const table = tables.find(item => item.id === step.tableId);
  const fields = table?.definition.fields ?? [];
  const changeTable = (tableId: string) => {
    const selected = tables.find(item => item.id === tableId);
    if (!selected) return;
    if (step.kind === 'find-rows') onChange({ ...step, tableId, filters: [] });
    else onChange({ ...step, tableId, fields: {} });
  };
  const setFields = (fields: Record<string, Value>) => onChange({ ...step, fields } as TableStep);
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <Field id={`table-${step.id}`} label="Table" required>
        <Select
          value={table ? step.tableId : ''}
          onValueChange={tableId => {
            if (tableId) changeTable(tableId);
          }}
        >
          <SelectTrigger>
            <SelectValue>{table?.definition.label ?? 'Choose a table'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="" disabled>
              Choose a table
            </SelectItem>
            {tables.map(item => (
              <SelectItem key={item.id} value={item.id}>
                {item.definition.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {read.state.kind === 'loading' && <p className="text-sm text-muted-foreground">Loading tables.</p>}
      {read.state.kind === 'error' && (
        <p role="alert">Tables are unavailable. Retry loading the workflow before editing this step.</p>
      )}
      {table && step.kind === 'find-rows' && (
        <div className="space-y-2">
          <Field id={`find-field-${step.id}`} label="Add filter field" optional>
            <Select
              value=""
              onValueChange={value => {
                const fieldId = value ?? '';
                if (fieldId) onChange({ ...step, filters: [...step.filters, { fieldId, op: 'eq', value: input() }] });
              }}
            >
              <SelectTrigger>
                <SelectValue>Choose a field</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Choose a field</SelectItem>
                {fields
                  .filter(filterable)
                  .filter(field => !step.filters.some(filter => filter.fieldId === field.id))
                  .map(field => (
                    <SelectItem key={field.id} value={field.id}>
                      {field.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>
          {step.filters.map((filter, index) => (
            <div key={filter.fieldId} className="space-y-2">
              <p className="text-sm font-medium">
                {fields.find(field => field.id === filter.fieldId)?.label ?? 'Unavailable field'}
              </p>
              <Select
                value={filter.op}
                onValueChange={value => {
                  if (value)
                    onChange({
                      ...step,
                      filters: step.filters.map((item, position) =>
                        position === index && 'value' in item
                          ? { ...item, op: value as Exclude<typeof item.op, 'is-null' | 'not-null'> }
                          : item,
                      ) as typeof step.filters,
                    });
                }}
              >
                <SelectTrigger
                  aria-label={`Filter operator for ${fields.find(field => field.id === filter.fieldId)?.label ?? 'unavailable field'}`}
                >
                  <SelectValue>{operatorLabels[filter.op]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(fields.find(field => field.id === filter.fieldId)?.kind === 'single-select'
                    ? ['eq', 'ne']
                    : ['eq', 'ne', 'lt', 'lte', 'gt', 'gte']
                  ).map(op => (
                    <SelectItem key={op} value={op}>
                      {operatorLabels[op as keyof typeof operatorLabels]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {'value' in filter && (
                <ValueControl
                  id={`filter-${filter.fieldId}`}
                  value={filter.value}
                  earlier={earlier}
                  onChange={value =>
                    onChange({
                      ...step,
                      filters: step.filters.map((item, position) =>
                        position === index && 'value' in item ? { ...item, value } : item,
                      ),
                    })
                  }
                />
              )}
              <Button
                variant="outline"
                onClick={() => onChange({ ...step, filters: step.filters.filter((_, position) => position !== index) })}
              >
                Remove filter
              </Button>
            </div>
          ))}
        </div>
      )}
      {table && step.kind !== 'find-rows' && (
        <div className="space-y-2">
          <Field id={`row-field-${step.id}`} label="Add mapped field" optional>
            <Select
              value=""
              onValueChange={value => {
                const fieldId = value ?? '';
                if (fieldId) setFields({ ...step.fields, [fieldId]: input() });
              }}
            >
              <SelectTrigger>
                <SelectValue>Choose a field</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Choose a field</SelectItem>
                {fields
                  .filter(usable)
                  .filter(field => !(field.id in step.fields))
                  .map(field => (
                    <SelectItem key={field.id} value={field.id}>
                      {field.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>
          {Object.entries(step.fields).map(([fieldId, value]) => (
            <div key={fieldId} className="space-y-2">
              <p className="text-sm font-medium">
                {fields.find(field => field.id === fieldId)?.label ?? 'Unavailable field'}
              </p>
              <ValueControl
                id={fieldId}
                value={value}
                earlier={earlier}
                onChange={next => setFields({ ...step.fields, [fieldId]: next })}
              />
              <Button
                variant="outline"
                onClick={() =>
                  setFields(Object.fromEntries(Object.entries(step.fields).filter(([id]) => id !== fieldId)))
                }
              >
                Remove field
              </Button>
            </div>
          ))}
          {step.kind === 'update-row' && (
            <Field id={`row-source-${step.id}`} label="Row to update" required>
              <ValueControl
                id={`row-${step.id}`}
                value={step.row}
                earlier={earlier}
                onChange={row => onChange({ ...step, row })}
              />
            </Field>
          )}
        </div>
      )}
    </fieldset>
  );
}
