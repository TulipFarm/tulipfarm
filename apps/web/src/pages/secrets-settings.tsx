import { useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link } from '@tanstack/react-router';
import { Add } from 'reicon-react/icons/Add';
import { ChevronDown } from 'reicon-react/icons/ChevronDown';
import { Check } from 'reicon-react/icons/Check';
import { ChevronUp } from 'reicon-react/icons/ChevronUp';
import { Copy } from 'reicon-react/icons/Copy';
import { MoreH } from 'reicon-react/icons/MoreH';
import { workspaceRoute } from '@/router';
import { editListed, useFeatureScope, useOptimisticUpdate } from '@/lib/query';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { ToggleGroup, ToggleGroupItem } from '@tulipfarm/sprout/toggle-group';
import { UnsavedChanges } from '@/features/tables/feedback';
import { TableRequestError } from '@/features/tables/request-state';
import { useOwnMembership } from '@/features/governance/queries';
import { GrantsEditor, canManage, roleOptions, type People } from '@/features/secrets/grants-editor';
import { secretErrorMessage } from '@/features/secrets/api';
import {
  MAX_DESTINATIONS,
  destinationHosts,
  destinationInput,
  destinationLabel,
  kindLabels,
  placementError,
  placementPhrase,
  suggestVariableName,
  valueError,
  type Placement,
  type SecretGrant,
  type SecretKind,
  type SecretSummary,
  type SecretValue,
} from '@/features/secrets/contracts';
import {
  DestinationsEditor,
  ExpiryPicker,
  Labelled,
  PlacementEditor,
  SecretValueInput,
  VariableNameInput,
  describedBy,
  emptyValue,
  expiryAt,
  expiryError,
  formatDate,
  variableNameError,
  type ExpiryChoice,
} from '@/features/secrets/fields';
import {
  useMemberDirectory,
  useSecretHistory,
  useSecrets,
  useSecretsApi,
  useSecretsCapabilities,
  useSecretsChanges,
  secretsKeys,
} from '@/features/secrets/queries';

type Action =
  | { kind: 'add' }
  | {
      kind: 'details' | 'rename' | 'replace' | 'take' | 'destinations' | 'sharing' | 'expiry' | 'save' | 'delete';
      secret: SecretSummary;
    };

export function SecretsSettingsPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const capabilities = useSecretsCapabilities(workspace.id);
  return (
    <PageContent>
      <PageHeader
        titleId="secrets-heading"
        focusable
        title="Secrets"
        description="API keys, passwords and tokens that agents can use for you. Agents never see the values."
      />
      {capabilities.state.kind === 'loading' ? (
        <div role="status" aria-label="Loading secrets" className="space-y-3">
          <Skeleton />
          <Skeleton />
        </div>
      ) : capabilities.state.kind === 'error' ? (
        <StatePanel kind="error" heading="h2" title="Could not load secrets" description="Check your connection.">
          <Button variant="outline" onClick={() => void capabilities.refresh()}>
            Try again
          </Button>
        </StatePanel>
      ) : capabilities.state.kind === 'ready' && capabilities.state.data.enabled ? (
        <Secrets workspaceId={workspace.id} />
      ) : (
        <StatePanel
          kind="unavailable"
          heading="h2"
          title="Secrets are turned off"
          description="This workspace is not set up to store secrets."
        />
      )}
    </PageContent>
  );
}

