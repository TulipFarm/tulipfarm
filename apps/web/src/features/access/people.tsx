import { useState, type ReactNode } from 'react';
import { EntityAvatar } from '@tulipfarm/sprout/avatar';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@tulipfarm/sprout/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@tulipfarm/sprout/dialog';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import {
  workspaceMemberAccess,
  workspaceMemberFields,
  workspaceMemberLabel,
} from '@tulipfarm/tables/workspace-members';
import { AvatarImagePicker } from '@/features/avatar/image-picker';
import type { TableApi, TableDataRow } from '@/features/tables/api';
import { useTableChanges } from '@/features/tables/changes';
import { TableRead } from '@/features/tables/feedback';
import { FieldInput } from '@/features/tables/field-input';
import { useLinkedRows, useTableRow, useWorkspaceMembers, type MembersTable } from '@/features/tables/hooks';
import { memberPhotoSource } from '@/features/tables/member-profile';
import { RecordEditor } from '@/features/tables/record-editor';
import { RecordMutationFeedback, useRecordMutation } from '@/features/tables/record-mutation';
import { rejectionMessage, validateRowDraft } from '@/features/tables/record-validation';
import { fileIdsOf, TableValueView, useFileNames, type TableWorkspace } from '@/features/tables/references';
import { TableRequestError } from '@/features/tables/request-state';
import type { TableValues } from '@/features/tables/review-contracts';

const coreFields: readonly string[] = Object.values(workspaceMemberFields);
// The dialog asks only for what a person without an account needs; the server keeps the rest.
const hiddenOnAdd: readonly string[] = [
  workspaceMemberFields.photo,
  workspaceMemberFields.accountEmail,
  workspaceMemberFields.active,
  workspaceMemberFields.access,
];

export const memberText = (values: TableValues, fieldId: string) => {
  const value = values[fieldId];
  return value?.kind === 'text' ? value.value.trim() : '';
};
export const memberInactive = (values: TableValues) => {
  const value = values[workspaceMemberFields.active];
  return value?.kind === 'boolean' && value.value === false;
};
export const memberName = (values: TableValues) =>
  memberText(values, workspaceMemberFields.name) ||
  memberText(values, workspaceMemberFields.contactEmail) ||
  memberText(values, workspaceMemberFields.accountEmail) ||
  'Unnamed person';

/** Deletes one hand-added person's Members row; resolves to the reason it failed, or null. */
export function useRemovePerson(api: TableApi, members: MembersTable | null) {
  const changes = useTableChanges();
  return async (row: TableDataRow): Promise<string | null> => {
    if (!members) return 'Members is still loading. Try again in a moment.';
    try {
      await api.mutate({
        kind: 'delete',
        requestId: crypto.randomUUID(),
        tableId: members.table.id,
        revision: members.table.revision,
        recordId: row.id,
        expectedToken: row.token,
      });
      await changes.records(members.table.id);
      return null;
    } catch (error) {
      void changes.records(members.table.id);
      return error instanceof TableRequestError
        ? error.message
        : 'We couldn’t confirm the removal. Close this and check the list before trying again.';
    }
  };
}

