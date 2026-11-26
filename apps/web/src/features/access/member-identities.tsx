import { useState } from 'react';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@tulipfarm/sprout/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@tulipfarm/sprout/dialog';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useFeatureRead } from '@/lib/query';
import { useConfirmation } from '@/features/access/confirm';
import { TableRequestError } from '@/features/tables/request-state';
import {
  addMemberIdentity,
  listMemberIdentities,
  memberIdentityKeys,
  removeMemberIdentity,
  updateMemberIdentity,
  type IdentityProviderInfo,
  type WorkspaceMemberIdentity,
} from './member-identities-api';

const customProviderChoice = '__other__';
const slugPattern = /^[a-z][a-z0-9-]{0,31}$/;

type EditorMode = { mode: 'add' } | { mode: 'edit'; identity: WorkspaceMemberIdentity };

function formatHandle(identity: WorkspaceMemberIdentity, providers: readonly IdentityProviderInfo[]) {
  if (!identity.handle) return null;
  const info = providers.find(item => item.id === identity.provider);
  return info?.handlePrefix ? `${info.handlePrefix}${identity.handle}` : identity.handle;
}

function identityLabel(identity: WorkspaceMemberIdentity, providers: readonly IdentityProviderInfo[]) {
  return formatHandle(identity, providers) ?? identity.displayName ?? identity.externalId ?? identity.providerLabel;
}

function safeProfileUrl(url: string | null) {
  return url && url.startsWith('https://') ? url : null;
}

