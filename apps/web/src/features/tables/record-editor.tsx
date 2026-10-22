import { useState } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@tulipfarm/sprout/sheet';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import { UnsavedChanges } from './feedback';
import { FieldInput } from './field-input';
import { RecordMutationFeedback, useRecordMutation } from './record-mutation';
import { changedValues, compatibleRowValues, rowFieldsChanged, validateRowDraft } from './record-validation';
import { rowLabel } from './definition-view';
import { useWorkspaceMembers } from './hooks';
import { MemberPhoto } from './member-profile';
import { workspaceMemberAccess, workspaceMemberFields } from '@tulipfarm/tables/workspace-members';
import type { TableDataRow, TableDefinition, TableApi, WorkspaceMemberState } from './api';
import type { TableWorkspace } from './references';
import type { TableValues } from './review-contracts';

export function RecordEditor({
  record,
  repair,
  table,
  api,
  workspace,
  disabled,
  close,
  saved,
  refresh,
}: {
  record: TableDataRow | null;
  table: TableDefinition;
  api: TableApi;
  workspace: TableWorkspace;
  repair?: WorkspaceMemberState;
  disabled: boolean;
  close: () => void;
  saved: () => void;
  refresh: () => Promise<void>;
}) {
  const isMember = table.systemKind === 'workspace-members';
  const [recordId] = useState(() => record?.id ?? repair?.id ?? crypto.randomUUID());
  const memberRead = useWorkspaceMembers(workspace.id, table.id, { ids: [recordId] }, isMember && record !== null);
  const member =
    memberRead.state.kind === 'ready' && !memberRead.state.error ? memberRead.state.data.members[0] : undefined;
  const initial: TableValues =
    record?.values ??
    (isMember
      ? {
          [workspaceMemberFields.active]: { kind: 'boolean', value: true },
          [workspaceMemberFields.access]: { kind: 'single-select', optionId: workspaceMemberAccess.none },
        }
      : {});
  const [values, setValues] = useState<TableValues>(initial);
  const [reviewedDefinition, setReviewedDefinition] = useState(table.definition);
  const [reviewRevision, setReviewRevision] = useState<string | null>(null);
  const [validated, setValidated] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const write = useRecordMutation(api, saved);
  const uncertain = write.state.kind === 'uncertain';
  const sending = write.state.kind === 'sending';
  const locked = disabled || sending || uncertain;
  const fieldsChanged = rowFieldsChanged(reviewedDefinition, table.definition);
  const definition = fieldsChanged ? reviewedDefinition : table.definition;
  const nextValues = compatibleRowValues(table.definition, values);
  const cleared = definition.fields.filter(field => values[field.id] != null && !Object.hasOwn(nextValues, field.id));
  const dirty = Object.keys(changedValues(values, initial)).length > 0;
  const errors = validated ? validateRowDraft(definition, values, record?.values, table.systemKind) : {};
  const count = Object.keys(errors).length;
  const dismiss = () => {
    close();
    void refresh();
  };
  const requestClose = () => {
    if (!sending) {
      if (dirty || uncertain) setConfirmClose(true);
      else dismiss();
    }
  };
  function submit() {
    if (locked || fieldsChanged) return;
    setValidated(true);
    if (Object.keys(validateRowDraft(table.definition, values, record?.values, table.systemKind)).length)
      return 'invalid';
    if (record && !dirty) {
      close();
      return;
    }
    const target = { requestId: crypto.randomUUID(), tableId: table.id, revision: table.revision, recordId };
    if (repair) void write.submit({ ...target, kind: 'member-repair', expectedToken: repair.token, values });
    else if (!record)
      void write.submit({
        ...target,
        kind: 'create',
        values: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null)),
      });
    else
      void write.submit({
        ...target,
        kind: 'update',
        expectedToken: record.token,
        values: changedValues(values, initial),
      });
  }
  return (
    <Sheet
      open
      onOpenChange={open => {
        if (!open) requestClose();
      }}
    >
      <SheetContent size="lg" showCloseButton={!sending}>
        <SheetHeader>
          <SheetTitle>
            {repair
              ? 'Complete member'
              : isMember
                ? record
                  ? 'Edit member'
                  : 'Add member'
                : record
                  ? 'Edit row'
                  : 'Add row'}
          </SheetTitle>
          <SheetDescription>
            {table.definition.label}
            {record
              ? `: ${rowLabel(table.definition, record.values, table.systemKind)}`
              : isMember
                ? ': create a person without sending an invitation or granting access.'
                : ': fill in the fields, then save.'}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <UnsavedChanges dirty={dirty || uncertain || sending} />
          {isMember && (
            <div className="mb-5 space-y-3">
              <MemberPhoto
                workspaceId={workspace.id}
                record={record ?? undefined}
                value={values[workspaceMemberFields.photo]}
              />
              <p className="text-sm text-muted-foreground">
                {record
                  ? 'Change a manually managed photo from “Profile and photo” in the row menu. Linked name and photo follow the person’s TulipFarm profile.'
                  : 'Save this member first to add a photo. No account is needed.'}
              </p>
              {record && !member && (
                <div className="flex flex-wrap items-center gap-2">
                  <p
                    role={memberRead.state.kind === 'loading' ? 'status' : 'alert'}
                    className="text-sm text-muted-foreground"
                  >
                    {memberRead.state.kind === 'loading'
                      ? 'Checking profile ownership…'
                      : 'Profile ownership is unavailable. Business fields are still editable.'}
                  </p>
                  <Button variant="outline" size="sm" onClick={() => void memberRead.refresh()}>
                    Check profile ownership
                  </Button>
                </div>
              )}
              <p className="text-sm text-muted-foreground">
                Marking a member inactive blocks new links, not app access. Existing links stay in place.
              </p>
            </div>
          )}
          {fieldsChanged && (
            <Alert>
              <AlertDescription>
                Table fields changed. Your input is kept below. Review the current fields before saving.
                <div className="mt-2">
                  <Button variant="outline" disabled={locked} onClick={() => setReviewRevision(table.revision)}>
                    Review field changes
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
          <Form label={record ? 'Edit row' : 'Add row'} disabled={locked || fieldsChanged} onSubmit={submit}>
            <div className="grid gap-5">
              {definition.fields
                .filter(field => !isMember || field.id !== workspaceMemberFields.photo)
                .map(field => (
                  <FieldInput
                    key={field.id}
                    field={field}
                    value={values[field.id]}
                    error={errors[field.id]}
                    disabled={
                      locked ||
                      fieldsChanged ||
                      (isMember &&
                        (field.id === workspaceMemberFields.accountEmail ||
                          field.id === workspaceMemberFields.access ||
                          (field.id === workspaceMemberFields.name && record !== null && !member?.canEditProfile)))
                    }
                    change={value => setValues(previous => ({ ...previous, [field.id]: value }))}
                    api={api}
                    workspace={workspace}
                    unavailableFileIds={record?.unavailableFileIds ?? []}
                  />
                ))}
              {definition.uniqueKeys.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  Must be unique:{' '}
                  {definition.uniqueKeys
                    .map(key =>
                      key.fieldIds.map(id => definition.fields.find(field => field.id === id)?.label).join(' + '),
                    )
                    .join('; ')}
                  .
                </p>
              )}
              <div className="sticky bottom-0 bg-popover pt-3">
                <FormFooter
                  dirty={dirty}
                  error={count ? `Fix ${count} ${count === 1 ? 'field' : 'fields'} to save the row.` : undefined}
                  submit={{
                    label: record ? 'Save row' : 'Save new row',
                    pendingLabel: record ? 'Saving row…' : 'Saving new row…',
                    state: sending
                      ? { kind: 'busy' }
                      : locked || fieldsChanged
                        ? {
                            kind: 'blocked',
                            reason: uncertain
                              ? 'Check the row request before making more changes.'
                              : fieldsChanged
                                ? 'Review the changed fields before saving.'
                                : 'Reload the table to check your access and current fields.',
                          }
                        : { kind: 'ready' },
                  }}
                >
                  <RecordMutationFeedback mutation={write} refresh={refresh} />
                  {disabled && !sending && !uncertain && (
                    <Button variant="outline" onClick={() => void refresh()}>
                      Reload table
                    </Button>
                  )}
                  <Button variant="outline" disabled={sending} onClick={dismiss}>
                    {uncertain ? 'Close and inspect current rows' : record ? 'Discard edits' : 'Discard new row'}
                  </Button>
                </FormFooter>
              </div>
              <AlertDialog
                open={reviewRevision !== null && fieldsChanged}
                onOpenChange={open => {
                  if (!open) setReviewRevision(null);
                }}
              >
                <AlertDialogContent>
                  <AlertDialogTitle>Use the current fields?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Compatible input stays in your draft. New limits and required fields will be checked before saving.
                    Current fields: {table.definition.fields.map(field => field.label).join(', ')}.
                  </AlertDialogDescription>
                  {cleared.length > 0 && (
                    <p className="text-sm">
                      These inputs no longer fit the current fields and will be cleared only if you continue:{' '}
                      {cleared.map(field => field.label).join(', ')}. Cancel to review or copy your old input.
                    </p>
                  )}
                  {reviewRevision !== table.revision && (
                    <p role="alert" className="text-sm">
                      The fields changed again. Cancel and review the latest change.
                    </p>
                  )}
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep old input</AlertDialogCancel>
                    <AlertDialogAction
                      variant={cleared.length ? 'destructive' : 'default'}
                      disabled={locked || reviewRevision !== table.revision}
                      onClick={() => {
                        if (locked || reviewRevision !== table.revision) return;
                        setValues(nextValues);
                        setReviewedDefinition(table.definition);
                        setValidated(true);
                        setReviewRevision(null);
                      }}
                    >
                      {cleared.length ? 'Clear listed input' : 'Use current fields'}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </Form>
        </div>
        <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
          <AlertDialogContent>
            <AlertDialogTitle>Leave these edits?</AlertDialogTitle>
            <AlertDialogDescription>
              {uncertain
                ? 'The save result is not confirmed. The request can still finish after you close this editor.'
                : 'Your unsaved row changes will be lost.'}
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={dismiss}>
                Leave editor
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}
