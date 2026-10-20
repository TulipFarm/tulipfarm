import { useEffect, useRef, useState } from 'react';
import { createdInvitationSchema, type GovernanceSnapshot } from '@tulipfarm/workspaces/governance-contracts';
import { Plus, X } from 'lucide-react';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Field } from '@tulipfarm/sprout/field';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@tulipfarm/sprout/dialog';
import {
  parseRecipients,
  sendInvitationBatch,
  type RecipientRow,
  type RecipientCommand,
  type RecipientState,
} from '@/lib/invitation-batch';
import { governancePath, governanceRequest, GovernanceRequestError } from '@/lib/governance';
import { InvitationActions } from './invitation-actions';
import type { InvitationAdministration } from './use-invitation-administration';
import { Link } from '@tanstack/react-router';
import { workspaceRoute } from '@/router';
import { InviteMembersCanvas } from './invite-members-canvas';
import { WorkspaceMemberPicker } from '@/features/tables/member-picker';

const failureMessages = {
  'access-lost': 'Admin access could not be confirmed. Restore access before retrying.',
  'rate-limited': 'Invitation limit reached. Wait before retrying. Up to 20 requests per hour are allowed.',
  invalid: 'This recipient was rejected. Check the email address.',
  uncertain: 'The outcome is unknown. Retry safely with the same request.',
  'member-conflict':
    'This member cannot be linked to this invitation. Review their current access or choose another member.',
};

