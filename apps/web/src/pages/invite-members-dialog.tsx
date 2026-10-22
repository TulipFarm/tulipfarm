import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createdInvitationSchema, type GovernanceSnapshot } from '@tulipfarm/workspaces/governance-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Label } from '@tulipfarm/sprout/label';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@tulipfarm/sprout/dialog';
import { parseRecipients, sendInvitationBatch, type RecipientRow, type RecipientState } from '@/lib/invitation-batch';
import { governancePath, governanceRequest, GovernanceRequestError } from '@/lib/governance';
import { invitationMemberResolver } from '@/features/tables/invitation-member';
import { tableKeys } from '@/features/tables/queries';
import { TableRequestError } from '@/features/tables/request-state';
import type { InvitationAdministration } from './use-invitation-administration';
import { CheckIcon, CircleAlertIcon } from 'lucide-react';
import { InviteMembersCanvas } from './invite-members-canvas';
import './invite-members-dialog.css';

const failureMessages = {
  'access-lost': 'admin access was lost',
  'rate-limited': 'hourly limit reached, try again later',
  invalid: 'address rejected',
  uncertain: 'not confirmed, retrying is safe',
  'member-conflict': 'member record is linked to someone else',
  'member-unavailable': 'member record could not be saved',
};
type FailureCode = keyof typeof failureMessages;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** One line for everything that went through: "3 invitations sent. 1 already a member." */
function sentSummary(rows: RecipientRow[]) {
  const outcomes = rows.flatMap(row => (row.state.kind === 'success' ? [row.state.result.outcome] : []));
  const members = outcomes.filter(outcome => outcome === 'already-member').length;
  const pending = outcomes.filter(outcome => outcome === 'pending').length;
  const sent = outcomes.length - members - pending;
  return [
    sent && `${plural(sent, 'invitation', 'invitations')} sent.`,
    pending && `${plural(pending, 'person was', 'people were')} already invited.`,
    members && `${plural(members, 'person is', 'people are')} already a member.`,
  ]
    .filter(Boolean)
    .join(' ');
}

function merge(current: string[], added: string[]) {
  const duplicates = added.filter(email => current.includes(email));
  return { emails: [...current, ...added.filter(email => !current.includes(email))], duplicates };
}

