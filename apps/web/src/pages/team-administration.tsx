import { Table } from '@tulipfarm/sprout/table';
import { PageActions } from '@tulipfarm/sprout/page-header';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { GovernanceSnapshot, Team } from '@tulipfarm/workspaces/governance-contracts';
import { Add } from 'reicon-react/icons/Add';
import { People } from 'reicon-react/icons/People';
import { TeamsSample } from '@/components/empty-samples';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { Label } from '@tulipfarm/sprout/label';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { teamRoleSchema } from '@tulipfarm/workspaces/governance-contracts';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@tulipfarm/sprout/dialog';
import type { GovernanceChange } from './member-administration';
import { UnsavedChanges } from '@/features/tables/feedback';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@tulipfarm/sprout/alert-dialog';

type Props = { data: GovernanceSnapshot | null; busy: boolean; change: GovernanceChange; recovery: ReactNode };
type Details = Pick<Team, 'name' | 'description'>;
type Draft = { expected: Details; values: Details };
const sameDetails = (first: Details, second: Details) =>
  first.name === second.name && first.description === second.description;
type FieldError = 'duplicate-team-name' | 'invalid-team-name' | 'invalid-team-description' | null;
const fieldError = (result: Awaited<ReturnType<GovernanceChange>>): FieldError =>
  result === 'duplicate-team-name' || result === 'invalid-team-name' || result === 'invalid-team-description'
    ? result
    : null;

function TeamFields({
  id,
  details,
  setDetails,
  disabled,
  error,
  preserveFocus = false,
}: {
  id: string;
  details: Details;
  setDetails: (details: Details) => void;
  disabled: boolean;
  error: FieldError;
  preserveFocus?: boolean;
}) {
  const nameError =
    error === 'duplicate-team-name'
      ? 'A team already uses this name. Choose a different name.'
      : error === 'invalid-team-name'
        ? 'Enter a name of 1 to 80 characters.'
        : null;
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-name`}>{id === 'new-team' ? 'New team name' : 'Team name'}</Label>
        <Input
          id={`${id}-name`}
          required
          maxLength={80}
          value={details.name}
          disabled={disabled && !preserveFocus}
          readOnly={disabled && preserveFocus}
          aria-invalid={Boolean(nameError)}
          aria-describedby={nameError ? `${id}-name-error` : undefined}
          onChange={event => setDetails({ ...details, name: event.target.value })}
        />
        {nameError && (
          <p id={`${id}-name-error`} role="alert">
            {nameError}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-description`}>Description (optional)</Label>
        <Textarea
          id={`${id}-description`}
          maxLength={1000}
          value={details.description}
          disabled={disabled && !preserveFocus}
          readOnly={disabled && preserveFocus}
          aria-invalid={error === 'invalid-team-description'}
          aria-describedby={`${id}-description-help`}
          onChange={event => setDetails({ ...details, description: event.target.value })}
        />
        <p
          id={`${id}-description-help`}
          role={error === 'invalid-team-description' ? 'alert' : undefined}
          className="text-sm text-muted-foreground"
        >
          {error === 'invalid-team-description'
            ? 'Enter a description of up to 1,000 characters.'
            : 'Up to 1,000 characters.'}
        </p>
      </div>
    </>
  );
}