function Secrets({ workspaceId }: { workspaceId: string }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const scope = useFeatureScope();
  const you = scope.kind === 'workspace' ? scope.membershipId : '';
  const read = useSecrets(workspaceId, true);
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
  const secrets = read.state.kind === 'ready' ? read.state.data : [];
  const saved = secrets.filter(secret => secret.lifetime === 'saved');
  const temporary = secrets.filter(secret => secret.lifetime === 'conversation');
  const status = read.state.kind === 'loading' ? 'loading' : read.state.kind === 'ready' ? 'ready' : 'error';
  const close = () => setAction(null);
  const list = (items: SecretSummary[], label: string, empty: ReactNode) => (
    <RecordList
      items={items.map(secret => ({ ...secret, title: secret.name }))}
      label={label}
      status={status}
      error="Could not load your secrets. Check your connection."
      onRetry={() => void read.refresh()}
      empty={empty}
      onItemOpen={secret => setAction({ kind: 'details', secret })}
      renderTitle={secret => (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span>{secret.name}</span>
          <span className="font-mono text-xs font-normal text-muted-foreground">{secret.variableName}</span>
        </span>
      )}
      badges={secret => <SecretBadges secret={secret} you={you} />}
      values={secret => [
        { label: 'Used with', value: destinationHosts(secret.destinations) },
        secret.lifetime === 'conversation' && secret.origin
          ? {
              label: secret.origin.kind === 'chat' ? 'Chat' : 'Task',
              value:
                secret.origin.kind === 'chat' ? (
                  <Link
                    to="/$workspaceSlug/chat/$chatId"
                    params={{ workspaceSlug: workspace.slug, chatId: secret.origin.conversationId }}
                  >
                    Open chat
                  </Link>
                ) : (
                  'Agent task run'
                ),
              text: secret.origin.kind === 'chat' ? 'Open chat' : 'Agent task run',
            }
          : { label: 'Owner', value: people.name(secret.ownerMembershipId) },
      ]}
      renderActions={secret => <SecretActions secret={secret} you={you} open={setAction} />}
    />
  );
  return (
    <div className="space-y-8 pb-20">
      <section aria-labelledby="saved-secrets" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="space-y-1">
            <h2 id="saved-secrets" className="text-base font-medium">
              Saved secrets
            </h2>
            <p className="text-sm text-muted-foreground">Yours and those shared with you.</p>
          </div>
          <Button onClick={() => setAction({ kind: 'add' })}>
            <Add size={16} aria-hidden="true" />
            Add secret
          </Button>
        </div>
        {list(
          saved,
          'Saved secrets',
          <StatePanel
            kind="empty"
            heading="h3"
            title="No saved secrets yet"
            description="Add one here, or save one when an agent asks for it in a chat."
          />,
        )}
      </section>
      <section aria-labelledby="temporary-secrets" className="space-y-3">
        <div className="space-y-1">
          <h2 id="temporary-secrets" className="text-base font-medium">
            Only for one chat
          </h2>
          <p className="text-sm text-muted-foreground">
            Values you gave for a single chat or task. They are deleted when they expire.
          </p>
        </div>
        {list(temporary, 'Secrets for one chat', <p className="text-sm text-muted-foreground">None right now.</p>)}
      </section>
      {action?.kind === 'add' && <AddSecretDialog workspaceId={workspaceId} people={people} close={close} />}
      {action && action.kind !== 'add' && (
        <SecretDialog workspaceId={workspaceId} action={action} people={people} close={close} />
      )}
    </div>
  );
}

function sharingLabel(secret: SecretSummary, you: string) {
  if (secret.grants.some(grant => grant.grantee.kind === 'workspace')) return 'Everyone';
  if (secret.grants.length) return `Shared with ${secret.grants.length}`;
  return secret.ownerMembershipId === you ? 'Just you' : null;
}

function SecretBadges({ secret, you }: { secret: SecretSummary; you: string }) {
  const sharing = secret.lifetime === 'saved' ? sharingLabel(secret, you) : null;
  return (
    <>
      {secret.status === 'suspended' && <Badge variant="warning">Owner left</Badge>}
      {secret.status === 'expired' && <Badge variant="secondary">Expired</Badge>}
      {secret.lifetime === 'conversation' && <Badge variant="info">One chat</Badge>}
      {sharing && <Badge variant="outline">{sharing}</Badge>}
      {secret.expiresAt && secret.status === 'active' && (
        <Badge variant="secondary">Expires {formatDate(secret.expiresAt)}</Badge>
      )}
    </>
  );
}

