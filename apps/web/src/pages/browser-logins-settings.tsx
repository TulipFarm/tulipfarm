import { useId, useState, type ReactNode } from 'react';
import { MoreIcon } from '@tulipfarm/icons';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@tulipfarm/sprout/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { Input } from '@tulipfarm/sprout/input';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { RecordList } from '@tulipfarm/sprout/record-list';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { workspaceRoute } from '@/router';
import { useFeatureScope } from '@/lib/query';
import { useOwnMembership } from '@/features/governance/queries';
import { describedBy, Labelled } from '@/features/secrets/fields';
import { GrantsEditor, type People } from '@/features/secrets/grants-editor';
import { useMemberDirectory } from '@/features/secrets/queries';
import type { SecretGrant } from '@/features/secrets/contracts';
import {
  browserLoginErrorMessage,
  useBrowserLoginChanges,
  useBrowserLogins,
  useBrowserLoginsApi,
  type BrowserLoginSummary,
} from '@/features/browser/logins';

type Action = { kind: 'rename' | 'sharing' | 'delete'; login: BrowserLoginSummary };

export function BrowserLoginsSettingsPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  return (
    <PageContent>
      <PageHeader
        titleId="browser-logins-heading"
        focusable
        title="Browser logins"
        description="Saved sign-ins for websites. When an agent asks you to sign in, pick one instead. They’re encrypted and never shown."
      />
      <Logins workspaceId={workspace.id} />
    </PageContent>
  );
}