/** Adds someone without an account: a Members row with a name, a contact email and an optional photo. */
export function AddPersonDialog({
  workspace,
  api,
  members,
  close,
  added,
}: {
  workspace: TableWorkspace;
  api: TableApi;
  members: MembersTable;
  close: () => void;
  /** `photoSaved` is false when the person was added but their photo wasn't. */
  added: (name: string, photoSaved: boolean) => void;
}) {
  const { table } = members;
  const changes = useTableChanges();
  const [recordId] = useState(() => crypto.randomUUID());
  // Kept across retries after an unconfirmed save, so trying again never adds the person twice.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [values, setValues] = useState<TableValues>({
    [workspaceMemberFields.active]: { kind: 'boolean', value: true },
    [workspaceMemberFields.access]: { kind: 'single-select', optionId: workspaceMemberAccess.none },
  });
  const [image, setImage] = useState<string | null>(null);
  const [validated, setValidated] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState('');
  const name = memberText(values, workspaceMemberFields.name);
  const errors = validated ? validateRowDraft(table.definition, values, undefined, 'workspace-members') : {};
  const count = Object.keys(errors).length;
  const dirty = !!name || !!memberText(values, workspaceMemberFields.contactEmail) || image !== null;
  async function save() {
    setSending(true);
    setFailure('');
    const target = { tableId: table.id, revision: table.revision, recordId };
    try {
      const created = await api.mutate({
        ...target,
        requestId,
        kind: 'create',
        values: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null)),
      });
      let photoSaved = true;
      if (image)
        try {
          await api.mutate({
            ...target,
            requestId: crypto.randomUUID(),
            kind: 'member-photo',
            expectedToken: created.token,
            image,
          });
        } catch {
          photoSaved = false;
        }
      await changes.records(table.id);
      added(name, photoSaved);
    } catch (error) {
      if (error instanceof TableRequestError && error.status >= 400 && error.status < 500) {
        setRequestId(crypto.randomUUID());
        setFailure(rejectionMessage(table.definition, error, values) ?? error.message);
      } else setFailure('We couldn’t confirm this person was added. Try again. It won’t add them twice.');
      setSending(false);
    }
  }
  function submit() {
    if (sending) return;
    setValidated(true);
    if (Object.keys(validateRowDraft(table.definition, values, undefined, 'workspace-members')).length)
      return 'invalid';
    void save();
  }
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open && !sending) close();
      }}
    >
      <DialogContent size="split" showCloseButton={!sending}>
        <DialogHeader>
          <DialogTitle>Add person</DialogTitle>
          <DialogDescription>
            Add someone who doesn’t have an account. They won’t get an invite or any access.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 px-4 pb-4">
          <Form label="Add person" disabled={sending} onSubmit={submit}>
            <div className="grid gap-5">
              <section aria-label="Photo" className="space-y-2">
                <h3 className="text-sm font-medium">Photo</h3>
                <AvatarImagePicker
                  seed={recordId}
                  name={name || 'New person'}
                  image={image}
                  shape="circle"
                  disabled={sending}
                  onChange={setImage}
                />
                <p className="text-sm text-muted-foreground">Optional. PNG, JPEG or WebP, up to 2 MB.</p>
              </section>
              {table.definition.fields
                .filter(field => !hiddenOnAdd.includes(field.id))
                .map(field => (
                  <FieldInput
                    key={field.id}
                    field={field}
                    value={values[field.id]}
                    error={errors[field.id]}
                    disabled={sending}
                    change={value => setValues(previous => ({ ...previous, [field.id]: value }))}
                    api={api}
                    workspace={workspace}
                    unavailableFileIds={[]}
                  />
                ))}
              <FormFooter
                layout="compact"
                dirty={dirty}
                error={
                  failure ||
                  (count ? `Fix ${count} ${count === 1 ? 'field' : 'fields'} to add this person.` : undefined)
                }
                submit={{
                  label: 'Add person',
                  pendingLabel: 'Adding…',
                  state: sending ? { kind: 'busy' } : { kind: 'ready' },
                }}
              >
                <Button variant="outline" disabled={sending} onClick={close}>
                  Cancel
                </Button>
              </FormFooter>
            </div>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A person's Members profile: photo, name, emails and every field the workspace added.
 * Account name and photo follow the person's own profile, so only business fields change here for them.
 */