export function InviteMembersDialog({
  workspaceId,
  authorized,
  onAccessLost,
  invitations,
  open,
  onOpenChange: setOpen,
  onViewInvitations,
  members,
  initialInput = '',
}: {
  workspaceId: string;
  authorized: boolean;
  onAccessLost: () => void;
  invitations: InvitationAdministration;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onViewInvitations: () => void;
  members: GovernanceSnapshot['directory'];
  initialInput?: string;
}) {
  const queryClient = useQueryClient();
  const anchor = useComboboxAnchor();
  const emailInput = useRef<HTMLInputElement>(null);
  const [initial] = useState(() => parseRecipients(initialInput));
  const [emails, setEmails] = useState(initial.recipients);
  const [query, setQuery] = useState(initial.invalid.join(', '));
  const [duplicates, setDuplicates] = useState(initial.duplicates);
  const [error, setError] = useState<string>();
  const [suggesting, setSuggesting] = useState(false);
  const [rows, setRows] = useState<RecipientRow[]>([]);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const operations = useRef(new Map<string, RecipientRow>());
  const session = useRef(0);
  const access = useRef(authorized);
  access.current = authorized;
  useEffect(
    () => () => {
      access.current = false;
    },
    [],
  );
  // Closing starts a fresh draft; sends still in flight must not repopulate it.
  const wasOpen = useRef(open);
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closed) return;
    session.current += 1;
    operations.current.clear();
    setEmails([]);
    setQuery('');
    setDuplicates([]);
    setError(undefined);
    setRows([]);
  }, [open]);
  const locked = busy || !authorized;
  const typed = parseRecipients(query);
  const suggestions = typed.recipients.filter(email => !emails.includes(email));
  const status = new Map(rows.map(row => [row.email, row.state.kind]));

  /** Moves valid addresses out of `text` into chips and leaves the rest typed. */
  function commit(text: string) {
    const parsed = parseRecipients(text.replace(/[;\s]+/g, '\n'));
    const next = merge(emails, parsed.recipients);
    setEmails(next.emails);
    setDuplicates([...new Set([...parsed.duplicates, ...next.duplicates])]);
    setQuery(parsed.invalid.join(', '));
    setError(
      parsed.invalid.length ? `Check ${parsed.invalid.join(', ')}. It is not a valid email address.` : undefined,
    );
    return { emails: next.emails, invalid: parsed.invalid };
  }
  function changeEmails(next: string[]) {
    const removed = emails.filter(email => !next.includes(email));
    for (const email of removed) {
      const operation = operations.current.get(email);
      if (!(operation?.state.kind === 'failed' && operation.state.code === 'uncertain'))
        operations.current.delete(email);
    }
    setRows(current => current.filter(row => !removed.includes(row.email) || row.state.kind === 'success'));
    setEmails(next);
    setQuery('');
    setError(undefined);
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

  const update = (command: RecipientRow, state: RecipientState, current: number) => {
    if (current !== session.current) return;
    if (state.kind === 'success') {
      operations.current.delete(command.email);
      setEmails(current => current.filter(email => email !== command.email));
    } else operations.current.set(command.email, { ...command, state });
    setRows(previous => previous.map(row => (row.requestId === command.requestId ? { ...row, state } : row)));
  };
  async function send(commands: RecipientRow[]) {
    if (pending.current || !access.current) return;
    pending.current = true;
    setBusy(true);
    const current = session.current;
    const memberRows = invitationMemberResolver(workspaceId);
    const lose = () => {
      access.current = false;
      onAccessLost();
      return { kind: 'failed', code: 'access-lost' } as const;
    };
    try {
      await sendInvitationBatch(
        commands,
        async command => {
          if (!access.current) return { kind: 'failed', code: 'access-lost' };
          if (!command.workspaceMemberId) {
            try {
              // Retries and later sends reuse the resolved member.
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
              }),
            );
            if (result.outcome === 'already-member') return { kind: 'success', result };
            invitations.record(result.invitation);
            return { kind: 'success', result: { outcome: result.outcome, invitationId: result.invitation.id } };
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
        (command, state) => update(command, state, current),
      );
      void invitations.refresh();
      for (const tableId of memberRows.created)
        void queryClient.invalidateQueries({ queryKey: tableKeys.records(tableId) });
      if (memberRows.created.size) void queryClient.invalidateQueries({ queryKey: tableKeys.picker });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function submit() {
    if (pending.current || !access.current) return;
    const draft = query.trim() ? commit(query) : { emails, invalid: [] };
    if (draft.invalid.length) return 'invalid';
    if (!draft.emails.length) {
      setError('Add at least one email address.');
      return 'invalid';
    }
    const next = draft.emails.map(
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
    setRows(previous => [...previous.filter(row => !draft.emails.includes(row.email)), ...next]);
    void send(next.filter(row => row.state.kind !== 'success'));
  }
  const failures = new Map<FailureCode, RecipientRow[]>();
  for (const row of rows)
    if (row.state.kind === 'failed') failures.set(row.state.code, [...(failures.get(row.state.code) ?? []), row]);
  const failureOf = (email: string) => {
    const row = rows.find(item => item.email === email);
    return row?.state.kind === 'failed' ? `Not sent: ${failureMessages[row.state.code]}` : undefined;
  };
  const summary = busy ? '' : sentSummary(rows);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {authorized && <DialogTrigger render={<Button />}>Invite members</DialogTrigger>}
      <DialogContent size="split" initialFocus={emailInput}>
        <div className="grid min-w-0 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-6 p-6 sm:p-8">
            <DialogHeader>
              <DialogTitle>Invite members</DialogTitle>
              <DialogDescription>
                Each person is added to Workspace members and gets an email link that lasts seven days.
              </DialogDescription>
            </DialogHeader>
            {!authorized && (
              <Alert variant="destructive">
                <AlertDescription>
                  Admin access is unavailable. Your addresses are kept here. Refresh access before retrying.
                </AlertDescription>
              </Alert>
            )}
            <Form label="Invite members" disabled={locked} onSubmit={submit}>
              <div className="flex min-w-0 flex-col gap-6">
                <div className="invite-email-field flex min-w-0 flex-col gap-2">
                  <Label htmlFor="invitation-emails">Email addresses</Label>
                  <Combobox
                    multiple
                    items={suggestions}
                    filter={null}
                    autoHighlight
                    value={emails}
                    onValueChange={(next, details) => {
                      // Base UI clears every chip on Escape; keep the draft and let Escape close the dialog.
                      if (details.reason === 'escape-key') details.allowPropagation();
                      else changeEmails(next as string[]);
                    }}
                    inputValue={query}
                    onInputValueChange={(next, details) => {
                      // Base UI clears unmatched text when the popup closes; typed addresses must survive.
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
                          values.map(email => (
                            <ComboboxChip
                              key={email}
                              data-status={status.get(email) === 'success' ? undefined : status.get(email)}
                              title={failureOf(email)}
                              showRemove={!locked}
                            >
                              {email}
                            </ComboboxChip>
                          ))
                        }
                      </ComboboxValue>
                      <ComboboxChipsInput
                        id="invitation-emails"
                        ref={emailInput}
                        type="email"
                        autoComplete="off"
                        placeholder={emails.length ? 'Add email' : 'name@company.com'}
                        aria-invalid={error ? true : undefined}
                        aria-describedby="invitation-emails-hint"
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
                    hidden={!error && !duplicates.length && Boolean(summary || failures.size)}
                    id="invitation-emails-hint"
                    role={error ? 'alert' : undefined}
                    className={error ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}
                  >
                    {error ??
                      (duplicates.length
                        ? `Already added: ${duplicates.join(', ')}.`
                        : summary || failures.size
                          ? undefined
                          : 'Press Enter, Tab or comma after each address, or paste a list.')}
                  </p>
                  {(summary || (!busy && failures.size > 0)) && (
                    <section aria-label="Invitation results" className="flex min-w-0 flex-col gap-1 text-sm">
                      {summary && (
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2">
                          <CheckIcon aria-hidden className="size-4 shrink-0 text-primary" />
                          <p role="status">{summary}</p>
                          <Button variant="link" size="sm" onClick={onViewInvitations}>
                            View invitations
                          </Button>
                        </div>
                      )}
                      {[...failures].map(([code, failed]) => (
                        <div key={code} className="flex min-w-0 items-center gap-2">
                          <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-destructive" />
                          <p role="alert" className="min-w-0 flex-1 text-destructive">
                            {failed.length} not sent: {failureMessages[code]}.
                          </p>
                          <Button
                            variant="link"
                            size="sm"
                            disabled={locked}
                            aria-label={
                              failed.length === 1
                                ? `Retry invitation for ${failed[0]!.email}`
                                : `Retry ${failed.length} invitations`
                            }
                            onClick={() => void send(failed)}
                          >
                            Retry
                          </Button>
                        </div>
                      ))}
                    </section>
                  )}
                </div>
                <FormFooter
                  dirty={false}
                  layout="stack"
                  submit={{
                    label: 'Send invitations',
                    pendingLabel: 'Sending invitations…',
                    state: busy
                      ? { kind: 'busy' }
                      : !authorized
                        ? { kind: 'blocked', reason: 'Admin access is required.' }
                        : { kind: 'ready' },
                  }}
                >
                  <Button variant="ghost" onClick={() => setOpen(false)}>
                    Not now
                  </Button>
                </FormFooter>
              </div>
            </Form>
          </div>
          <InviteMembersCanvas members={members} recipients={emails} rows={rows} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
