import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { canonicalEmail } from '@tulipfarm/workspaces/canonical-email';
import { createdInvitationSchema, type PolicyPermission } from '@tulipfarm/workspaces/governance-contracts';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Label } from '@tulipfarm/sprout/label';
import { RadioGroup, RadioGroupItem } from '@tulipfarm/sprout/radio-group';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from '@tulipfarm/sprout/combobox';
import {
  parseRecipients,
  sendInvitationBatch,
  type InvitationReceipt,
  type RecipientRow,
  type RecipientState,
} from '@/lib/invitation-batch';
import { governancePath, governanceRequest, GovernanceRequestError } from '@/lib/governance';
import { invitationMemberResolver } from '@/features/tables/invitation-member';
import { tableKeys } from '@/features/tables/queries';
import { TableRequestError } from '@/features/tables/request-state';
import { useInvitations } from '@/features/governance/invitations';
import { joinList, permissionSummary, scopeTarget, type PolicyRow } from '@/features/access/policies';
import { NoPolicies, PolicyEditor, PolicyTable, scopeChoices, type ScopeChoice } from '@/features/access/policy-table';
import type { AccessPage } from './governance';

const failureMessages = {
  'access-lost': 'you no longer have admin access',
  'rate-limited': 'the hourly invite limit was reached; try again later',
  invalid: 'this isn’t a valid email address',
  uncertain: 'we couldn’t confirm the invite. Trying again won’t create a duplicate',
  'member-conflict': 'their member record is linked to someone else',
  'member-unavailable': 'their member record couldn’t be saved',
};
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const roleDescriptions = {
  member: 'Uses the tables their teams and policies give them, and can create teams.',
  admin: 'Manages members, teams and access to every table.',
};

type TeamChoice = { id: string; role: 'member' | 'manager' };
type DraftPolicy = { scope: ScopeChoice; permissions: PolicyPermission[] };

