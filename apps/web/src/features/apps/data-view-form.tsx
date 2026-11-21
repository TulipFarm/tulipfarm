import { useId, useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import { ChoiceGroup, Field, FieldsDisabled } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { AddIcon, DeleteIcon } from '@tulipfarm/icons';
import type { TableDefinition } from '@/features/tables/api';
import { TableRequestError } from '@/features/tables/request-state';
import { utcTimestamp } from '@/features/tables/row-query';
import {
  AppRequestError,
  comparisonOps,
  dataViewActions,
  nullOps,
  type DataViewAction,
  type DataViewComparison,
  type DataViewDraft,
  type RuleOp,
} from './api';
import { actionLabels, comparableKinds, listableKinds, opLabels, type TableField } from './data-access-labels';

const maxFields = 64;
const maxRules = 16;
const parameterName = /^[a-z][a-z0-9_]{0,31}$/;

type Rule = {
  key: number;
  fieldId: string;
  op: RuleOp;
  source: 'value' | 'parameter';
  value: string;
  name: string;
};
type Form = { tableId: string; fieldIds: string[]; rules: Rule[]; actions: DataViewAction[] };
type RuleErrors = { field?: string; value?: string; name?: string };
type Errors = { table?: string; fields?: string; actions?: string; rules: RuleErrors[] };

const emptyForm: Form = { tableId: '', fieldIds: [], rules: [], actions: ['read'] };
const valueless = (op: RuleOp) => (nullOps as readonly RuleOp[]).includes(op);

/**
 * Comparisons this rule may use. Ordering is meaningless for yes/no and choice fields, and a value the app sends may
 * test a field outside the view only for an exact match, or the app could guess hidden values by trying many.
 */
function allowedOps(rule: Rule, field: TableField | undefined, fieldIds: readonly string[]): RuleOp[] {
  if (rule.source === 'parameter' && field && !fieldIds.includes(field.id)) return ['eq'];
  const ordered = field?.kind !== 'boolean' && field?.kind !== 'single-select';
  return [...comparisonOps.filter(op => ordered || op === 'eq' || op === 'ne'), ...nullOps];
}

const effectiveOp = (rule: Rule, field: TableField | undefined, fieldIds: readonly string[]) => {
  const allowed = allowedOps(rule, field, fieldIds);
  return allowed.includes(rule.op) ? rule.op : allowed[0]!;
};

function fixedValue(field: TableField, text: string): string | boolean {
  if (field.kind === 'boolean') return text === 'true';
  if (field.kind === 'timestamp') return utcTimestamp(text);
  return text.trim();
}

/** The request this form describes, or what to fix first. */
function check(form: Form, fields: TableField[]): { draft: DataViewDraft } | { errors: Errors } {
  const errors: Errors = { rules: [] };
  if (!form.tableId) errors.table = 'Choose a table.';
  if (!form.fieldIds.length) errors.fields = 'Choose at least one field.';
  if (!form.actions.length) errors.actions = 'Choose at least one action.';
  else if (!form.actions.includes('read') && form.actions.some(action => action === 'update' || action === 'delete'))
    errors.actions = 'Choose Read rows to allow updating or deleting rows.';
  const all: DataViewComparison[] = [];
  form.rules.forEach((rule, index) => {
    const field = fields.find(entry => entry.id === rule.fieldId);
    const op = effectiveOp(rule, field, form.fieldIds);
    const ruleErrors: RuleErrors = {};
    if (!field) ruleErrors.field = 'Choose a field.';
    else if (op === 'is-null' || op === 'not-null') all.push({ fieldId: field.id, op });
    else if (rule.source === 'parameter') {
      if (!parameterName.test(rule.name))
        ruleErrors.name = 'Start with a letter. Use lowercase letters, numbers and underscores, up to 32 characters.';
      else all.push({ fieldId: field.id, op, operand: { kind: 'parameter', name: rule.name } });
    } else {
      const value = fixedValue(field, rule.value);
      if (value === '') ruleErrors.value = 'Enter a value.';
      else all.push({ fieldId: field.id, op, operand: { kind: 'value', value } });
    }
    errors.rules[index] = ruleErrors;
  });
  const valid =
    !errors.table && !errors.fields && !errors.actions && errors.rules.every(rule => !Object.keys(rule).length);
  if (!valid) return { errors };
  return { draft: { tableId: form.tableId, fieldIds: form.fieldIds, predicate: { all }, actions: form.actions } };
}

/** What a refused create means for the person filling the form. */
function createFailure(error: unknown, draft: DataViewDraft, fields: TableField[]) {
  if (!(error instanceof TableRequestError))
    return 'We couldn’t confirm whether the data view was created. Check the list before trying again.';
  if (error.code === 'definition-invalid') {
    const fieldId = error instanceof AppRequestError ? error.issues[0]?.path : undefined;
    const ranged = draft.predicate.all.some(
      comparison =>
        comparison.fieldId === fieldId &&
        'operand' in comparison &&
        comparison.operand.kind === 'parameter' &&
        comparison.op !== 'eq' &&
        !draft.fieldIds.includes(comparison.fieldId),
    );
    if (ranged)
      return 'A value the app sends can check a field outside this view only with “is”. Other comparisons would let the app work out hidden values by trying many guesses.';
    const label = fields.find(field => field.id === fieldId)?.label ?? 'A field';
    return `${label} can’t be included. A data view can include only fields that hold plain values, such as text, numbers and dates. Files and linked rows aren’t supported.`;
  }
  if (error.code === 'not-found')
    return 'You can’t share this table. You need Manage schema on it, plus Read rows, Create rows, Update rows or Delete rows for each action you allow. Ask a workspace admin for access.';
  if (error.code === 'forbidden')
    return 'You need edit access to this app to share or stop sharing data views. Ask an editor of this app.';
  if (error.code === 'superseded')
    return 'This form was already sent once with different settings, so nothing new was saved. Check the list, then try again.';
  return 'The data view wasn’t created. Your entries are kept. Try again.';
}

export function DataViewForm({
  tables,
  open,
  onOpenChange,
  create,
}: {
  tables: TableDefinition[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves when the view is saved; rejects with the server's refusal. */
  create: (draft: DataViewDraft) => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="form">
        {open && <FormBody tables={tables} close={() => onOpenChange(false)} create={create} />}
      </DialogContent>
    </Dialog>
  );
}

function FormBody({
  tables,
  close,
  create,
}: {
  tables: TableDefinition[];
  close: () => void;
  create: (draft: DataViewDraft) => Promise<void>;
}) {
  const [form, setForm] = useState<Form>(emptyForm);
  const [errors, setErrors] = useState<Errors | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [nextKey, setNextKey] = useState(0);
  const tableId = useId();
  const table = tables.find(entry => entry.id === form.tableId);
  const fields = table?.definition.fields ?? [];
  const listable = fields.filter(field => listableKinds.includes(field.kind));
  const comparable = fields.filter(field => comparableKinds.includes(field.kind));
  const atFieldLimit = form.fieldIds.length >= maxFields;

  const update = (next: Partial<Form>) => setForm(current => ({ ...current, ...next }));
  const updateRule = (key: number, next: Partial<Rule>) =>
    setForm(current => ({
      ...current,
      rules: current.rules.map(rule => (rule.key === key ? { ...rule, ...next } : rule)),
    }));
  const setActions = (next: DataViewAction[]) => {
    const added = next.filter(action => !form.actions.includes(action));
    const needsRead = added.some(action => action === 'update' || action === 'delete');
    update({ actions: needsRead && !next.includes('read') ? [...next, 'read'] : next });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const result = check(form, fields);
    if ('errors' in result) {
      setErrors(result.errors);
      return;
    }
    setErrors(null);
    setFailure(null);
    setPending(true);
    try {
      await create(result.draft);
      close();
    } catch (error) {
      setFailure(createFailure(error, result.draft, fields));
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={event => void submit(event)} noValidate className="contents">
      <DialogHeader>
        <DialogTitle>New data view</DialogTitle>
        <DialogDescription>
          Creating a view doesn’t give the app access. Next, share it with this app and get a workspace admin’s
          approval.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <FieldsDisabled value={pending}>
          <div className="space-y-6">
            <Field label="Table" required id={tableId} helper="The app can use only this table." error={errors?.table}>
              <Select
                value={form.tableId || null}
                onValueChange={next => {
                  if (typeof next === 'string' && next !== form.tableId)
                    update({ tableId: next, fieldIds: [], rules: [] });
                }}
              >
                <SelectTrigger width="full">
                  <SelectValue placeholder="Choose a table">{table?.definition.label}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {tables.map(entry => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.definition.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {table && (
              <ChoiceGroup
                type="checkbox"
                required
                legend="Fields"
                layout="columns"
                helper={
                  atFieldLimit
                    ? 'You can choose up to 64 fields.'
                    : 'Choose 1 to 64 fields. The app can use only these. Fields added to the table later aren’t included.'
                }
                error={errors?.fields}
                value={form.fieldIds}
                onValueChange={next => update({ fieldIds: next.slice(0, maxFields) })}
                options={listable.map(field => ({
                  value: field.id,
                  label: field.label,
                  disabled: atFieldLimit && !form.fieldIds.includes(field.id),
                }))}
              />
            )}
            {table && (
              <fieldset className="space-y-3">
                <legend className="text-sm font-medium">Rows</legend>
                <p className="text-sm text-muted-foreground">
                  Add rules to limit which rows the app can use. A row must match every rule. With no rules, the app can
                  use every row.
                </p>
                {form.rules.map((rule, index) => (
                  <RuleEditor
                    key={rule.key}
                    rule={rule}
                    index={index}
                    fields={comparable}
                    fieldIds={form.fieldIds}
                    errors={errors?.rules[index] ?? {}}
                    change={next => updateRule(rule.key, next)}
                    remove={() => update({ rules: form.rules.filter(entry => entry.key !== rule.key) })}
                  />
                ))}
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending || form.rules.length >= maxRules}
                    onClick={() => {
                      update({
                        rules: [
                          ...form.rules,
                          { key: nextKey, fieldId: '', op: 'eq', source: 'value', value: '', name: '' },
                        ],
                      });
                      setNextKey(nextKey + 1);
                    }}
                  >
                    <AddIcon aria-hidden />
                    Add rule
                  </Button>
                  {form.rules.length >= maxRules && (
                    <p className="text-sm text-muted-foreground">You can add up to 16 rules.</p>
                  )}
                </div>
              </fieldset>
            )}
            <ChoiceGroup
              type="checkbox"
              required
              legend="What the app can do"
              helper="Update and delete also need read."
              error={errors?.actions}
              value={form.actions}
              onValueChange={setActions}
              options={dataViewActions.map(action => ({ value: action, label: actionLabels[action] }))}
            />
            {failure && (
              <Alert variant="destructive">
                <AlertDescription>{failure}</AlertDescription>
              </Alert>
            )}
          </div>
        </FieldsDisabled>
      </DialogBody>
      <DialogFooter>
        <p>You can’t edit a data view after you create it. To change one, create a new view.</p>
        <Button type="button" variant="outline" disabled={pending} onClick={close}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? 'Creating data view…' : 'Create data view'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function RuleEditor({
  rule,
  index,
  fields,
  fieldIds,
  errors,
  change,
  remove,
}: {
  rule: Rule;
  index: number;
  fields: TableField[];
  fieldIds: string[];
  errors: RuleErrors;
  change: (next: Partial<Rule>) => void;
  remove: () => void;
}) {
  const field = fields.find(entry => entry.id === rule.fieldId);
  const op = effectiveOp(rule, field, fieldIds);
  const ops = allowedOps(rule, field, fieldIds);
  const fieldId = useId();
  const opId = useId();
  const n = index + 1;
  return (
    <div role="group" aria-label={`Rule ${n}`} className="space-y-4 rounded-lg border p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Field" required id={fieldId} error={errors.field}>
          <Select
            value={rule.fieldId || null}
            onValueChange={next => {
              if (typeof next === 'string') change({ fieldId: next, value: '' });
            }}
          >
            <SelectTrigger width="full">
              <SelectValue placeholder="Choose a field">{field?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {fields.map(entry => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Comparison" required id={opId}>
          <Select
            value={op}
            onValueChange={next => {
              if (typeof next === 'string') change({ op: next as RuleOp });
            }}
          >
            <SelectTrigger width="full">
              <SelectValue>{opLabels[op]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {ops.map(entry => (
                <SelectItem key={entry} value={entry}>
                  {opLabels[entry]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      {!valueless(op) && (
        <ChoiceGroup
          type="radio"
          required
          legend="Compare with"
          value={rule.source}
          onValueChange={next => change({ source: next })}
          options={[
            { value: 'value', label: 'A fixed value' },
            { value: 'parameter', label: 'A value the app sends' },
          ]}
        />
      )}
      {!valueless(op) && rule.source === 'value' && field && (
        <ValueInput field={field} value={rule.value} error={errors.value} change={value => change({ value })} />
      )}
      {!valueless(op) && rule.source === 'parameter' && (
        <div className="space-y-2">
          <Field
            label="Name the app sends it as"
            required
            helper={
              <>
                The app sends a value under this name with each request, such as <code>email</code>. Use letters,
                numbers and underscores.
              </>
            }
            error={errors.name}
          >
            <Input
              value={rule.name}
              autoComplete="off"
              spellCheck={false}
              onChange={event => change({ name: event.target.value.toLowerCase() })}
            />
          </Field>
          <p className="text-sm text-muted-foreground">
            The app can send any value here, so this rule narrows each request. It doesn’t keep matching rows hidden
            from the app.
          </p>
        </div>
      )}
      <div className="flex justify-end">
        <Button type="button" variant="ghost-destructive" size="sm" aria-label={`Remove rule ${n}`} onClick={remove}>
          <DeleteIcon aria-hidden />
          Remove
        </Button>
      </div>
    </div>
  );
}

function ValueInput({
  field,
  value,
  error,
  change,
}: {
  field: TableField;
  value: string;
  error: string | undefined;
  change: (value: string) => void;
}) {
  const choices =
    field.kind === 'boolean'
      ? [
          { id: 'true', label: 'Yes' },
          { id: 'false', label: 'No' },
        ]
      : field.kind === 'single-select'
        ? field.options.filter(option => !option.retired)
        : null;
  if (choices)
    return (
      <Field label="Value" required error={error}>
        <Select
          value={value || null}
          onValueChange={next => {
            if (typeof next === 'string') change(next);
          }}
        >
          <SelectTrigger width="full">
            <SelectValue placeholder="Choose a value">{choices.find(choice => choice.id === value)?.label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {choices.map(choice => (
              <SelectItem key={choice.id} value={choice.id}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    );
  const type =
    field.kind === 'date'
      ? 'date'
      : field.kind === 'timestamp'
        ? 'datetime-local'
        : field.kind === 'numeric'
          ? 'number'
          : 'text';
  return (
    <Field label="Value" required error={error}>
      <Input type={type} value={value} onChange={event => change(event.target.value)} />
    </Field>
  );
}