export function TeamConfirmation({
  label,
  title,
  description,
  busy,
  run,
  recovery,
}: {
  label: string;
  title: string;
  description: string;
  busy: boolean;
  run: () => ReturnType<GovernanceChange>;
  recovery?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const lock = useRef(false);
  return (
    <Dialog
      open={open}
      onOpenChange={value => {
        if (!lock.current) {
          setOpen(value);
          setFailure(null);
        }
      }}
    >
      <DialogTrigger ref={trigger} render={<Button variant="outline" disabled={busy} />}>
        {label}
      </DialogTrigger>
      <DialogContent
        finalFocus={() =>
          trigger.current?.isConnected ? trigger.current : document.getElementById('governance-heading')
        }
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        {recovery && <div>{recovery}</div>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy || pending}
            aria-busy={pending}
            onClick={async () => {
              if (lock.current) return;
              lock.current = true;
              setPending(true);
              setFailure(null);
              try {
                const result = await run();
                if (result === 'saved') setOpen(false);
                else
                  setFailure(
                    result === 'team-owns-tables'
                      ? 'This team owns tables and cannot be deleted.'
                      : result === 'team-owns-agents'
                        ? 'This team owns active agents and cannot be deleted.'
                        : result === 'team-owns-integrations'
                          ? 'This team owns active integrations and cannot be deleted.'
                          : 'The change was not confirmed. Close this dialog and refresh access before retrying.',
                  );
              } finally {
                lock.current = false;
                setPending(false);
              }
            }}
          >
            {pending ? 'Saving change…' : `Confirm ${label.toLowerCase()}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function TeamAdministration({ data, busy, change, recovery }: Props) {
  const [details, setDetails] = useState<Details>({ name: '', description: '' });
  const [unconfirmed, setUnconfirmed] = useState<(Details & { id: string }) | null>(null);
  const [error, setError] = useState<FieldError>(null);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [transition, setTransition] = useState<{ nextId: string | null } | null>(null);
  const detailTriggers = useRef(new Map<string, HTMLButtonElement>());
  const returnTo = useRef<string | null>(null);
  function selectTeam(nextId: string | null) {
    if (nextId === selectedId) return;
    if (editorDirty) {
      setTransition({ nextId });
      return;
    }
    if (nextId === null && selectedId) detailTriggers.current.get(selectedId)?.focus();
    setSelectedId(nextId);
  }
  const previous = useRef<GovernanceSnapshot | null>(null);
  const wasAuthorized = useRef(data !== null);
  const pending = useRef(false);
  if (data) previous.current = data;
  const retained = data ?? previous.current;
  const selected = retained?.teams.find(team => team.id === selectedId);
  const authorized = data !== null;
  useEffect(() => {
    if (wasAuthorized.current && !authorized) document.getElementById('governance-heading')?.focus();
    wasAuthorized.current = authorized;
  }, [authorized]);
  useEffect(() => {
    if (unconfirmed && data?.teams.some(team => team.id === unconfirmed.id)) {
      setUnconfirmed(null);
      setDetails({ name: '', description: '' });
      setSelectedId(unconfirmed.id);
      setCreating(false);
    }
  }, [data, unconfirmed]);
  async function create() {
    if (pending.current || !data || editorDirty || busy) return;
    pending.current = true;
    const command = unconfirmed ?? {
      id: crypto.randomUUID(),
      name: details.name.trim(),
      description: details.description.trim(),
    };
    try {
      const result = await change(`/teams/${command.id}`, 'PUT', {
        name: command.name,
        description: command.description,
      });
      setError(fieldError(result));
      if (result === 'saved') {
        setUnconfirmed(null);
        setDetails({ name: '', description: '' });
        setSelectedId(command.id);
        setCreating(false);
      } else if (result === 'uncertain' || (unconfirmed && result === 'rejected')) setUnconfirmed(command);
      else setUnconfirmed(null);
    } finally {
      pending.current = false;
    }
  }
  return (
    <>
      <UnsavedChanges dirty={editorDirty || !!details.name || !!details.description || !!unconfirmed} />
      {data && (
        <section aria-label="Team administration" className="flex flex-col gap-6">
          <PageActions>
            <Dialog
              open={creating}
              onOpenChange={open => {
                if (!busy) setCreating(open);
              }}
            >
              <DialogTrigger render={<Button disabled={busy || editorDirty} />}>New team</DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>New team</DialogTitle>
                  <DialogDescription>
                    You become this team's first manager. Add workspace members and appoint other managers after
                    creating it.
                  </DialogDescription>
                </DialogHeader>
                <form
                  className="flex flex-col gap-3"
                  onSubmit={event => {
                    event.preventDefault();
                    void create();
                  }}
                >
                  <TeamFields
                    id="new-team"
                    details={details}
                    setDetails={value => {
                      setDetails(value);
                      setError(null);
                    }}
                    disabled={busy || unconfirmed !== null}
                    error={error}
                  />
                  {unconfirmed && (
                    <p role="status">
                      Creation is unconfirmed. Retry the same creation to recover its result. Your name and description
                      are retained.
                    </p>
                  )}
                  {editorDirty && (
                    <p className="text-sm text-muted-foreground">
                      Save or close the current team details before creating another team.
                    </p>
                  )}
                  <div>
                    <Button type="submit" disabled={busy || editorDirty || !details.name.trim()} aria-busy={busy}>
                      {unconfirmed ? 'Retry creating team' : 'Create team'}
                    </Button>
                  </div>
                </form>
                {recovery && <div>{recovery}</div>}
              </DialogContent>
            </Dialog>
          </PageActions>
          {!data.teams.length ? (
            <StatePanel
              kind="empty"
              icon={People}
              title="No teams yet"
              description="Create a team to collaborate and share access. A team manager can also add you to an existing team."
              sample={<TeamsSample />}
            >
              <Button disabled={busy || editorDirty} onClick={() => setCreating(true)}>
                <Add size={16} aria-hidden="true" />
                Create a team
              </Button>
            </StatePanel>
          ) : (
            <Table
              aria-label="Teams"
              narrow="stack"
              data={data.teams}
              getRowId={team => team.id}
              rowLabel={team => team.name}
              columns={[
                {
                  key: 'name',
                  header: 'Name',
                  cell: team => (
                    <Button
                      variant="link"
                      size="task-link"
                      ref={node => {
                        if (node) detailTriggers.current.set(team.id, node);
                        else detailTriggers.current.delete(team.id);
                      }}
                      disabled={busy}
                      onClick={() => selectTeam(team.id)}
                      aria-label={`View ${team.name} details`}
                      aria-expanded={selectedId === team.id}
                    >
                      {team.name}
                    </Button>
                  ),
                },
                {
                  key: 'description',
                  header: 'Description',
                  cell: team => (
                    <span className="line-clamp-2 text-muted-foreground wrap-anywhere">
                      {team.description || 'No description'}
                    </span>
                  ),
                },
                { key: 'membershipIds', header: 'Members', cell: team => team.membershipIds.length },
                { key: 'canManage', header: 'Your role', cell: team => (team.canManage ? 'Manager' : 'Member') },
              ]}
            />
          )}
        </section>
      )}
      {selected && retained && (
        <TeamEditor
          key={selected.id}
          team={selected}
          data={retained}
          authorized={data !== null}
          busy={busy}
          change={change}
          recovery={recovery}
          onDirty={setEditorDirty}
          onClose={() => selectTeam(null)}
        />
      )}
      <AlertDialog
        open={transition !== null}
        onOpenChange={open => {
          if (!open) setTransition(null);
        }}
      >
        <AlertDialogContent
          finalFocus={() => (returnTo.current ? (detailTriggers.current.get(returnTo.current) ?? false) : false)}
        >
          <AlertDialogTitle>Discard team edits?</AlertDialogTitle>
          <AlertDialogDescription>
            Your unsaved name, description, and member selection will be cleared. Saved team changes remain.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                returnTo.current = selectedId;
              }}
            >
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!transition) return;
                const nextId = transition.nextId;
                returnTo.current = nextId ?? selectedId;
                setTransition(null);
                setEditorDirty(false);
                setSelectedId(nextId);
              }}
            >
              Discard edits
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function TeamEditor({
  team,
  data,
  authorized,
  busy,
  change,
  recovery,
  onDirty,
  onClose,
}: {
  team: Team;
  data: GovernanceSnapshot;
  authorized: boolean;
  busy: boolean;
  change: GovernanceChange;
  recovery: ReactNode;
  onDirty: (dirty: boolean) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [rejectedVersion, setRejectedVersion] = useState(false);
  const current = { name: team.name, description: team.description };
  const details = draft?.values ?? current;
  const edit = (values: Details) => {
    const expected = draft?.expected ?? current;
    setDraft(sameDetails(values, expected) ? null : { expected, values });
    setError(null);
  };
  const conflict = rejectedVersion || (draft !== null && !sameDetails(draft.expected, current));
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const [error, setError] = useState<FieldError>(null);
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    onDirty(draft !== null || selection.length > 0);
  }, [draft, selection, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  const pending = useRef(false);
  const roster = data.directory.filter(member => team.membershipIds.includes(member.id));
  const candidates = data.directory.filter(member => !team.membershipIds.includes(member.id));
  const visible = candidates.filter(member =>
    `${member.name} ${member.email}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  useEffect(() => {
    setSelection(current =>
      current.filter(id => data.directory.some(member => member.id === id) && !team.membershipIds.includes(id)),
    );
  }, [data.directory, team.membershipIds]);
  if (!authorized) return null;
  return (
    <section aria-label="Team details" className="flex flex-col gap-5 border-t border-border pt-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 ref={heading} tabIndex={-1} className="break-words text-sm font-medium">
          {team.name} details
        </h2>
        <Button variant="ghost" disabled={busy || adding} onClick={onClose}>
          Close details
        </Button>
      </header>
      {!team.canManage && (
        <p className="text-sm text-muted-foreground">
          {team.description || 'No description'}. A team manager controls membership and team details.
        </p>
      )}
      {team.canManage && (
        <>
          <p className="break-all text-sm text-muted-foreground">Team ID: {team.id}</p>
          {draft && (
            <p role="status" className="text-sm text-muted-foreground">
              Unsaved team details
            </p>
          )}
          <form
            className="flex flex-col gap-3"
            onSubmit={async event => {
              event.preventDefault();
              if (pending.current || conflict || busy) return;
              pending.current = true;
              try {
                const result = await change(`/teams/${team.id}/name`, 'PUT', {
                  ...details,
                  expected: draft?.expected ?? current,
                });
                setError(fieldError(result));
                if (result === 'saved') {
                  setDraft(null);
                  setRejectedVersion(false);
                } else if (result === 'team-details-conflict') setRejectedVersion(true);
              } finally {
                pending.current = false;
              }
            }}
          >
            <TeamFields
              id={team.id}
              details={details}
              setDetails={edit}
              disabled={busy || adding}
              preserveFocus
              error={error}
            />
            {conflict && (
              <>
                <Alert variant="destructive">
                  <AlertDescription>
                    Team details changed since you started editing. Your draft is kept. Review the current name and
                    description below before saving.
                  </AlertDescription>
                </Alert>
                <dl className="flex flex-col gap-2">
                  <dt className="font-medium">Current name</dt>
                  <dd className="break-words">{current.name}</dd>
                  <dt className="font-medium">Current description</dt>
                  <dd className="break-words">{current.description || 'No description'}</dd>
                </dl>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || adding}
                    onClick={() => {
                      setDraft(null);
                      setRejectedVersion(false);
                      setError(null);
                      document.getElementById(`${team.id}-name`)?.focus();
                    }}
                  >
                    Use current details
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || adding}
                    onClick={() => {
                      setDraft({ expected: current, values: details });
                      setRejectedVersion(false);
                      document.getElementById(`${team.id}-name`)?.focus();
                    }}
                  >
                    Keep draft after review
                  </Button>
                </div>
              </>
            )}
            <div>
              <Button
                type="submit"
                variant="outline"
                disabled={busy || adding || conflict || !details.name.trim()}
                aria-busy={busy}
              >
                Save team details
              </Button>
            </div>
          </form>
        </>
      )}
      <h3 className="text-sm font-medium">Team members ({roster.length})</h3>
      {!roster.length ? (
        <StatePanel
          kind="empty"
          heading="h3"
          icon={People}
          title="No members yet"
          description="A team manager can add workspace members."
        />
      ) : (
        <ul className="divide-y divide-border">
          {roster.map(member => {
            const manager = team.managerIds.includes(member.id);
            const lastManager = manager && team.managerIds.length === 1;
            return (
              <li key={member.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="break-words font-medium">{member.name || member.email}</p>
                  <p className="break-all text-muted-foreground">
                    {member.email} · {manager ? 'Manager' : 'Member'}
                  </p>
                </div>
                {team.canManage && (
                  <div className="flex flex-wrap items-center gap-3">
                    <Label htmlFor={`role-${team.id}-${member.id}`}>Team role for {member.name || member.email}</Label>
                    <Select
                      value={manager ? 'manager' : 'member'}
                      disabled={busy || adding || lastManager}
                      onValueChange={value => {
                        if (value)
                          void change(`/teams/${team.id}/members/${member.id}/role`, 'PUT', {
                            role: teamRoleSchema.parse(value),
                          });
                      }}
                    >
                      <SelectTrigger id={`role-${team.id}-${member.id}`}>
                        <SelectValue>{manager ? 'Manager' : 'Member'}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="manager">Manager</SelectItem>
                      </SelectContent>
                    </Select>
                    <TeamConfirmation
                      label={`Remove ${member.name || member.email}`}
                      title={`Remove ${member.name || member.email} from ${team.name}?`}
                      description="They will lose access supplied by this team. Their workspace membership and other teams remain. A team manager can add them back."
                      busy={busy || adding || lastManager}
                      recovery={recovery}
                      run={() => change(`/teams/${team.id}/members/${member.id}`, 'PUT', { enrolled: false })}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!team.canLeave && <p role="status">Appoint another manager before leaving or changing your manager role.</p>}
      <div>
        <TeamConfirmation
          label="Leave team"
          title={`Leave ${team.name}?`}
          description="You will lose access supplied by this team. A team manager can add you back."
          busy={busy || adding || !team.canLeave}
          recovery={recovery}
          run={() => change(`/teams/${team.id}/leave`, 'POST')}
        />
      </div>
      {team.canManage && (
        <>
          <fieldset disabled={busy || adding} className="flex flex-col gap-3">
            <legend className="mb-3 text-sm font-medium">Add members</legend>
            <Label htmlFor={`search-${team.id}`}>Search workspace members</Label>
            <Input
              id={`search-${team.id}`}
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Name or email"
            />
            {!candidates.length ? (
              <p>All current workspace members belong to this team.</p>
            ) : !visible.length ? (
              <StatePanel
                kind="empty"
                heading="h3"
                icon={People}
                title="No members match"
                description="Try another name or email."
              >
                <Button variant="outline" onClick={() => setSearch('')}>
                  Clear search
                </Button>
              </StatePanel>
            ) : (
              visible.map(member => (
                <div key={member.id} className="flex items-center gap-3">
                  <Checkbox
                    id={`add-${team.id}-${member.id}`}
                    checked={selection.includes(member.id)}
                    onCheckedChange={checked =>
                      setSelection(current =>
                        checked ? [...current, member.id] : current.filter(id => id !== member.id),
                      )
                    }
                  />
                  <Label htmlFor={`add-${team.id}-${member.id}`}>
                    {member.name || member.email} ({member.email})
                  </Label>
                </div>
              ))
            )}
            <div>
              <Button
                disabled={busy || adding || !selection.length}
                aria-busy={adding}
                onClick={async () => {
                  if (pending.current) return;
                  pending.current = true;
                  setAdding(true);
                  try {
                    for (const id of selection) {
                      const result = await change(`/teams/${team.id}/members/${id}`, 'PUT', { enrolled: true });
                      if (result !== 'saved') break;
                      setSelection(current => current.filter(value => value !== id));
                    }
                  } finally {
                    pending.current = false;
                    setAdding(false);
                  }
                }}
              >
                {adding ? 'Adding members…' : `Add selected members (${selection.length})`}
              </Button>
            </div>
          </fieldset>
          <div>
            <TeamConfirmation
              label="Delete team"
              title={`Delete ${team.name}?`}
              description="This removes the team, its enrollments, and its team-derived grants. People remain in the workspace. Teams that own tables, agents, or integrations cannot be deleted."
              busy={busy || adding}
              recovery={recovery}
              run={() => change(`/teams/${team.id}`, 'DELETE')}
            />
          </div>
        </>
      )}
    </section>
  );
}