export function InviteMembers({ page }: { page: AccessPage }) {
  const { workspaceId, workspaceSlug, admin, data } = page;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const anchor = useComboboxAnchor();
  const emailInput = useRef<HTMLInputElement>(null);
  const invitations = useInvitations(workspaceId, admin, page.accessLost, '', true);
  const [emails, setEmails] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [duplicates, setDuplicates] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [suggesting, setSuggesting] = useState(false);
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [teams, setTeams] = useState<TeamChoice[]>([]);
  const [policies, setPolicies] = useState<DraftPolicy[]>([]);
  const [editor, setEditor] = useState<{ initial: DraftPolicy | null } | null>(null);
  const [rows, setRows] = useState<RecipientRow[]>([]);
  const [sending, setSending] = useState(false);
  const pending = useRef(false);
  const operations = useRef(new Map<string, RecipientRow>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    emailInput.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);
  const locked = sending || !admin;
  const members = new Set(data.directory.map(member => canonicalEmail(member.email)));
  const invited = new Set(
    (invitations.data?.items ?? [])
      .filter(item => item.status === 'active' && item.email)
      .map(item => canonicalEmail(item.email!)),
  );
  const flag = (email: string) =>
    members.has(canonicalEmail(email)) ? 'member' : invited.has(canonicalEmail(email)) ? 'invited' : null;
  const alreadyMembers = emails.filter(email => flag(email) === 'member');
  const alreadyInvited = emails.filter(email => flag(email) === 'invited');
  const sendable = emails.filter(email => flag(email) !== 'member');
  const typed = parseRecipients(query);
  const suggestions = typed.recipients.filter(email => !emails.includes(email));
  const status = new Map(rows.map(row => [row.email, row.state.kind]));
  const teamNames = new Map(data.teams.map(team => [team.id, team.name]));
  const choices = scopeChoices(data);
  const key = (scope: ScopeChoice) => `${scope.kind}:${scope.id}`;

  function commit(text: string) {
    const parsed = parseRecipients(text.replace(/[;\s]+/g, '\n'));
    const added = parsed.recipients.filter(email => !emails.includes(email));
    const repeated = parsed.recipients.filter(email => emails.includes(email));
    const next = [...emails, ...added];
    setEmails(next);
    setDuplicates([...new Set([...parsed.duplicates, ...repeated])]);
    setQuery(parsed.invalid.join(', '));
    setError(parsed.invalid.length ? `${joinList(parsed.invalid)} isn’t a valid email address.` : undefined);
    return { emails: next, invalid: parsed.invalid };
  }
  function changeEmails(next: string[]) {
    const removed = emails.filter(email => !next.includes(email));
    for (const email of removed) {
      const operation = operations.current.get(email);
      if (!(operation?.state.kind === 'failed' && operation.state.code === 'uncertain'))
        operations.current.delete(email);
    }
    setRows(current => current.filter(row => !removed.includes(row.email)));
    setEmails(next);
    setQuery('');
    setError(undefined);
    setDuplicates([]);
  }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if ((event.key !== 'Enter' && event.key !== 'Tab') || !query.trim()) return;
    if (event.key === 'Tab' && (event.shiftKey || !typed.recipients.length)) return;
    event.preventDefault();
    commit(query);
  }
  function paste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData('text');
    if (!/[,;\s]/.test(text.trim())) return;
    event.preventDefault();
    commit(`${query}\n${text}`);
  }

  const teamText = (choices: TeamChoice[]) =>
    joinList(
      choices.map(team => `${teamNames.get(team.id) ?? 'a team'}${team.role === 'manager' ? ' (Manager)' : ''}`),
    );
  const roleLabel = role === 'admin' ? 'Admin' : 'Member';
  const summary = sendable.length
    ? `${plural(sendable.length, 'person', 'people')} will join as ${roleLabel}${
        teams.length ? `, in ${teamText(teams)}` : ''
      }${policies.length ? `, with ${plural(policies.length, 'direct policy', 'direct policies')}` : ''}.`
    : 'Add email addresses to see who will join.';

  async function send(commands: RecipientRow[]) {
    if (pending.current || !admin) return;
    pending.current = true;
    setSending(true);
    const memberRows = invitationMemberResolver(workspaceId);
    let lost = false;
    const lose = () => {
      lost = true;
      page.accessLost();
      return { kind: 'failed', code: 'access-lost' } as const;
    };
    const choicesBody = {
      role,
      teams,
      policies: policies.map(policy => ({
        scope: { kind: policy.scope.kind, id: policy.scope.id },
        permissions: policy.permissions,
      })),
    };
    const outcomes = new Map<string, RecipientState>();
    try {
      await sendInvitationBatch(
        commands,
        async command => {
          if (lost) return { kind: 'failed', code: 'access-lost' };
          if (!command.workspaceMemberId) {
            try {
              command.workspaceMemberId = await memberRows.resolve(command);
            } catch (failure) {
              if (failure instanceof TableRequestError) {
                if (failure.status === 401 || failure.status === 403) return lose();
                if (failure.status === 429) return { kind: 'failed', code: 'rate-limited' };
              }
              return { kind: 'failed', code: 'member-unavailable' };
            }
          }
          try {
            const result = createdInvitationSchema.parse(
              await governanceRequest(`${governancePath(workspaceId)}/invitations`, 'POST', {
                kind: 'email',
                email: command.email,
                requestId: command.requestId,
                workspaceMemberId: command.workspaceMemberId,
                ...choicesBody,
              }),
            );
            if (result.outcome !== 'already-member') invitations.record(result.invitation);
            return {
              kind: 'success',
              result:
                result.outcome === 'already-member'
                  ? result
                  : { outcome: result.outcome, invitationId: result.invitation.id },
            };
          } catch (failure) {
            if (failure instanceof GovernanceRequestError) {
              if ([401, 403, 404].includes(failure.status)) return lose();
              if (failure.status === 429) return { kind: 'failed', code: 'rate-limited' };
              if (failure.status === 400) return { kind: 'failed', code: 'invalid' };
              if (
                failure.status === 409 &&
                ['member-link-conflict', 'member-selection-required', 'member-unavailable'].includes(failure.code)
              )
                return { kind: 'failed', code: 'member-conflict' };
            }
            return { kind: 'failed', code: 'uncertain' };
          }
        },
        (command, state) => {
          outcomes.set(command.email, state);
          if (state.kind === 'success') operations.current.delete(command.email);
          else operations.current.set(command.email, { ...command, state });
          if (!alive.current) return;
          setRows(previous => previous.map(row => (row.requestId === command.requestId ? { ...row, state } : row)));
        },
      );
      void invitations.refresh();
      for (const tableId of memberRows.created)
        void queryClient.invalidateQueries({ queryKey: tableKeys.records(tableId) });
      if (memberRows.created.size) void queryClient.invalidateQueries({ queryKey: tableKeys.picker });
    } finally {
      pending.current = false;
      if (alive.current) setSending(false);
    }
    const done = [...outcomes].filter(([, state]) => state.kind === 'success');
    const outcomeOf = (outcome: InvitationReceipt['outcome']) =>
      done.filter(([, state]) => state.kind === 'success' && state.result.outcome === outcome).map(([email]) => email);
    const invitedNow = [...outcomeOf('created'), ...outcomeOf('pending')];
    const updated = outcomeOf('updated');
    const choiceText = `${roleLabel}${teams.length ? `, in ${teamText(teams)}` : ''}${
      policies.length ? `, with ${plural(policies.length, 'direct policy', 'direct policies')}` : ''
    }`;
    const joined = done
      .filter(([, state]) => state.kind === 'success' && state.result.outcome === 'already-member')
      .map(([email]) => email);
    const confirmation = [
      invitedNow.length &&
        `Invited ${joinList(invitedNow)} as ${choiceText}. They show as Pending until they accept. ${
          invitedNow.length === 1 ? 'Their invite email is on its way.' : 'Their invite emails are on their way.'
        }`,
      updated.length &&
        `Replaced the pending ${updated.length === 1 ? 'invite' : 'invites'} for ${joinList(updated)}. They’ll join as ${choiceText}. ${
          updated.length === 1
            ? 'Their old link no longer works. We’re sending a new invite email.'
            : 'Their old links no longer work. We’re sending new invite emails.'
        }`,
      joined.length && `${joinList(joined)} ${joined.length === 1 ? 'is already a member' : 'are already members'}.`,
    ]
      .filter(Boolean)
      .join(' ');
    const everyone = commands.every(command => outcomes.get(command.email)?.kind === 'success');
    if (everyone && alive.current) {
      page.flash(confirmation);
      void navigate({ to: '/$workspaceSlug/members', params: { workspaceSlug } });
      return;
    }
    if (!alive.current) return;
    setEmails(current => current.filter(email => outcomes.get(email)?.kind !== 'success'));
    if (confirmation) page.notify(confirmation);
  }

  function submit() {
    if (pending.current || !admin) return;
    const draft = query.trim() ? commit(query) : { emails, invalid: [] };
    if (draft.invalid.length) return;
    const ready = draft.emails.filter(email => flag(email) !== 'member');
    if (!ready.length) {
      setError(
        draft.emails.length ? 'Everyone you’ve entered is already a member.' : 'Add at least one email address.',
      );
      emailInput.current?.focus();
      return;
    }
    const next = ready.map(
      email =>
        operations.current.get(email) ??
        ({
          email,
          requestId: crypto.randomUUID(),
          memberRequestId: crypto.randomUUID(),
          memberRecordId: crypto.randomUUID(),
          state: { kind: 'queued' },
        } satisfies RecipientRow),
    );
    for (const row of next) operations.current.set(row.email, row);
    setRows(previous => [...previous.filter(row => !ready.includes(row.email)), ...next]);
    void send(next);
  }

  const failures = rows.filter(row => row.state.kind === 'failed');
  const policyRows: PolicyRow[] = policies.map(policy => ({
    key: key(policy.scope),
    scope: policy.scope,
    permissions: policy.permissions,
    source: { kind: 'direct' },
  }));
  if (!admin)
    return (
      <Alert>
        <AlertDescription>Only admins can invite people to this workspace.</AlertDescription>
      </Alert>
    );
  return (
    <form
      aria-label="Invite members"
      className="flex max-w-3xl flex-col gap-8"
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}
    >
      <section className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="invitation-emails">Email addresses</Label>
        <Combobox
          multiple
          items={suggestions}
          filter={null}
          autoHighlight
          value={emails}
          onValueChange={(next, details) => {
            if (details.reason === 'escape-key') details.allowPropagation();
            else changeEmails(next as string[]);
          }}
          inputValue={query}
          onInputValueChange={(next, details) => {
            if (details.reason === 'input-clear' && query) return;
            if (/[,;\s]/.test(next)) commit(next);
            else {
              setQuery(next);
              setError(undefined);
            }
          }}
          open={suggesting && suggestions.length > 0}
          onOpenChange={setSuggesting}
          disabled={locked}
        >
          <ComboboxChips ref={anchor}>
            <ComboboxValue>
              {(values: string[]) =>
                values.map(email => {
                  const state = status.get(email);
                  const flagged = flag(email);
                  return (
                    <ComboboxChip
                      key={email}
                      data-status={flagged === 'member' ? 'failed' : state === 'success' ? undefined : state}
                      title={
                        flagged === 'member'
                          ? 'Already a member'
                          : flagged === 'invited'
                            ? 'Already invited. Inviting again replaces their invite.'
                            : undefined
                      }
                      showRemove={!locked}
                    >
                      {email}
                      {flagged && (
                        <span className="sr-only">
                          ,{' '}
                          {flagged === 'member'
                            ? 'already a member'
                            : 'already invited, inviting again replaces their invite'}
                        </span>
                      )}
                    </ComboboxChip>
                  );
                })
              }
            </ComboboxValue>
            <ComboboxChipsInput
              id="invitation-emails"
              ref={emailInput}
              type="email"
              autoComplete="off"
              placeholder={emails.length ? 'Add email' : 'name@company.com'}
              aria-invalid={error ? true : undefined}
              aria-describedby="invitation-emails-hint invitation-emails-flags"
              onKeyDown={keyDown}
              onPaste={paste}
              onBlur={() => {
                if (typed.recipients.length) commit(query);
              }}
            />
          </ComboboxChips>
          <ComboboxContent anchor={anchor}>
            <ComboboxList>
              {(email: string) => (
                <ComboboxItem key={email} value={email}>
                  Invite {email}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        <p
          id="invitation-emails-hint"
          role={error ? 'alert' : undefined}
          className={error ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}
        >
          {error ?? 'Press Enter, Tab or comma after each address, or paste a list.'}
        </p>
        <div id="invitation-emails-flags" className="flex flex-col gap-1 text-sm text-destructive">
          {duplicates.length > 0 && <p>Already in the list: {joinList(duplicates)}.</p>}
          {alreadyMembers.length > 0 && (
            <p>
              Already {alreadyMembers.length === 1 ? 'a member' : 'members'}: {joinList(alreadyMembers)}. They won’t be
              invited.
            </p>
          )}
        </div>
        {alreadyInvited.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Already invited: {joinList(alreadyInvited)}. Inviting them again sends a new link with only these choices.
            Their current link will stop working.
          </p>
        )}
      </section>

      <fieldset className="flex flex-col gap-3">
        <legend id="invite-role" className="mb-2 font-medium">
          Role
        </legend>
        <RadioGroup
          aria-labelledby="invite-role"
          value={role}
          onValueChange={value => setRole(value as 'member' | 'admin')}
          disabled={locked}
        >
          <div className="flex flex-col gap-3">
            {(['member', 'admin'] as const).map(value => (
              <div key={value} className="flex items-start gap-3">
                <RadioGroupItem
                  id={`invite-role-${value}`}
                  value={value}
                  aria-describedby={`invite-role-${value}-help`}
                />
                <div className="flex flex-col gap-0.5">
                  <Label htmlFor={`invite-role-${value}`}>{value === 'admin' ? 'Admin' : 'Member'}</Label>
                  <p id={`invite-role-${value}-help`} className="text-sm text-muted-foreground">
                    {roleDescriptions[value]}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </RadioGroup>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 font-medium">Teams</legend>
        <p className="text-sm text-muted-foreground">
          They join these teams when they accept, and get the access each team has.
        </p>
        {data.teams.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            There are no teams yet.{' '}
            <span className="underline underline-offset-4">
              <Link to="/$workspaceSlug/teams" params={{ workspaceSlug }}>
                Create a team
              </Link>
            </span>
          </p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border">
            {data.teams.map(team => {
              const chosen = teams.find(choice => choice.id === team.id);
              return (
                <li key={team.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                  <div className="flex items-center gap-3">
                    <Checkbox
                      id={`invite-team-${team.id}`}
                      checked={!!chosen}
                      disabled={locked}
                      onCheckedChange={checked =>
                        setTeams(current =>
                          checked
                            ? [...current, { id: team.id, role: 'member' }]
                            : current.filter(choice => choice.id !== team.id),
                        )
                      }
                    />
                    <Label htmlFor={`invite-team-${team.id}`}>
                      <span className="wrap-anywhere">{team.name}</span>
                    </Label>
                  </div>
                  {chosen && (
                    <Select
                      value={chosen.role}
                      disabled={locked}
                      onValueChange={value =>
                        setTeams(current =>
                          current.map(choice =>
                            choice.id === team.id ? { ...choice, role: value as TeamChoice['role'] } : choice,
                          ),
                        )
                      }
                    >
                      <SelectTrigger size="sm" aria-label={`Team role in ${team.name}`}>
                        <SelectValue>{chosen.role === 'manager' ? 'Manager' : 'Member'}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="manager">Manager</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>

      <section aria-labelledby="invite-policies" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 id="invite-policies" className="font-medium">
              Access policies (optional)
            </h2>
            <p className="text-sm text-muted-foreground">
              Give access to a table directly, on top of what their teams give them.
            </p>
          </div>
          <Button variant="outline" disabled={locked} onClick={() => setEditor({ initial: null })}>
            Add policy
          </Button>
        </div>
        <PolicyTable
          label="Direct access policies for the people you’re inviting"
          subject="the invitees"
          rows={policyRows}
          workspaceSlug={workspaceSlug}
          editable={() => !locked}
          showSource={false}
          onEdit={row => {
            const policy = policies.find(item => key(item.scope) === row.key);
            if (policy) setEditor({ initial: policy });
          }}
          onRemove={async row => {
            setPolicies(current => current.filter(item => key(item.scope) !== row.key));
            return { ok: true };
          }}
          empty={
            <NoPolicies
              title="No direct policies"
              description="They’ll get only the access their role and teams give them."
            />
          }
        />
      </section>

      <section aria-label="Summary" className="flex flex-col gap-3 border-t pt-6">
        <p className="font-medium" aria-live="polite">
          {summary}
        </p>
        {failures.length > 0 && !sending && (
          <Alert variant="destructive">
            <AlertDescription>
              <p>
                Couldn’t invite {plural(failures.length, 'person', 'people')}. Their addresses are still in the list, so
                you can try again.
              </p>
              <ul className="mt-1 list-disc pl-5">
                {failures.map(row => (
                  <li key={row.email}>
                    {row.email}: {row.state.kind === 'failed' ? failureMessages[row.state.code] : ''}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={locked || !sendable.length} aria-busy={sending}>
            {sending && <Spinner aria-hidden="true" />}
            {sending ? 'Inviting…' : sendable.length > 1 ? `Invite ${sendable.length} people` : 'Invite'}
          </Button>
          <Button
            variant="ghost"
            disabled={sending}
            nativeButton={false}
            render={<Link to="/$workspaceSlug/members" params={{ workspaceSlug }} />}
          >
            Cancel
          </Button>
        </div>
      </section>

      <PolicyEditor
        open={editor !== null}
        onOpenChange={open => {
          if (!open) setEditor(null);
        }}
        subject="the invitees"
        choices={choices}
        initial={editor?.initial ?? null}
        existing={new Map(policies.map(policy => [key(policy.scope), policy.permissions]))}
        save={async (scope, permissions) => {
          setPolicies(current =>
            [...current.filter(item => key(item.scope) !== key(scope)), { scope, permissions }].sort((a, b) =>
              scopeTarget(a.scope).localeCompare(scopeTarget(b.scope)),
            ),
          );
          page.notify(
            scope.kind === 'collection'
              ? `Added a policy: create tables owned by ${scope.name}. It applies when they accept.`
              : `Added a policy: ${permissionSummary(permissions)} on ${scopeTarget(scope)}. It applies when they accept.`,
          );
          return { ok: true };
        }}
      />
    </form>
  );
}