export function InviteMembersDialog({
  workspaceId,
  authorized,
  onAccessLost,
  invitations,
  open,
  onOpenChange: setOpen,
  members,
  initialInput = '',
}: {
  workspaceId: string;
  authorized: boolean;
  onAccessLost: () => void;
  invitations: InvitationAdministration;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: GovernanceSnapshot['directory'];
  initialInput?: string;
}) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const [input, setInput] = useState(initialInput);
  const [rows, setRows] = useState<RecipientRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [validated, setValidated] = useState(false);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const pending = useRef(false);
  const operations = useRef(new Map<string, RecipientRow>());
  const access = useRef(authorized);
  access.current = authorized;
  useEffect(
    () => () => {
      access.current = false;
    },
    [],
  );
  const parsed = parseRecipients(input);
  const missingMember = parsed.recipients.some(
    email => !selections[email] && !operations.current.get(email)?.workspaceMemberId,
  );
  const addresses = input.split('\n');
  function editAddress(index: number, value: string) {
    setInput(previous =>
      previous
        .split('\n')
        .map((email, i) => (i === index ? value.replaceAll(',', '\n') : email))
        .join('\n'),
    );
  }
  function removeAddress(index: number) {
    setInput(previous =>
      previous
        .split('\n')
        .filter((_, i) => i !== index)
        .join('\n'),
    );
    requestAnimationFrame(() => document.getElementById(`invitation-email-${Math.max(0, index - 1)}`)?.focus());
  }
  const update = (command: RecipientCommand, state: RecipientState) => {
    if (state.kind === 'success') {
      operations.current.delete(command.email);
      setInput(previous =>
        previous
          .split(/[,\n]/)
          .map(value => value.trim())
          .filter(value => value && value.toLowerCase() !== command.email)
          .join('\n'),
      );
    } else operations.current.set(command.email, { ...command, state });
    setRows(previous => previous.map(row => (row.requestId === command.requestId ? { ...row, state } : row)));
  };
  async function send(commands: RecipientCommand[]) {
    if (pending.current || !access.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await sendInvitationBatch(
        commands,
        async command => {
          if (!access.current) return { kind: 'failed', code: 'access-lost' };
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
          } catch (error) {
            if (error instanceof GovernanceRequestError) {
              if ([401, 403, 404].includes(error.status)) {
                access.current = false;
                onAccessLost();
                return { kind: 'failed', code: 'access-lost' };
              }
              if (error.status === 429) return { kind: 'failed', code: 'rate-limited' };
              if (error.status === 400) return { kind: 'failed', code: 'invalid' };
              if (
                error.status === 409 &&
                ['member-link-conflict', 'member-selection-required', 'member-unavailable'].includes(error.code)
              )
                return { kind: 'failed', code: 'member-conflict' };
            }
            return { kind: 'failed', code: 'uncertain' };
          }
        },
        update,
      );
      void invitations.refresh();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function submit() {
    if (pending.current || !access.current) return;
    if (parsed.invalid.length || !parsed.recipients.length || missingMember) {
      setValidated(true);
      return 'invalid';
    }
    setValidated(false);
    const next = parsed.recipients.map(
      email =>
        operations.current.get(email) ??
        ({
          email,
          requestId: crypto.randomUUID(),
          workspaceMemberId: selections[email]!,
          state: { kind: 'queued' },
        } satisfies RecipientRow),
    );
    for (const row of next) operations.current.set(row.email, row);
    setRows(previous => [...previous.filter(row => !parsed.recipients.includes(row.email)), ...next]);
    void send(next.filter(row => row.state.kind !== 'success'));
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {authorized && <DialogTrigger render={<Button />}>Invite members</DialogTrigger>}
      <DialogContent size="split">
        <div className="grid min-w-0 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-6 p-6 sm:p-8">
            <DialogHeader>
              <DialogTitle>Invite members</DialogTitle>
              <DialogDescription>
                Grant access to an existing workspace member. Select each person, then enter the email for their
                invitation. Links last seven days.
              </DialogDescription>
            </DialogHeader>
            {!authorized && (
              <Alert variant="destructive">
                <AlertDescription>
                  Admin access is unavailable. Your entered addresses and request keys are kept here. Refresh access
                  before retrying.
                </AlertDescription>
              </Alert>
            )}
            <Form label="Invite members" disabled={busy || !authorized} onSubmit={submit}>
              <div className="flex min-w-0 flex-col gap-4">
                <fieldset className="flex min-w-0 flex-col gap-3">
                  <legend className="mb-3 text-sm font-medium">Email addresses</legend>
                  {addresses.map((email, index) => {
                    const key = email.trim().toLowerCase(),
                      operation = operations.current.get(key);
                    const selectionLocked =
                      operation?.state.kind === 'sending' ||
                      operation?.state.kind === 'queued' ||
                      (operation?.state.kind === 'failed' && operation.state.code === 'uncertain');
                    return (
                      <div key={index} className="space-y-3">
                        <div className="flex min-w-0 items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <Field
                              id={`invitation-email-${index}`}
                              label={`Email ${index + 1}`}
                              labelVisibility="screen-reader"
                              required
                              error={
                                validated &&
                                (parsed.invalid.includes(email.trim()) ||
                                  (!parsed.recipients.length && index === 0 && !email.trim()))
                                  ? 'Enter a valid email address.'
                                  : undefined
                              }
                            >
                              <Input
                                type="email"
                                autoComplete="off"
                                value={email}
                                onChange={event => editAddress(index, event.target.value)}
                                onPaste={event => {
                                  const text = event.clipboardData.getData('text');
                                  if (/[,\n]/.test(text)) {
                                    event.preventDefault();
                                    editAddress(index, text.trim());
                                  }
                                }}
                                placeholder="teammate@example.com"
                              />
                            </Field>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={busy || !authorized || (addresses.length === 1 && !email)}
                            aria-label={`Remove email ${index + 1}`}
                            onClick={() => removeAddress(index)}
                          >
                            <X size={16} aria-hidden="true" />
                          </Button>
                        </div>
                        {email.trim() && (
                          <WorkspaceMemberPicker
                            workspaceId={workspaceId}
                            workspaceSlug={workspaceSlug}
                            id={`invitation-member-${index}`}
                            value={operation?.workspaceMemberId ?? selections[key] ?? ''}
                            disabled={busy || !authorized || selectionLocked}
                            error={
                              validated && !selections[key] && !operation?.workspaceMemberId
                                ? 'Choose the workspace member for this email.'
                                : undefined
                            }
                            onChange={memberId => {
                              const key = email.trim().toLowerCase(),
                                previous = operations.current.get(key);
                              if (previous?.state.kind === 'failed' && previous.state.code === 'uncertain') return;
                              operations.current.delete(key);
                              setRows(current => current.filter(row => row.email !== key));
                              setSelections(current => ({ ...current, [key]: memberId }));
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
                </fieldset>
                <div>
                  <Button
                    variant="ghost"
                    disabled={busy || !authorized}
                    onClick={() => {
                      setInput(previous => `${previous}\n`);
                      requestAnimationFrame(() =>
                        document.getElementById(`invitation-email-${addresses.length}`)?.focus(),
                      );
                    }}
                  >
                    <Plus size={16} aria-hidden="true" />
                    Add another
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Paste a list with commas or newlines. Everyone joins as a member; team access is added later.
                </p>
                <div id="recipient-validation" className="flex flex-col gap-2 text-xs text-muted-foreground">
                  {parsed.duplicates.length > 0 && (
                    <p>Duplicates removed: {[...new Set(parsed.duplicates)].join(', ')}.</p>
                  )}
                </div>
                <FormFooter
                  dirty={false}
                  layout="stack"
                  note="Drafts stay here until you leave Members. Sending is subject to hourly limits."
                  error={
                    validated && (parsed.invalid.length || !parsed.recipients.length || missingMember)
                      ? 'Check each email address and select its workspace member.'
                      : undefined
                  }
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
            {rows.length > 0 && (
              <section aria-label="Invitation results" className="flex flex-col gap-3">
                <h3 className="font-medium">Invitation results</h3>
                <p role="status">
                  {rows.filter(row => row.state.kind === 'success').length} of {rows.length} recipients confirmed. Email
                  delivery is tracked separately in Invitations.
                </p>
                <ul className="divide-y divide-border">
                  {rows.map(row => {
                    const invitation =
                      row.state.kind === 'success' && row.state.result.outcome !== 'already-member'
                        ? invitations.resolve(row.state.result.invitationId)
                        : undefined;
                    return (
                      <li key={row.requestId} className="flex flex-col gap-2 py-3">
                        <p className="break-all font-medium">{row.email}</p>
                        {row.state.kind === 'queued' && <p>Waiting to send.</p>}
                        {row.state.kind === 'sending' && <p role="status">Sending invitation…</p>}
                        {row.state.kind === 'failed' && (
                          <>
                            <p role="alert">{failureMessages[row.state.code]}</p>
                            <Button
                              variant="outline"
                              disabled={busy || !authorized}
                              aria-label={`Retry invitation for ${row.email}`}
                              onClick={() => void send([row])}
                            >
                              Retry invitation
                            </Button>
                          </>
                        )}
                        {row.state.kind === 'success' && (
                          <>
                            <p>
                              {row.state.result.outcome === 'already-member'
                                ? 'Already a member.'
                                : row.state.result.outcome === 'pending'
                                  ? 'Already invited. Use Resend to send a new email and replace the active link.'
                                  : 'Invitation saved. Check delivery status in Invitations.'}
                            </p>
                            {authorized && invitation && (
                              <>
                                <p>Invitation {invitation.status}.</p>
                                <InvitationActions
                                  key={invitation.id}
                                  item={invitation}
                                  workspaceId={workspaceId}
                                  onAccessLost={onAccessLost}
                                  invitations={invitations}
                                />
                              </>
                            )}
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {authorized && rows.some(row => row.state.kind === 'success') && (
                  <div className="space-y-2">
                    <p className="text-base">
                      After each person accepts, add them to a team to grant business access. Existing members can be
                      added now.
                    </p>
                    <Button
                      variant="outline"
                      disabled={busy}
                      nativeButton={false}
                      render={<Link to="/$workspaceSlug/teams" params={{ workspaceSlug }} />}
                    >
                      Manage teams
                    </Button>
                  </div>
                )}
              </section>
            )}
          </div>
          <InviteMembersCanvas members={members} recipients={parsed.recipients} rows={rows} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