function sharingLabel(login: BrowserLoginSummary, you: string) {
  if (login.grants.some(grant => grant.grantee.kind === 'workspace')) return 'Everyone';
  if (login.grants.length) return `Shared with ${login.grants.length}`;
  return login.ownerMembershipId === you ? 'Just you' : null;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function Logins({ workspaceId }: { workspaceId: string }) {
  const scope = useFeatureScope();
  const you = scope.kind === 'workspace' ? scope.membershipId : '';
  const read = useBrowserLogins(workspaceId);
  const directory = useMemberDirectory(workspaceId);
  const membership = useOwnMembership(workspaceId);
  const [action, setAction] = useState<Action | null>(null);
  const members = directory.state.kind === 'ready' ? directory.state.data : [];
  const people: People = {
    you,
    name: id => (id === you ? 'You' : (members.find(member => member.id === id)?.name ?? 'A former member')),
    members: members.map(member => ({ id: member.id, name: member.name })),
    teams: membership.state.kind === 'ready' ? membership.state.data.teams : [],
  };
  const logins = read.state.kind === 'ready' ? read.state.data.logins : [];
  const status = read.state.kind === 'loading' ? 'loading' : read.state.kind === 'ready' ? 'ready' : 'error';
  const close = () => setAction(null);
  return (
    <div className="space-y-3 pb-20">
      <RecordList
        items={logins.map(login => ({ ...login, title: login.name }))}
        label="Browser logins"
        status={status}
        error="Couldn’t load your browser logins. Check your connection."
        onRetry={() => void read.refresh()}
        empty={
          <StatePanel
            kind="empty"
            heading="h2"
            title="No browser logins yet"
            description="When you sign in to a website in a chat’s browser, choose Save login to keep it here."
          />
        }
        renderTitle={login => (
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span>{login.name}</span>
            <span className="font-mono text-xs font-normal text-muted-foreground">{login.site}</span>
          </span>
        )}
        badges={login => {
          const sharing = sharingLabel(login, you);
          return (
            <>
              {login.status === 'suspended' && <Badge variant="warning">Owner left</Badge>}
              {login.status === 'needs-sign-in' && <Badge variant="warning">Signed out</Badge>}
              {sharing && <Badge variant="outline">{sharing}</Badge>}
            </>
          );
        }}
        values={login => [
          { label: 'Owner', value: people.name(login.ownerMembershipId) },
          { label: 'Last used', value: login.lastUsedAt ? formatDate(login.lastUsedAt) : 'Never' },
          ...(login.status === 'needs-sign-in' && login.canManage
            ? [{ label: 'To fix', value: 'Use it in a chat, sign in again, then hand back' }]
            : []),
        ]}
        renderActions={login =>
          login.canManage ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${login.name}`} />}
              >
                <MoreIcon size="md" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => setAction({ kind: 'rename', login })}>Rename</DropdownMenuItem>
                  {login.status !== 'suspended' && (
                    <DropdownMenuItem onClick={() => setAction({ kind: 'sharing', login })}>
                      Change who can use it
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => setAction({ kind: 'delete', login })}>Delete</DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null
        }
      />
      {action?.kind === 'rename' && <RenameDialog workspaceId={workspaceId} login={action.login} close={close} />}
      {action?.kind === 'sharing' && (
        <SharingDialog workspaceId={workspaceId} login={action.login} people={people} close={close} />
      )}
      {action?.kind === 'delete' && <DeleteDialog workspaceId={workspaceId} login={action.login} close={close} />}
    </div>
  );
}

function useChange(close: () => void) {
  const changes = useBrowserLoginChanges();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    sending,
    error,
    clear: () => setError(null),
    run: async (change: () => Promise<unknown>) => {
      if (sending) return;
      setSending(true);
      setError(null);
      try {
        await change();
        await changes.changed();
        close();
      } catch (failure) {
        setError(browserLoginErrorMessage(failure));
      } finally {
        setSending(false);
      }
    },
  };
}

function FormDialog({
  title,
  description,
  close,
  submitLabel,
  sending,
  error,
  onSubmit,
  children,
}: {
  title: string;
  description?: string;
  close: () => void;
  submitLabel: string;
  sending: boolean;
  error: string | null;
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open && !sending) close();
      }}
    >
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form
          className="min-h-0 space-y-4 overflow-y-auto"
          noValidate
          onSubmit={event => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {children}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" disabled={sending} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={sending} aria-busy={sending}>
              {sending ? 'Saving…' : submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  workspaceId,
  login,
  close,
}: {
  workspaceId: string;
  login: BrowserLoginSummary;
  close: () => void;
}) {
  const api = useBrowserLoginsApi(workspaceId);
  const change = useChange(close);
  const id = useId();
  const [name, setName] = useState(login.name);
  const [checked, setChecked] = useState(false);
  const nameError = checked && !name.trim() ? 'Enter a name.' : null;
  return (
    <FormDialog
      title={`Rename ${login.name}`}
      close={close}
      submitLabel="Save"
      sending={change.sending}
      error={change.error}
      onSubmit={() => {
        setChecked(true);
        if (name.trim()) void change.run(() => api.rename(login.id, name.trim()));
      }}
    >
      <Labelled id={`${id}-name`} label="Name" error={nameError}>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={80}
          autoComplete="off"
          aria-invalid={!!nameError}
          aria-describedby={describedBy(`${id}-name`, null, nameError)}
          disabled={change.sending}
          onChange={event => {
            change.clear();
            setName(event.target.value);
          }}
        />
      </Labelled>
    </FormDialog>
  );
}

function SharingDialog({
  workspaceId,
  login,
  people,
  close,
}: {
  workspaceId: string;
  login: BrowserLoginSummary;
  people: People;
  close: () => void;
}) {
  const api = useBrowserLoginsApi(workspaceId);
  const change = useChange(close);
  const [grants, setGrants] = useState<SecretGrant[]>(login.grants);
  return (
    <FormDialog
      title={`Who can use ${login.name}`}
      close={close}
      submitLabel="Save"
      sending={change.sending}
      error={change.error}
      onSubmit={() => void change.run(() => api.share(login.id, grants))}
    >
      <GrantsEditor
        value={grants}
        owner={login.ownerMembershipId}
        people={people}
        disabled={change.sending}
        description={`They can use it in their chats. Their agents act on ${login.site} with this account.`}
        roles={{
          use: { label: 'Use it', hint: 'In their chats' },
          manage: { label: 'Use and manage it', hint: 'Also rename, share or delete it' },
        }}
        onChange={next => {
          change.clear();
          setGrants(next);
        }}
      />
    </FormDialog>
  );
}

function DeleteDialog({
  workspaceId,
  login,
  close,
}: {
  workspaceId: string;
  login: BrowserLoginSummary;
  close: () => void;
}) {
  const api = useBrowserLoginsApi(workspaceId);
  const change = useChange(close);
  return (
    <AlertDialog
      open
      onOpenChange={open => {
        if (!open && !change.sending) close();
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>Delete {login.name}?</AlertDialogTitle>
        <AlertDialogDescription>
          It’s removed for everyone it’s shared with. Browsers already signed in with it stay signed in until they
          close.
        </AlertDialogDescription>
        {change.error && (
          <Alert variant="destructive">
            <AlertDescription>{change.error}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={change.sending}>Keep login</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={change.sending}
            aria-busy={change.sending}
            onClick={() => void change.run(() => api.remove(login.id))}
          >
            {change.sending ? 'Deleting…' : 'Delete login'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