export function MemberIdentitiesCard({ workspaceId, memberId }: { workspaceId: string; memberId: string }) {
  const read = useFeatureRead({
    key: memberIdentityKeys.list(memberId),
    load: signal => listMemberIdentities(workspaceId, memberId, signal),
  });
  const confirmation = useConfirmation();
  const [editor, setEditor] = useState<EditorMode | null>(null);
  const [notice, setNotice] = useState('');

  const data = read.state.kind === 'ready' ? read.state.data : null;
  const verified = data ? data.identities.filter(item => item.trust === 'verified') : [];
  const manual = data ? data.identities.filter(item => item.trust === 'manual') : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle render={<h2 />}>Connected accounts &amp; handles</CardTitle>
        <CardDescription>
          Verified accounts come from connected integrations. Add handles by hand for other tools so teammates and
          agents can match this person.
        </CardDescription>
        {data?.canManage && (
          <CardAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setNotice('');
                setEditor({ mode: 'add' });
              }}
            >
              Add handle
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {read.state.kind === 'loading' ? (
          <div role="status" className="flex flex-col gap-3">
            <span className="sr-only">Loading connected accounts…</span>
            <Skeleton shape="panel" />
          </div>
        ) : read.state.kind === 'unavailable' ? (
          <StatePanel
            kind="unavailable"
            heading="h3"
            title="Connected accounts aren’t available"
            description="Your permission may have changed, or this person is no longer listed."
          />
        ) : read.state.kind === 'error' ? (
          <StatePanel
            kind="error"
            heading="h3"
            title="Couldn’t load connected accounts"
            description={read.state.message}
          >
            <Button variant="outline" size="sm" onClick={() => void read.refresh()}>
              Try again
            </Button>
          </StatePanel>
        ) : data ? (
          <div className="flex flex-col gap-6">
            {notice && (
              <p role="status" className="text-sm">
                {notice}
              </p>
            )}
            {verified.length === 0 && manual.length === 0 ? (
              <StatePanel
                kind="empty"
                heading="h3"
                title="No connected accounts or handles yet"
                description={
                  data.canManage
                    ? 'Accounts from Slack, GitHub, Google, Atlassian, and Trello appear here automatically, or you can add a handle by hand.'
                    : 'Connected integration accounts and added handles appear here once linked.'
                }
              >
                {data.canManage && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setNotice('');
                      setEditor({ mode: 'add' });
                    }}
                  >
                    Add handle
                  </Button>
                )}
              </StatePanel>
            ) : (
              <>
                {verified.length > 0 && (
                  <section aria-label="Verified connected accounts" className="flex flex-col gap-3">
                    <div className="flex flex-col gap-0.5">
                      <h3 className="text-sm font-medium">Verified accounts</h3>
                      <p className="text-xs text-muted-foreground">
                        Updated automatically from connected integrations.
                      </p>
                    </div>
                    <ul className="flex flex-col divide-y rounded-md border">
                      {verified.map(item => (
                        <IdentityRow
                          key={`verified:${item.provider}:${item.scope}:${item.externalId ?? ''}:${item.handle ?? ''}`}
                          identity={item}
                          providers={data.providers}
                        />
                      ))}
                    </ul>
                  </section>
                )}
                {manual.length > 0 && (
                  <section aria-label="Added handles" className="flex flex-col gap-3">
                    <div className="flex flex-col gap-0.5">
                      <h3 className="text-sm font-medium">Added handles</h3>
                      <p className="text-xs text-muted-foreground">
                        Handles and external IDs entered by hand for this person.
                      </p>
                    </div>
                    <ul className="flex flex-col divide-y rounded-md border">
                      {manual.map(item => (
                        <IdentityRow
                          key={item.id ?? `manual:${item.provider}:${item.scope}:${item.externalId ?? item.handle}`}
                          identity={item}
                          providers={data.providers}
                          canManage={data.canManage}
                          onEdit={() => {
                            setNotice('');
                            setEditor({ mode: 'edit', identity: item });
                          }}
                          onRemove={() => {
                            if (!item.id) return;
                            const id = item.id;
                            const label = identityLabel(item, data.providers);
                            confirmation.open({
                              title: `Remove ${item.providerLabel} handle?`,
                              description: `${label} will no longer be linked to this person.`,
                              action: 'Remove',
                              run: async () => {
                                try {
                                  await removeMemberIdentity(workspaceId, memberId, id);
                                  setNotice(`Removed ${item.providerLabel} handle.`);
                                  await read.refresh();
                                  return null;
                                } catch (error) {
                                  return error instanceof TableRequestError
                                    ? error.message
                                    : 'Could not remove this handle. Try again.';
                                }
                              },
                            });
                          }}
                        />
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
          </div>
        ) : null}
      </CardContent>
      {editor && data && (
        <IdentityEditorDialog
          workspaceId={workspaceId}
          memberId={memberId}
          providers={data.providers}
          editor={editor}
          close={() => setEditor(null)}
          saved={message => {
            setEditor(null);
            setNotice(message);
            void read.refresh();
          }}
        />
      )}
      {confirmation.element}
    </Card>
  );
}

function IdentityRow({
  identity,
  providers,
  canManage = false,
  onEdit,
  onRemove,
}: {
  identity: WorkspaceMemberIdentity;
  providers: readonly IdentityProviderInfo[];
  canManage?: boolean;
  onEdit?: () => void;
  onRemove?: () => void;
}) {
  const formattedHandle = formatHandle(identity, providers);
  const primary = identityLabel(identity, providers);
  const href = safeProfileUrl(identity.profileUrl);
  const info = providers.find(item => item.id === identity.provider);
  const showScope = Boolean(
    identity.scope && identity.scope !== info?.defaultScope && identity.scope !== identity.provider,
  );
  const showExternalId = Boolean(identity.externalId && identity.externalId !== primary);
  const showDisplayName = Boolean(identity.displayName && identity.displayName !== primary);
  const aliasPrefix = info?.handlePrefix ?? '';

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{identity.providerLabel}</Badge>
          {identity.trust === 'verified' && <Badge variant="success">Verified</Badge>}
          {identity.conflict === 'verified-elsewhere' && <Badge variant="warning">Verified on another person</Badge>}
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="font-medium wrap-anywhere underline-offset-4 hover:underline"
            >
              {formattedHandle ?? primary}
            </a>
          ) : (
            <span className="font-medium wrap-anywhere">{primary}</span>
          )}
        </div>
        {(showDisplayName || showExternalId || showScope) && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {showDisplayName && <span className="wrap-anywhere">{identity.displayName}</span>}
            {showExternalId && <span className="wrap-anywhere">ID: {identity.externalId}</span>}
            {showScope && <span className="wrap-anywhere">Scope: {identity.scope}</span>}
          </div>
        )}
        {identity.aliases.length > 0 && (
          <p className="text-xs text-muted-foreground wrap-anywhere">
            Previously: {identity.aliases.map(alias => `${aliasPrefix}${alias}`).join(', ')}
          </p>
        )}
      </div>
      {canManage && identity.trust === 'manual' && identity.id && (
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={onRemove}>
            Remove
          </Button>
        </div>
      )}
    </li>
  );
}