export function MemberProfileCard({
  workspace,
  api,
  members,
  memberId,
  actions,
}: {
  workspace: TableWorkspace;
  api: TableApi;
  members: MembersTable;
  memberId: string;
  actions?: ReactNode;
}) {
  const { table, permissions } = members;
  const row = useTableRow(api, table, memberId);
  const state = useWorkspaceMembers(workspace.id, table.id, { ids: [memberId] });
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState('');
  const reload = async () => {
    await Promise.all([row.refresh(), state.refresh()]);
  };
  const member = state.state.kind === 'ready' ? state.state.data.members[0] : undefined;
  const photo = useRecordMutation(api, () => {
    setNotice('Photo saved.');
    void reload();
  });
  const loaded = row.state.kind === 'ready' ? row.state.data : null;
  const linked = useLinkedRows(api, loaded ? [loaded.values] : []);
  const files = useFileNames(workspace.id, fileIdsOf(loaded ? [loaded.values] : []), loaded?.unavailableFileIds ?? []);
  const extra = table.definition.fields.filter(field => !coreFields.includes(field.id));
  return (
    <Card>
      <CardHeader>
        <CardTitle render={<h2 />}>Profile</CardTitle>
        <CardDescription>
          {member?.accountLinked
            ? 'Name and photo come from their TulipFarm profile. Other details are kept here.'
            : 'Details about this person in this workspace.'}
        </CardDescription>
        {(permissions.update || actions) && loaded && (
          <CardAction>
            <div className="flex flex-wrap gap-2">
              {permissions.update && (
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  Edit profile
                </Button>
              )}
              {actions}
            </div>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <TableRead state={row.state} refresh={reload}>
          {current =>
            !current ? (
              <StatePanel
                kind="unavailable"
                heading="h3"
                title="This person isn’t available"
                description="They may have been removed, or your access changed."
              />
            ) : (
              <div className="flex flex-col gap-5">
                <section aria-label="Photo">
                  {member?.canEditProfile && permissions.update ? (
                    <AvatarImagePicker
                      seed={current.id}
                      name={memberName(current.values)}
                      image={memberPhotoSource(workspace.id, current.values[workspaceMemberFields.photo])}
                      shape="circle"
                      disabled={photo.locked}
                      onChange={image => {
                        if (photo.locked) return;
                        setNotice('');
                        void photo.submit({
                          kind: 'member-photo',
                          requestId: crypto.randomUUID(),
                          tableId: table.id,
                          revision: table.revision,
                          recordId: current.id,
                          expectedToken: current.token,
                          image,
                        });
                      }}
                    />
                  ) : (
                    <EntityAvatar
                      seed={current.id}
                      name={memberName(current.values)}
                      image={memberPhotoSource(workspace.id, current.values[workspaceMemberFields.photo])}
                      size="lg"
                    />
                  )}
                </section>
                {notice && (
                  <p role="status" className="text-sm">
                    {notice}
                  </p>
                )}
                <RecordMutationFeedback mutation={photo} />
                <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-3">
                  <ProfileItem label="Name">
                    {memberText(current.values, workspaceMemberFields.name) || '—'}
                    {memberInactive(current.values) && (
                      <span className="ml-2">
                        <Badge variant="secondary">Inactive</Badge>
                      </span>
                    )}
                  </ProfileItem>
                  <ProfileItem label="Contact email">
                    {memberText(current.values, workspaceMemberFields.contactEmail) || '—'}
                  </ProfileItem>
                  {member?.accountLinked && (
                    <ProfileItem label="Account email">
                      {memberText(current.values, workspaceMemberFields.accountEmail) || '—'}
                    </ProfileItem>
                  )}
                  {extra.map(field => (
                    <ProfileItem key={field.id} label={field.label}>
                      <TableValueView
                        value={current.values[field.id]}
                        definition={table.definition}
                        fieldId={field.id}
                        linked={linked.state}
                        files={files.state}
                        unavailableFileIds={current.unavailableFileIds}
                        workspace={workspace}
                        systemKind="workspace-members"
                        record={current}
                      />
                    </ProfileItem>
                  ))}
                </dl>
              </div>
            )
          }
        </TableRead>
      </CardContent>
      {editing && loaded && (
        <RecordEditor
          record={loaded}
          table={table}
          api={api}
          workspace={workspace}
          disabled={false}
          close={() => setEditing(false)}
          saved={() => {
            setEditing(false);
            setNotice(`Saved ${workspaceMemberLabel(loaded.values)}’s profile.`);
            void reload();
          }}
          refresh={reload}
        />
      )}
    </Card>
  );
}

function ProfileItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 wrap-anywhere sm:col-span-2">{children}</dd>
    </div>
  );
}
