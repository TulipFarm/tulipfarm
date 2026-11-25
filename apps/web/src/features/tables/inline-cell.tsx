import { useEffect, useState, type ReactNode } from 'react';
import { EditIcon } from '@tulipfarm/icons';
import { Button } from '@tulipfarm/sprout/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@tulipfarm/sprout/popover';
import { taskFields } from '@tulipfarm/tables/tasks-table';
import { FieldInput } from './field-input';
import { RecordMutationFeedback, useRecordMutation } from './record-mutation';
import { fieldValueIssue, rejectionMessage } from './record-validation';
import type { TableWorkspace } from './references';
import type { TableApi, TableDataRow, TableDefinition } from './api';
import type { TableField, TableValue } from './review-contracts';

/** Only values that fit in one small control are edited in the grid. */
export function inlineEditable(field: TableField, systemKind?: TableDefinition['systemKind']): boolean {
  if (systemKind === 'workspace-members') return false;
  if (systemKind === 'tasks' && field.id === taskFields.runState) return false;
  if (field.kind === 'text') return !field.markdown && field.maxLength <= 255;
  if (field.kind === 'relationship') return field.cardinality === 'one';
  return ['numeric', 'boolean', 'date', 'timestamp', 'single-select', 'multi-select'].includes(field.kind);
}

export function InlineCell({
  field,
  record,
  table,
  api,
  workspace,
  disabled,
  valueView,
  openFull,
  saved,
}: {
  field: TableField;
  record: TableDataRow;
  table: TableDefinition;
  api: TableApi;
  workspace: TableWorkspace;
  disabled: boolean;
  valueView: ReactNode;
  openFull: (element: HTMLElement) => void;
  saved: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [closeLocked, setCloseLocked] = useState(false);
  const current = record.values[field.id] ?? null;
  const editable = inlineEditable(field, table.systemKind);
  if (disabled) return <>{valueView}</>;
  // Long text opens the full row editor; members and protected fields keep their own editors.
  const longText = field.kind === 'text' && (field.markdown || field.maxLength > 255);
  if (!editable && !(longText && table.systemKind !== 'workspace-members')) return <>{valueView}</>;
  // The cell's value stays its accessible name; the column header says which field it is.
  if (!editable)
    return (
      <Button
        variant="ghost"
        size="sm"
        title={`Edit ${field.label} in the full row editor`}
        data-row-control="edit"
        data-row-id={record.id}
        onClick={event => openFull(event.currentTarget)}
      >
        {valueView}
      </Button>
    );
  // A linked row keeps its link to that row, so its edit control sits beside it.
  const linksRows = field.kind === 'relationship';
  const trigger = (
    <PopoverTrigger
      render={
        <Button
          variant="ghost"
          size={linksRows ? 'icon-sm' : 'sm'}
          title={`Edit ${field.label}`}
          aria-label={linksRows ? `Edit ${field.label}` : undefined}
          data-row-control="cell"
          data-row-id={record.id}
        />
      }
    >
      {linksRows ? <EditIcon aria-hidden /> : valueView}
    </PopoverTrigger>
  );
  return (
    <Popover
      open={open}
      onOpenChange={next => {
        if (next || !closeLocked) setOpen(next);
      }}
    >
      {linksRows ? (
        <span className="flex items-center gap-1">
          {valueView}
          {trigger}
        </span>
      ) : (
        trigger
      )}
      {open && (
        <PopoverContent size="panel" align="start">
          <div className="p-3">
            <InlineCellForm
              field={field}
              current={current}
              record={record}
              table={table}
              api={api}
              workspace={workspace}
              lockClose={setCloseLocked}
              close={() => setOpen(false)}
              saved={() => {
                setOpen(false);
                saved(`${field.label} saved.`);
              }}
            />
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
}

function InlineCellForm({
  field,
  current,
  record,
  table,
  api,
  workspace,
  lockClose,
  close,
  saved,
}: {
  field: TableField;
  current: TableValue;
  record: TableDataRow;
  table: TableDefinition;
  api: TableApi;
  workspace: TableWorkspace;
  lockClose: (locked: boolean) => void;
  close: () => void;
  saved: () => void;
}) {
  const [value, setValue] = useState<TableValue>(current);
  const [submitted, setSubmitted] = useState(false);
  const issue = fieldValueIssue(field, value);
  const changed = JSON.stringify(value) !== JSON.stringify(current);
  const mutation = useRecordMutation(api, saved, error =>
    rejectionMessage(table.definition, error, { ...record.values, [field.id]: value }),
  );
  const locked = mutation.locked;
  useEffect(() => {
    lockClose(locked);
    return () => lockClose(false);
  }, [locked, lockClose]);
  const submit = () => {
    setSubmitted(true);
    if (issue || !changed || locked) return;
    void mutation.submit({
      kind: 'update',
      requestId: crypto.randomUUID(),
      tableId: table.id,
      revision: table.revision,
      recordId: record.id,
      expectedToken: record.token,
      values: { [field.id]: value },
    });
  };
  return (
    <div
      className="space-y-3"
      onKeyDown={event => {
        if (
          event.key === 'Enter' &&
          event.target instanceof HTMLInputElement &&
          (field.kind === 'text' || field.kind === 'numeric')
        ) {
          event.preventDefault();
          submit();
        }
      }}
    >
      <PopoverTitle>Edit {field.label}</PopoverTitle>
      <FieldInput
        field={field}
        value={value}
        error={submitted ? (issue ?? undefined) : undefined}
        disabled={locked}
        change={setValue}
        api={api}
        workspace={workspace}
        unavailableFileIds={record.unavailableFileIds}
      />
      <RecordMutationFeedback mutation={mutation} />
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={locked} onClick={close}>
          Cancel
        </Button>
        <Button size="sm" disabled={!changed || locked} onClick={submit}>
          Save
        </Button>
      </div>
    </div>
  );
}