function IdentityEditorDialog({
  workspaceId,
  memberId,
  providers,
  editor,
  close,
  saved,
}: {
  workspaceId: string;
  memberId: string;
  providers: readonly IdentityProviderInfo[];
  editor: EditorMode;
  close: () => void;
  saved: (message: string) => void;
}) {
  const manualProviders = providers.filter(item => item.supportsManual);
  const initialProvider = manualProviders[0]?.id ?? customProviderChoice;
  const initialScope = manualProviders[0]?.defaultScope ?? '';
  const editing = editor.mode === 'edit' ? editor.identity : null;

  const [providerChoice, setProviderChoice] = useState(initialProvider);
  const [customSlug, setCustomSlug] = useState('');
  const [handle, setHandle] = useState(editing?.handle ?? '');
  const [externalId, setExternalId] = useState(editing?.externalId ?? '');
  const [scope, setScope] = useState(editing?.scope ?? initialScope);
  const [displayName, setDisplayName] = useState(editing?.displayName ?? '');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState('');

  const selectedProvider = manualProviders.find(item => item.id === providerChoice) ?? null;
  const isCustom = !editing && providerChoice === customProviderChoice;
  const dirty = editing
    ? handle !== (editing.handle ?? '') ||
      externalId !== (editing.externalId ?? '') ||
      displayName !== (editing.displayName ?? '')
    : Boolean(handle.trim() || externalId.trim() || displayName.trim() || customSlug.trim());

  function chooseProvider(next: string) {
    setProviderChoice(next);
    setFailure('');
    const info = manualProviders.find(item => item.id === next);
    setScope(info?.defaultScope ?? '');
  }

  async function save() {
    setSending(true);
    setFailure('');
    try {
      const trimmedHandle = handle.trim();
      const trimmedExternalId = externalId.trim();
      const trimmedDisplayName = displayName.trim();
      if (editing) {
        if (!editing.id) throw new Error('Missing identity id');
        const updated = await updateMemberIdentity(workspaceId, memberId, editing.id, {
          handle: trimmedHandle || null,
          externalId: trimmedExternalId || null,
          displayName: trimmedDisplayName || null,
        });
        saved(`Updated ${updated.providerLabel} handle.`);
        return;
      }
      const provider = isCustom ? customSlug.trim().toLowerCase() : providerChoice;
      const trimmedScope = scope.trim();
      const created = await addMemberIdentity(workspaceId, memberId, {
        provider,
        ...(trimmedScope ? { scope: trimmedScope } : {}),
        ...(trimmedHandle ? { handle: trimmedHandle } : {}),
        ...(trimmedExternalId ? { externalId: trimmedExternalId } : {}),
        ...(trimmedDisplayName ? { displayName: trimmedDisplayName } : {}),
      });
      saved(`Added ${created.providerLabel} handle.`);
    } catch (error) {
      setFailure(
        error instanceof TableRequestError
          ? error.message
          : 'Could not save this handle. Check your connection and try again.',
      );
      setSending(false);
    }
  }

  function submit() {
    if (sending) return;
    if (isCustom && !slugPattern.test(customSlug.trim().toLowerCase())) {
      setFailure(
        'Enter a platform slug starting with a lowercase letter, using only lowercase letters, numbers, and hyphens.',
      );
      return 'invalid';
    }
    if (!handle.trim() && !externalId.trim()) {
      setFailure('Enter a handle or an external user ID.');
      return 'invalid';
    }
    void save();
  }

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open && !sending) close();
      }}
    >
      <DialogContent showCloseButton={!sending}>
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.providerLabel} handle` : 'Add external handle'}</DialogTitle>
          <DialogDescription>
            {editing
              ? `Update the handle or external user ID for ${editing.providerLabel} (${editing.scope}).`
              : 'Link a handle or external user ID so teammates and agents can find this person.'}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 px-4 pb-4">
          <Form label={editing ? 'Edit external handle' : 'Add external handle'} disabled={sending} onSubmit={submit}>
            <div className="flex flex-col gap-4">
              {!editing && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="identity-provider">Platform</Label>
                  <Select
                    value={providerChoice}
                    onValueChange={value => {
                      if (value) chooseProvider(value);
                    }}
                    disabled={sending}
                  >
                    <SelectTrigger id="identity-provider">
                      <SelectValue>
                        {isCustom ? 'Other platform' : (selectedProvider?.label ?? 'Choose a platform')}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {manualProviders.map(item => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.label}
                        </SelectItem>
                      ))}
                      <SelectItem value={customProviderChoice}>Other platform</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              {isCustom && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="identity-custom-provider">Platform slug</Label>
                  <Input
                    id="identity-custom-provider"
                    required
                    maxLength={32}
                    placeholder="mattermost"
                    value={customSlug}
                    disabled={sending}
                    onChange={event => setCustomSlug(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Lowercase letters, numbers, and hyphens, such as mattermost or zulip.
                  </p>
                </div>
              )}
              <div className="flex flex-col gap-2">
                <Label htmlFor="identity-handle">Handle</Label>
                <Input
                  id="identity-handle"
                  maxLength={128}
                  placeholder={selectedProvider?.handlePrefix ? '@dhruv' : 'dhruv'}
                  value={handle}
                  disabled={sending}
                  onChange={event => setHandle(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">Optional if you enter an external user ID.</p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="identity-external-id">External user ID (optional)</Label>
                <Input
                  id="identity-external-id"
                  maxLength={128}
                  placeholder={providerChoice === 'slack' ? 'U0123ABC' : 'User ID on that platform'}
                  value={externalId}
                  disabled={sending}
                  onChange={event => setExternalId(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Stable platform ID, such as a Slack U-ID or Discord numeric ID.
                </p>
              </div>
              {!editing && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="identity-scope">Workspace or server scope (optional)</Label>
                  <Input
                    id="identity-scope"
                    maxLength={128}
                    placeholder={
                      providerChoice === 'slack'
                        ? 'T0123ABC (defaults to connected Slack workspace)'
                        : (selectedProvider?.defaultScope ?? 'server.example.com')
                    }
                    value={scope}
                    disabled={sending}
                    onChange={event => setScope(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Defaults automatically for known platforms. Leave blank for Slack to use the connected workspace.
                  </p>
                </div>
              )}
              <div className="flex flex-col gap-2">
                <Label htmlFor="identity-display-name">Display name (optional)</Label>
                <Input
                  id="identity-display-name"
                  maxLength={200}
                  placeholder="How their name appears on that platform"
                  value={displayName}
                  disabled={sending}
                  onChange={event => setDisplayName(event.target.value)}
                />
              </div>
              <FormFooter
                layout="compact"
                dirty={dirty}
                error={failure || undefined}
                submit={{
                  label: editing ? 'Save changes' : 'Add handle',
                  pendingLabel: 'Saving…',
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