function SecretActions({ secret, you, open }: { secret: SecretSummary; you: string; open: (action: Action) => void }) {
  const owner = secret.ownerMembershipId === you;
  const saved = secret.lifetime === 'saved';
  const active = secret.status === 'active';
  const item = (kind: Exclude<Action['kind'], 'add'>, label: string) => (
    <DropdownMenuItem onClick={() => open({ kind, secret })}>{label}</DropdownMenuItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${secret.name}`} />}>
        <MoreH size={16} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          {item('details', secret.canManage ? 'Details and history' : 'Details')}
          {secret.canManage && item('rename', 'Rename')}
          {secret.canManage && active && item('replace', 'Replace value')}
          {secret.canManage && secret.status === 'suspended' && item('take', 'Take ownership')}
          {secret.canManage && active && item('destinations', "Change where it's used")}
          {secret.canManage && active && saved && item('sharing', 'Change who can use it')}
          {active && (saved ? secret.canManage : owner) && item('expiry', "Change when it's deleted")}
          {!saved && owner && active && item('save', 'Save to my secrets')}
          {(secret.canManage || (!saved && owner)) && item('delete', 'Delete')}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type SecretEdit = (secret: Record<string, unknown>) => Record<string, unknown> | null;

/** Runs one change. Keeps the request ID across retries of the same change and refreshes the list after. */
function useChange(close: () => void) {
  const changes = useSecretsChanges();
  const optimistic = useOptimisticUpdate();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    sending,
    error,
    clear: () => setError(null),
    /**
     * `handled` returns true when the dialog shows the failure itself, such as next to a field. `shown`
     * applies `edit` to that secret in the list until the change settles.
     */
    run: async (
      change: () => Promise<unknown>,
      handled?: (failure: unknown) => boolean,
      succeeded?: () => void,
      shown?: { id: string; edit: SecretEdit },
    ) => {
      if (sending) return;
      setSending(true);
      setError(null);
      const undo = shown ? await optimistic([secretsKeys.list], data => editListed(data, shown.id, shown.edit)) : null;
      try {
        await change();
        succeeded?.();
        await changes.changed();
        close();
      } catch (failure) {
        undo?.();
        if (!handled?.(failure)) setError(secretErrorMessage(failure));
        if (undo || (failure instanceof TableRequestError && failure.code === 'secret-conflict'))
          await changes.changed();
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
  dirty,
  initialFocus,
  children,
}: {
  title: string;
  description?: string;
  close: () => void;
  dirty?: boolean;
  initialFocus?: RefObject<HTMLInputElement | null>;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) close();
      }}
    >
      <DialogContent size="form" initialFocus={initialFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <UnsavedChanges dirty={!!dirty} />
        <div className="min-h-0 overflow-y-auto">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

function DialogForm({
  submitLabel,
  sendingLabel,
  sending,
  error,
  close,
  onSubmit,
  destructive,
  children,
}: {
  submitLabel: string;
  sendingLabel: string;
  sending: boolean;
  error: string | null;
  close: () => void;
  onSubmit: () => void;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <form
      className="space-y-4"
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
        <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={sending} aria-busy={sending}>
          {sending ? sendingLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}

function destinationsError(list: string[]) {
  const filled = list.map(item => item.trim()).filter(Boolean);
  if (!filled.length) return "Add the website or API it's for.";
  if (filled.length > MAX_DESTINATIONS) return `Add up to ${MAX_DESTINATIONS}.`;
  if (filled.some(item => /^http:\/\//i.test(item))) return 'Use https addresses.';
  if (filled.some(item => /\s/.test(item))) return 'Remove the spaces.';
  return null;
}

/** Kinds offered for a single value. Agents match saved secrets to requests by kind. */
const keyKinds = ['api-key', 'token', 'password', 'header'] as const satisfies readonly SecretKind[];

function hasValue(value: SecretValue) {
  return 'value' in value ? !!value.value : !!(value.username || value.password);
}

type Saving = 'key' | 'login';
type Audience = 'me' | 'team' | 'everyone';

function grantFor(key: string, role: SecretGrant['role']): SecretGrant {
  const [kind, target = ''] = key.split(':');
  return kind === 'team'
    ? { grantee: { kind: 'team', teamId: target }, role }
    : { grantee: { kind: 'member', membershipId: target }, role };
}

function AddSecretDialog({ workspaceId, people, close }: { workspaceId: string; people: People; close: () => void }) {
  const api = useSecretsApi(workspaceId);
  const change = useChange(close);
  const id = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const requestId = useRef(crypto.randomUUID());
  // Fixed per request ID, so a retry sends the same deletion time and replays instead of conflicting.
  const frozenExpiry = useRef<{ requestId: string; at: string | null } | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState<Saving>('key');
  const [keyKind, setKeyKind] = useState<(typeof keyKinds)[number]>('api-key');
  const [name, setName] = useState('');
  const [value, setValue] = useState<SecretValue>(emptyValue('api-key'));
  const [destinations, setDestinations] = useState(['']);
  const [audience, setAudience] = useState<Audience>('me');
  const [target, setTarget] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [placement, setPlacement] = useState<Placement>({ kind: 'bearer' });
  const [expiry, setExpiry] = useState<ExpiryChoice>({ preset: 'none', custom: '' });
  const [role, setRole] = useState<SecretGrant['role']>('use');
  const [variableName, setVariableName] = useState<string | null>(null);
  const [takenName, setTakenName] = useState<string | null>(null);
  const variableInput = useRef<HTMLInputElement>(null);
  const kind: SecretKind = saving === 'login' ? 'username-password' : keyKind;
  const suggestedName = suggestVariableName(name, kind);
  const targets = [
    ...people.teams.map(team => ({ key: `team:${team.id}`, label: team.name, hint: 'Team' })),
    ...people.members
      .filter(member => member.id !== people.you)
      .map(member => ({ key: `member:${member.id}`, label: member.name, hint: 'Person' })),
  ];
  const chosen = targets.find(option => option.key === target) ?? targets[0];
  const grant: SecretGrant | null =
    audience === 'everyone'
      ? { grantee: { kind: 'workspace' }, role: 'use' }
      : audience === 'team' && chosen
        ? grantFor(chosen.key, 'use')
        : null;
  const grants: SecretGrant[] = grant ? [{ ...grant, role: canManage(grant) ? role : 'use' }] : [];
  const edited =
    <T,>(set: (value: T) => void) =>
    (next: T) => {
      requestId.current = crypto.randomUUID();
      change.clear();
      set(next);
    };
  const errors = {
    name: name.trim() ? null : 'Give it a name.',
    value: valueError(value),
    destinations: destinationsError(destinations),
    audience: audience === 'team' && !chosen ? 'There is nobody else to share with yet.' : null,
    placement: placementError(kind, placement),
    expiry: expiryError(expiry),
    variableName:
      variableName === null
        ? null
        : variableName.trim().toUpperCase() === takenName
          ? `You already have a secret called ${takenName}.`
          : variableNameError(variableName),
  };
  const shown = (error: string | null) => (attempted ? (error ?? undefined) : undefined);
  return (
    <FormDialog
      title="Add secret"
      description="Agents can use it for you. Nobody can read it back."
      close={close}
      dirty={hasValue(value) || !!name}
      initialFocus={nameInput}
    >
      <DialogForm
        submitLabel="Add secret"
        sendingLabel="Adding…"
        sending={change.sending}
        error={change.error}
        close={close}
        onSubmit={() => {
          setAttempted(true);
          if (errors.placement || errors.expiry || errors.variableName) setAdvanced(true);
          if (Object.values(errors).some(Boolean)) return;
          if (frozenExpiry.current?.requestId !== requestId.current)
            frozenExpiry.current = { requestId: requestId.current, at: expiryAt(expiry) };
          const expiresAt = frozenExpiry.current.at;
          void change.run(
            () =>
              api.create({
                requestId: requestId.current,
                name: name.trim(),
                kind,
                value,
                placement,
                destinations: destinations.filter(item => item.trim()).map(destinationInput),
                expiresAt,
                grants,
                ...(variableName === null ? {} : { variableName: variableName.trim().toUpperCase() }),
              }),
            failure => {
              if (!isVariableNameTaken(failure)) return false;
              setTakenName((variableName ?? suggestedName).trim().toUpperCase());
              setVariableName(variableName ?? suggestedName);
              setAdvanced(true);
              requestAnimationFrame(() => variableInput.current?.focus());
              return true;
            },
            () => setValue(emptyValue(kind)),
          );
        }}
      >
        <div className="space-y-1.5">
          <p id={`${id}-saving`} className="text-sm font-medium">
            What are you saving?
          </p>
          <ToggleGroup
            aria-labelledby={`${id}-saving`}
            variant="outline"
            spacing={0}
            value={[saving]}
            disabled={change.sending}
            onValueChange={next => {
              const choice = next[0];
              if (choice !== 'key' && choice !== 'login') return;
              edited(setSaving)(choice);
              setValue(emptyValue(choice === 'login' ? 'username-password' : keyKind));
              setPlacement(choice === 'login' ? { kind: 'basic' } : { kind: 'bearer' });
            }}
          >
            <ToggleGroupItem value="key">Key or token</ToggleGroupItem>
            <ToggleGroupItem value="login">Username and password</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <Labelled id={`${id}-name`} label="Name" error={shown(errors.name)}>
          <Input
            ref={nameInput}
            id={`${id}-name`}
            value={name}
            maxLength={80}
            autoComplete="off"
            placeholder="e.g. Stripe"
            aria-invalid={!!shown(errors.name)}
            aria-describedby={describedBy(`${id}-name`, null, shown(errors.name))}
            disabled={change.sending}
            onChange={event => edited(setName)(event.target.value)}
          />
        </Labelled>
        <SecretValueInput
          kind={kind}
          label="Key or token"
          value={value}
          error={shown(errors.value)}
          disabled={change.sending}
          onChange={edited(setValue)}
        />
        <DestinationsEditor
          value={destinations}
          error={shown(errors.destinations)}
          disabled={change.sending}
          onChange={edited(setDestinations)}
        />
        <div className="space-y-1.5">
          <p id={`${id}-audience`} className="text-sm font-medium">
            Who can use it
          </p>
          <ToggleGroup
            aria-labelledby={`${id}-audience`}
            variant="outline"
            spacing={0}
            value={[audience]}
            disabled={change.sending}
            onValueChange={next => {
              const choice = next[0];
              if (choice === 'me' || choice === 'team' || choice === 'everyone') edited(setAudience)(choice);
            }}
          >
            <ToggleGroupItem value="me">Just me</ToggleGroupItem>
            <ToggleGroupItem value="team">My team</ToggleGroupItem>
            <ToggleGroupItem value="everyone">Everyone</ToggleGroupItem>
          </ToggleGroup>
          {audience === 'team' && targets.length > 0 && chosen && (
            <div className="pt-1 sm:w-1/2">
              <Labelled id={`${id}-target`} label="Team or person" hidden>
                <Select
                  value={chosen.key}
                  disabled={change.sending}
                  onValueChange={key => {
                    if (key) edited(setTarget)(key);
                  }}
                >
                  <SelectTrigger id={`${id}-target`} width="full">
                    <SelectValue>{chosen.label}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {targets.map(option => (
                      <SelectItem key={option.key} value={option.key}>
                        <span className="flex flex-col">
                          <span>{option.label}</span>
                          <span className="text-xs text-muted-foreground">{option.hint}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Labelled>
            </div>
          )}
          {shown(errors.audience) && <p className="text-xs text-destructive">{errors.audience}</p>}
        </div>
        <div>
          <div>
            <Button
              variant="link"
              size="sm"

              aria-expanded={advanced}
              aria-controls={`${id}-advanced`}
              onClick={() => setAdvanced(!advanced)}
            >
              Advanced
              {advanced ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
            </Button>
          </div>
          {advanced && (
            <div id={`${id}-advanced`} className="mt-2 space-y-3 rounded-lg bg-muted p-3">
              {saving === 'key' && (
                <div className="sm:w-1/2">
                  <Labelled id={`${id}-kind`} label="Type">
                    <Select
                      value={keyKind}
                      disabled={change.sending}
                      onValueChange={next => {
                        if (next) edited(setKeyKind)(next);
                      }}
                    >
                      <SelectTrigger id={`${id}-kind`} width="full">
                        <SelectValue>{kindLabels[keyKind]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {keyKinds.map(option => (
                          <SelectItem key={option} value={option}>
                            {kindLabels[option]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Labelled>
                </div>
              )}
              <PlacementEditor
                kind={kind}
                value={placement}
                error={shown(errors.placement)}
                disabled={change.sending}
                onChange={edited(setPlacement)}
              />
              <VariableNameInput
                inputRef={variableInput}
                value={variableName ?? suggestedName}
                suggestion={suggestedName}
                error={variableName === null ? null : attempted || takenName ? errors.variableName : null}
                disabled={change.sending}
                onChange={edited(setVariableName)}
                onReset={() => {
                  change.clear();
                  setVariableName(null);
                }}
              />
              <ExpiryPicker
                allowNone
                value={expiry}
                error={shown(errors.expiry)}
                disabled={change.sending}
                onChange={edited(setExpiry)}
              />
              {grant && canManage(grant) && (
                <div className="sm:w-1/2">
                  <Labelled id={`${id}-role`} label="What they can do">
                    <Select
                      value={role}
                      disabled={change.sending}
                      onValueChange={next => {
                        if (next) edited(setRole)(next);
                      }}
                    >
                      <SelectTrigger id={`${id}-role`} width="full">
                        <SelectValue>{roleOptions[role].label}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {(['use', 'manage'] as const).map(option => (
                          <SelectItem key={option} value={option}>
                            <span className="flex flex-col">
                              <span>{roleOptions[option].label}</span>
                              <span className="text-xs text-muted-foreground">{roleOptions[option].hint}</span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Labelled>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogForm>
    </FormDialog>
  );
}

function SecretDialog({
  workspaceId,
  action,
  people,
  close,
}: {
  workspaceId: string;
  action: Exclude<Action, { kind: 'add' }>;
  people: People;
  close: () => void;
}) {
  const { secret } = action;
  switch (action.kind) {
    case 'details':
      return <DetailsDialog workspaceId={workspaceId} secret={secret} people={people} close={close} />;
    case 'rename':
      return <RenameDialog workspaceId={workspaceId} secret={secret} close={close} />;
    case 'replace':
    case 'take':
      return <ValueDialog workspaceId={workspaceId} secret={secret} take={action.kind === 'take'} close={close} />;
    case 'destinations':
      return <DestinationsDialog workspaceId={workspaceId} secret={secret} close={close} />;
    case 'sharing':
      return <SharingDialog workspaceId={workspaceId} secret={secret} people={people} close={close} />;
    case 'expiry':
    case 'save':
      return <ExpiryDialog workspaceId={workspaceId} secret={secret} save={action.kind === 'save'} close={close} />;
    case 'delete':
      return <DeleteDialog workspaceId={workspaceId} secret={secret} close={close} />;
  }
}

function isVariableNameTaken(failure: unknown) {
  return failure instanceof TableRequestError && failure.code === 'secret-variable-name-taken';
}

function RenameDialog({
  workspaceId,
  secret,
  close,
}: {
  workspaceId: string;
  secret: SecretSummary;
  close: () => void;
}) {
  const api = useSecretsApi(workspaceId);
  const change = useChange(close);
  const id = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const variableInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(secret.name);
  const [variableName, setVariableName] = useState(secret.variableName);
  const [takenName, setTakenName] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const nextVariableName = variableName.trim().toUpperCase();
  const errors = {
    name: name.trim() ? null : 'Give it a name.',
    variableName:
      nextVariableName === takenName
        ? `You already have a secret called ${takenName}.`
        : variableNameError(variableName),
  };
  const changes = {
    ...(name.trim() === secret.name ? {} : { name: name.trim() }),
    ...(nextVariableName === secret.variableName ? {} : { variableName: nextVariableName }),
  };
  return (
    <FormDialog
      title={`Rename ${secret.name}`}
      description="Agents and tools use the new names right away."
      close={close}
      dirty={Object.keys(changes).length > 0}
      initialFocus={nameInput}
    >
      <DialogForm
        submitLabel="Save"
        sendingLabel="Saving…"
        sending={change.sending}
        error={change.error}
        close={close}
        onSubmit={() => {
          setAttempted(true);
          if (Object.values(errors).some(Boolean)) return;
          if (Object.keys(changes).length === 0) return close();
          void change.run(
            () => api.rename(secret.id, changes),
            failure => {
              if (!isVariableNameTaken(failure)) return false;
              setTakenName(nextVariableName);
              variableInput.current?.focus();
              return true;
            },
            undefined,
            { id: secret.id, edit: item => ({ ...item, ...changes }) },
          );
        }}
      >
        <Labelled id={`${id}-name`} label="Name" error={attempted ? errors.name : null}>
          <Input
            ref={nameInput}
            id={`${id}-name`}
            value={name}
            aria-invalid={attempted && !!errors.name}
            aria-describedby={describedBy(`${id}-name`, null, attempted && errors.name)}
            disabled={change.sending}
            onChange={event => {
              change.clear();
              setName(event.target.value);
            }}
          />
        </Labelled>
        <VariableNameInput
          inputRef={variableInput}
          value={variableName}
          suggestion={secret.variableName}
          error={attempted || takenName ? errors.variableName : null}
          disabled={change.sending}
          onChange={next => {
            change.clear();
            setVariableName(next);
          }}
          onReset={() => {
            change.clear();
            setVariableName(secret.variableName);
          }}
        />
      </DialogForm>
    </FormDialog>
  );
}

function ValueDialog({
  workspaceId,
  secret,
  take,
  close,
}: {
  workspaceId: string;
  secret: SecretSummary;
  take: boolean;
  close: () => void;
}) {
  const api = useSecretsApi(workspaceId);
  const change = useChange(close);
  const [value, setValue] = useState<SecretValue>(emptyValue(secret.kind));
  const [attempted, setAttempted] = useState(false);
  const error = valueError(value);
  return (
    <FormDialog
      title={take ? `Take ownership of ${secret.name}` : `Replace ${secret.name}`}
      description={
        take
          ? 'Its owner left. Enter a new value to become the owner. Everything else stays the same.'
          : 'The old value stops working right away. Everything else stays the same.'
      }
      close={close}
      dirty={hasValue(value)}
    >
      <DialogForm
        submitLabel={take ? 'Take ownership' : 'Replace value'}
        sendingLabel="Saving…"
        sending={change.sending}
        error={change.error}
        close={close}
        onSubmit={() => {
          setAttempted(true);
          if (error) return;
          void change.run(
            () =>
              take
                ? api.takeOwnership(secret.id, secret.version, value)
                : api.replace(secret.id, secret.version, value),
            undefined,
            () => setValue(emptyValue(secret.kind)),
          );
        }}
      >
        <SecretValueInput
          kind={secret.kind}
          label="New key or token"
          value={value}
          error={attempted ? (error ?? undefined) : undefined}
          disabled={change.sending}
          onChange={next => {
            change.clear();
            setValue(next);
          }}
        />
      </DialogForm>
    </FormDialog>
  );
}

function DestinationsDialog({
  workspaceId,
  secret,
  close,
}: {
  workspaceId: string;
  secret: SecretSummary;
  close: () => void;
}) {
  const api = useSecretsApi(workspaceId);
  const change = useChange(close);
  const [list, setList] = useState(secret.destinations.map(destination => destination.value));
  const [attempted, setAttempted] = useState(false);
  const error = destinationsError(list);
  return (
    <FormDialog
      title={`Where ${secret.name} is used`}
      description="It's only sent to these websites or APIs. Changes take effect right away."
      close={close}
    >
      <DialogForm
        submitLabel="Save"
        sendingLabel="Saving…"
        sending={change.sending}
        error={change.error}
        close={close}
        onSubmit={() => {
          setAttempted(true);
          if (error) return;
          void change.run(() =>
            api.destinations(secret.id, secret.policyVersion, list.filter(item => item.trim()).map(destinationInput)),
          );
        }}
      >
        <DestinationsEditor
          value={list}
          error={attempted ? error : null}
          disabled={change.sending}
          onChange={next => {
            change.clear();
            setList(next);
          }}
        />
      </DialogForm>
    </FormDialog>
  );
}

function SharingDialog({
  workspaceId,
  secret,
  people,
  close,
}: {
  workspaceId: string;
  secret: SecretSummary;
  people: People;
  close: () => void;
}) {
  const api = useSecretsApi(workspaceId);
  const change = useChange(close);
  const [grants, setGrants] = useState(secret.grants);
  return (
    <FormDialog title={`Who can use ${secret.name}`} close={close}>
      <DialogForm
        submitLabel="Save"
        sendingLabel="Saving…"
        sending={change.sending}
        error={change.error}
        close={close}
        onSubmit={() => void change.run(() => api.grants(secret.id, secret.policyVersion, grants))}
      >
        <GrantsEditor
          value={grants}
          owner={secret.ownerMembershipId}
          people={people}
          disabled={change.sending}
          onChange={next => {
            change.clear();
            setGrants(next);
          }}
        />
      </DialogForm>
    </FormDialog>
  );
}

function ExpiryDialog({
  workspaceId,
  secret,
  save,
  close,
}: {
  workspaceId: string;
  secret: SecretSummary;
  save: boolean;
  close: () => void;
}) {
  const api = useSecretsApi(workspaceId);
  const change = useChange(close);
  const [name, setName] = useState(secret.name);
  const [expiry, setExpiry] = useState<ExpiryChoice>({
    preset: save || !secret.expiresAt ? 'none' : 'keep',
    custom: '',
  });
  const [attempted, setAttempted] = useState(false);
  const error = expiryError(expiry);
  const temporary = secret.lifetime === 'conversation' && !save;
  const id = useId();
  const nameError = attempted && !name.trim() ? 'Give it a name.' : null;
  return (
    <FormDialog
      title={save ? `Save ${secret.name}` : `When to delete ${secret.name}`}
      description={
        save
          ? "Keep it after this chat to reuse and share it. You don't need to enter it again."
          : "Once it's deleted, agents can't use it."
      }
      close={close}
    >
      <DialogForm
        submitLabel={save ? 'Save to my secrets' : 'Save'}
        sendingLabel="Saving…"
        sending={change.sending}
        error={change.error}
        close={close}
        onSubmit={() => {
          setAttempted(true);
          if (error || !name.trim()) return;
          const expiresAt = expiryAt(expiry, secret.expiresAt);
          void change.run(() =>
            save
              ? api.save(secret.id, secret.policyVersion, { name: name.trim(), expiresAt })
              : api.expiry(secret.id, secret.policyVersion, expiresAt),
          );
        }}
      >
        {save && (
          <Labelled id={`${id}-name`} label="Name" error={nameError}>
            <Input
              id={`${id}-name`}
              value={name}
              maxLength={80}
              autoComplete="off"
              aria-invalid={!!nameError}
              aria-describedby={describedBy(`${id}-name`, null, nameError)}
              disabled={change.sending}
              onChange={event => setName(event.target.value)}
            />
          </Labelled>
        )}
        <ExpiryPicker
          allowNone={!temporary}
          current={secret.expiresAt}
          value={expiry}
          error={attempted ? error : null}
          helper={temporary ? 'A secret for one chat is always deleted at some point.' : undefined}
          disabled={change.sending}
          onChange={next => {
            change.clear();
            setExpiry(next);
          }}
        />
      </DialogForm>
    </FormDialog>
  );
}

function DeleteDialog({
  workspaceId,
  secret,
  close,
}: {
  workspaceId: string;
  secret: SecretSummary;
  close: () => void;
}) {
  const api = useSecretsApi(workspaceId);
  const change = useChange(close);
  return (
    <AlertDialog
      open
      onOpenChange={open => {
        if (!open && !change.sending) close();
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>Delete {secret.name}?</AlertDialogTitle>
        <AlertDialogDescription>
          Agents stop using it at once, and anything that relies on it will fail. This cannot be undone.
        </AlertDialogDescription>
        {change.error && (
          <Alert variant="destructive">
            <AlertDescription>{change.error}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={change.sending}>Keep secret</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={change.sending}
            aria-busy={change.sending}
            onClick={() =>
              void change.run(() => api.remove(secret.id, secret.version), undefined, undefined, {
                id: secret.id,
                edit: () => null,
              })
            }
          >
            {change.sending ? 'Deleting…' : 'Delete secret'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const operations: Record<string, string> = {
  created: 'Added',
  replaced: 'Value replaced',
  'destinations-changed': 'Websites changed',
  'grants-changed': 'Sharing changed',
  'expiry-changed': 'Delete time changed',
  saved: 'Saved for reuse',
  'ownership-taken': 'Ownership taken',
  used: 'Used',
  deleted: 'Deleted',
};

function CopyableName({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex items-center gap-1">
      <span className="min-w-0 break-all font-mono">{value}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={copied ? 'Copied' : `Copy ${value}`}
        title={copied ? 'Copied' : 'Copy'}
        onClick={() =>
          void navigator.clipboard.writeText(value).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => undefined,
          )
        }
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </Button>
    </span>
  );
}

function DetailsDialog({
  workspaceId,
  secret,
  people,
  close,
}: {
  workspaceId: string;
  secret: SecretSummary;
  people: People;
  close: () => void;
}) {
  const rows: [string, ReactNode][] = [
    ['Variable name', <CopyableName key="variable" value={secret.variableName} />],
    ['Type', kindLabels[secret.kind]],
    [
      "How it's sent",
      `Sent ${placementPhrase(secret.placement)}${secret.placementSource === 'agent' ? ', as the agent asked' : ''}`,
    ],
    [
      'Used with',
      <ul key="destinations" className="space-y-0.5">
        {secret.destinations.map(destination => (
          <li key={destination.value} className="break-all font-mono">
            {destinationLabel(destination)}
          </li>
        ))}
      </ul>,
    ],
    ['Owner', people.name(secret.ownerMembershipId)],
    ['Kept for', secret.lifetime === 'saved' ? 'Until deleted' : 'One chat or task'],
    ['Added', formatDate(secret.createdAt)],
    ['Last replaced', secret.replacedAt ? formatDate(secret.replacedAt) : 'Never'],
    ['Auto-delete', secret.expiresAt ? formatDate(secret.expiresAt) : 'Never'],
    ['Last used', secret.lastUsedAt ? formatDate(secret.lastUsedAt) : 'Not yet'],
  ];
  return (
    <FormDialog title={secret.name} description="The value is never shown." close={close}>
      <div className="space-y-6">
        <dl className="grid grid-cols-3 gap-x-4 gap-y-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="col-span-2 min-w-0 break-words">{value}</dd>
            </div>
          ))}
        </dl>
        {secret.canManage && <History workspaceId={workspaceId} secretId={secret.id} people={people} />}
      </div>
    </FormDialog>
  );
}

function History({ workspaceId, secretId, people }: { workspaceId: string; secretId: string; people: People }) {
  const read = useSecretHistory(workspaceId, secretId);
  return (
    <section aria-labelledby="secret-history" className="space-y-2">
      <h3 id="secret-history" className="text-sm font-medium">
        History
      </h3>
      {read.state.kind === 'loading' ? (
        <Skeleton />
      ) : read.state.kind !== 'ready' ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Could not load the history.</p>
          <Button variant="outline" size="sm" onClick={() => void read.refresh()}>
            Try again
          </Button>
        </div>
      ) : read.state.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
        <ul className="space-y-2">
          {read.state.data.map((event, index) => (
            <li key={`${event.createdAt}:${index}`} className="text-sm">
              <span className="font-medium">{operations[event.operation] ?? 'Changed'}</span>
              {event.actorMembershipId && (
                <span className="text-muted-foreground"> by {people.name(event.actorMembershipId)}</span>
              )}
              <span className="text-muted-foreground"> · {formatDate(event.createdAt)}</span>
              {event.operation === 'used' && typeof event.details.url === 'string' && (
                <span className="block break-all font-mono text-xs text-muted-foreground">
                  {typeof event.details.tool === 'string' ? `${event.details.tool} · ` : ''}
                  {event.details.url}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
