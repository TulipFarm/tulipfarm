import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'reicon-react/icons/Check';
import { Database } from 'reicon-react/icons/Database';
import { Refresh } from 'reicon-react/icons/Refresh';
import { SidebarRight } from 'reicon-react/icons/SidebarRight';
import { Link } from '@tanstack/react-router';
import { workspaceRoute } from '@/router';
import { Button } from '@tulipfarm/sprout/button';
import { Badge } from '@tulipfarm/sprout/badge';
import { ReviewCard } from '@tulipfarm/sprout/review-card';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Disclosure } from '@/components/disclosure';
import { Table } from '@tulipfarm/sprout/table';
import { TableRead, WriteFeedback } from '@/features/tables/feedback';
import {
  useTableProposalOutcome,
  useTableProposal,
  useTableProposalEffects,
  useTableProposalCommand,
} from '@/features/tables/hooks';
import { proposalProgressing as progressing, type ProposalIdentity } from '@/features/tables/queries';
import { proposalApi, type ProposalApi } from '@/features/tables/proposal-api';
import { memberMessages } from '@/features/tables/api';
import { formatTableValue, rowLabel } from '@/features/tables/definition-view';
import { useOptionalCanvas, useResultAttention } from './canvas-state';
import { schemaCanvasItem } from './schema-canvas';
import { useApprovalDockEntry } from './approval-dock';
import type { ImportProgress, ProposalCommand, ProposalView, ReviewedPlan } from '@/features/tables/review-contracts';

const statusLabels = {
  pending: 'Awaiting your review',
  approved: 'Approved, waiting to start',
  running: 'Applying changes',
  rejected: 'Rejected',
  cancelled: 'Cancelled at a safe checkpoint',
  expired: 'Expired',
  partial: 'Partially completed',
  failed: 'Execution failed',
  completed: 'Completed',
};

const importedRecords = ({ applied, remaining }: ImportProgress) =>
  `${applied.toLocaleString()} of ${(applied + remaining).toLocaleString()} rows imported. ${remaining.toLocaleString()} not yet imported.`;

function planOutcome({ receipt, importProgress }: ProposalView['plans'][number]) {
  if (receipt?.status === 'completed') return `Applied${receipt.revision ? ` at revision ${receipt.revision}` : ''}`;
  const imported = importProgress?.applied ? importedRecords(importProgress) : null;
  if (receipt?.status === 'failed')
    return `Failed. ${memberMessages[receipt.code] ?? `Reference ${receipt.code}.`} ${importProgress ? (imported ?? 'No rows were imported.') : 'Completed tables are unchanged.'}`;
  return imported ?? 'Not yet completed';
}

function applicationNote(plans: readonly ReviewedPlan[]) {
  const notes = [];
  if (plans.some(plan => plan.input.kind !== 'import'))
    notes.push(
      'Schema and row changes apply atomically for each table, and completed tables stay applied if later work stops.',
    );
  if (plans.some(plan => plan.input.kind === 'import'))
    notes.push('Imports apply in batches, and imported rows stay applied if later work stops.');
  return [...notes, 'Approval does not grant missing permission.'].join(' ');
}

type ProposalCardProps = {
  workspaceId: string;
  chatId: string;
  id: string;
  userId: string;
  membershipId?: string | null | undefined;
  order?: number;
};

export function TableProposalCard({
  workspaceId,
  chatId,
  id,
  userId,
  membershipId,
  order = 0,
  correct,
}: ProposalCardProps & { correct: () => void }) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const api = useMemo(() => proposalApi(workspaceId, chatId, id), [workspaceId, chatId, id]);
  const read = useTableProposalOutcome(api, { chatId, proposalId: id });
  return (
    <section aria-label={read.state.kind === 'ready' ? undefined : 'Table change proposal'}>
      <TableRead state={read.state} refresh={read.refresh}>
        {outcome =>
          outcome.kind === 'proposal' ? (
            <ValidTableProposalCard
              workspaceId={workspaceId}
              chatId={chatId}
              id={id}
              userId={userId}
              membershipId={membershipId}
              order={order}
            />
          ) : (
            <section
              aria-label="Blocked table changes"
              className="my-3 min-w-0 space-y-4 rounded-xl border border-border bg-card p-4"
            >
              <h2 className="text-base font-medium">Correct invalid rows before proposing again</h2>
              <Badge variant="warning">Changes blocked</Badge>
              <p className="text-sm">
                This attempt left the schema and rows unchanged. No proposal is available to approve.
              </p>
              <p className="text-sm">
                {outcome.report.total.toLocaleString()} invalid {outcome.report.total === 1 ? 'row' : 'rows'}. Showing{' '}
                {outcome.report.records.length.toLocaleString()}
                {outcome.report.truncated ? ' of them' : ''}, with the first error for each row.
              </p>
              <Table
                aria-label="Invalid rows"
                data={outcome.report.records}
                getRowId={record => record.recordId}
                columns={[
                  {
                    key: 'recordId',
                    header: 'Row ID',
                    cell: record => <span className="break-all font-mono text-xs">{record.recordId}</span>,
                  },
                  {
                    key: 'fieldId',
                    header: 'Field ID',
                    cell: record => (
                      <span className="break-all font-mono text-xs">{record.fieldId ?? 'Row validation'}</span>
                    ),
                  },
                  { key: 'code', header: 'Error', cell: record => <span className="break-words">{record.code}</span> },
                ]}
              />
              <p className="text-sm text-muted-foreground">
                Tell the assistant how to correct the values or conversion rules, then ask for a new proposal. Further
                field errors may appear after these are corrected.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={correct}>Continue in chat</Button>
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={
                    <Link
                      to="/$workspaceSlug/tables/$tableId"
                      params={{ workspaceSlug, tableId: outcome.report.tableId }}
                    />
                  }
                >
                  Open table
                </Button>
                <Button
                  variant="ghost"
                  disabled={read.state.kind === 'ready' && read.state.refreshing}
                  onClick={() => void read.refresh()}
                >
                  Check report access
                </Button>
              </div>
            </section>
          )
        }
      </TableRead>
    </section>
  );
}

function proposalTitle(plans: readonly ReviewedPlan[]) {
  const [plan] = plans;
  if (plans.length !== 1 || !plan) return `Change ${plans.length} tables`;
  const label = plan.after.label;
  return plan.input.kind === 'import'
    ? `Import rows into ${label}`
    : plan.input.kind === 'records'
      ? `Change rows in ${label}`
      : plan.before
        ? `Change ${label} table`
        : `Create ${label} table`;
}

function planSummary(plan: ReviewedPlan) {
  const rows = `${plan.effectCount.toLocaleString()} ${plan.effectCount === 1 ? 'row' : 'rows'}`;
  if (plan.input.kind === 'import') return `Import · ${rows}`;
  if (plan.input.kind === 'records') return `Row changes · ${rows}`;
  if (!plan.before)
    return `New table · ${plan.after.fields.length} ${plan.after.fields.length === 1 ? 'field' : 'fields'}`;
  const before = new Map(plan.before.fields.map(field => [field.id, JSON.stringify(field)]));
  const added = plan.after.fields.filter(field => !before.has(field.id)).length;
  const changed = plan.after.fields.filter(
    field => before.has(field.id) && before.get(field.id) !== JSON.stringify(field),
  ).length;
  const removed = plan.before.fields.length - (plan.after.fields.length - added);
  const parts = [added && `${added} added`, changed && `${changed} changed`, removed && `${removed} removed`].filter(
    Boolean,
  );
  return `${parts.length ? `Fields ${parts.join(', ')}` : 'No field changes'}${plan.effectCount ? ` · ${rows}` : ''}`;
}

const badgeVariant = (status: ProposalView['status']) =>
  status === 'completed'
    ? 'success'
    : status === 'pending'
      ? 'info'
      : status === 'failed' || status === 'rejected'
        ? 'destructive'
        : status === 'approved'
          ? 'secondary'
          : 'warning';

function ValidTableProposalCard({ workspaceId, chatId, id, userId, membershipId, order = 0 }: ProposalCardProps) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const api = useMemo(() => proposalApi(workspaceId, chatId, id), [workspaceId, chatId, id]);
  const identity = { chatId, proposalId: id };
  const read = useTableProposal(api, identity);
  const write = useTableProposalCommand(api, identity);
  const canvas = useOptionalCanvas();
  const loaded = read.state.kind === 'ready' ? read.state.data : null;
  useResultAttention(`table-proposal:${id}`, loaded?.status === 'pending', 'Table changes need your review');
  const title = loaded?.content === 'available' ? proposalTitle(loaded.manifest.plans) : 'Table changes';
  const dock = useApprovalDockEntry({ id, title, status: loaded?.status ?? 'loading', order });
  const heading = useRef<HTMLHeadingElement>(null);
  const approvalFocus = useRef<Element | null>(null);
  useEffect(() => {
    const moved = (event: FocusEvent) => {
      if (event.target !== approvalFocus.current && event.target !== document.body) approvalFocus.current = null;
    };
    document.addEventListener('focusin', moved);
    return () => document.removeEventListener('focusin', moved);
  }, []);
  useEffect(() => {
    if (loaded?.status !== 'completed' || !approvalFocus.current) return;
    if (document.activeElement === approvalFocus.current || document.activeElement === document.body)
      heading.current?.focus();
    approvalFocus.current = null;
  }, [loaded?.status]);
  const [effectReads, setEffectReads] = useState<Record<string, boolean>>({});
  const effectsReady = useCallback(
    (tableId: string, ready: boolean) =>
      setEffectReads(previous => (previous[tableId] === ready ? previous : { ...previous, [tableId]: ready })),
    [],
  );
  const locked = write.state.kind === 'sending' || write.state.kind === 'uncertain';
  const refreshing = read.state.kind === 'ready' && read.state.refreshing;
  const feedback = (view: ProposalView) => (
    <>
      {write.state.kind !== 'sending' && (
        <WriteFeedback
          state={write.state}
          checkStatus={() => void read.refresh()}
          retry={command => void write.submit(command)}
        />
      )}
      {read.delayed && progressing(view) && (
        <p role="status" className="text-sm text-muted-foreground">
          Automatic checks stopped after a minute. Use Check proposal status to follow unfinished work.
        </p>
      )}
    </>
  );
  const expanded = (
    <section aria-label="Table change proposal" className="min-w-0">
      <TableRead state={read.state} refresh={read.refresh}>
        {view => {
          const checkStatus = (
            <Button
              variant="ghost"
              size="icon-sm"
              title="Check proposal status"
              aria-label="Check proposal status"
              aria-busy={refreshing}
              disabled={refreshing}
              onClick={() => void read.refresh()}
            >
              <Refresh size={16} aria-hidden="true" />
            </Button>
          );
          if (view.content === 'redacted')
            return (
              <div className="max-h-64 overflow-y-auto">
                <ReviewCard
                  icon={<Database size={14} />}
                  title="Table changes"
                  badge={{ label: statusLabels[view.status], variant: badgeVariant(view.status) }}
                  status={
                    <>
                      {feedback(view)}
                      <div>{checkStatus}</div>
                    </>
                  }
                >
                  <p role="status" className="text-sm">
                    History values expired. Proposal values were permanently removed on{' '}
                    {new Date(view.manifest.redactedAt).toLocaleString()}.
                  </p>
                  <p className="text-sm text-muted-foreground">
                    The original digest and execution outcomes remain available. Ask for a new proposal to make further
                    changes.
                  </p>
                  <ul className="space-y-1 text-sm">
                    {view.plans.map((plan, index) => (
                      <li key={plan.tableId}>
                        Table {index + 1}: {plan.receipt?.status ?? 'Not completed'}
                        {plan.importProgress?.applied ? `. ${importedRecords(plan.importProgress)}` : ''}
                      </li>
                    ))}
                  </ul>
                  <p className="break-all font-mono text-xs text-muted-foreground">{view.digest}</p>
                </ReviewCard>
              </div>
            );
          const requester =
            view.manifest.requester.userId === userId &&
            (membershipId === undefined || view.manifest.requester.membershipId === membershipId);
          const current =
            view.freshness === 'current' && !view.expired && Date.parse(view.manifest.expiresAt) > Date.now();
          const disabled = locked || !!(read.state.kind === 'ready' && (read.state.error || read.state.refreshing));
          const effectsLoaded = view.manifest.plans.every(
            plan => plan.effectCount === 0 || effectReads[plan.input.tableId],
          );
          const submit = (action: 'approve' | 'reject' | 'cancel' | 'resume') => {
            if (locked) return;
            dock?.activate();
            if (action === 'approve' || action === 'resume') approvalFocus.current = document.activeElement;
            const common = { commandId: crypto.randomUUID(), digest: view.digest };
            const command: ProposalCommand =
              action === 'approve' || action === 'reject'
                ? { ...common, decision: action }
                : { ...common, operation: action };
            void write.submit(command);
          };
          const label = (tableId: string) =>
            view.manifest.plans.find(item => item.input.tableId === tableId)?.after.label ?? 'another table';
          const hasSchema = view.manifest.plans.some(plan => plan.input.kind === 'schema');
          const completed = view.plans.filter(plan => plan.receipt?.status === 'completed').length;
          const done = view.status === 'completed';
          const onlyPlan = view.manifest.plans.length === 1 ? view.manifest.plans[0] : undefined;
          const createsTables = view.manifest.plans.every(plan => plan.input.kind === 'schema' && !plan.before);
          const sending =
            write.state.kind === 'sending'
              ? 'decision' in write.state.input
                ? write.state.input.decision
                : write.state.input.operation
              : null;
          const uncertain = write.state.kind === 'uncertain' && !done;
          const commandLabels = {
            approve: 'Recording your approval',
            reject: 'Rejecting proposal',
            cancel: 'Cancelling unfinished work',
            resume: 'Resuming unfinished work',
          };
          const stateTitle = sending
            ? commandLabels[sending]
            : uncertain
              ? 'Outcome not confirmed'
              : done
                ? onlyPlan?.input.kind === 'schema' && !onlyPlan.before
                  ? `${onlyPlan.after.label} table created`
                  : 'Changes applied'
                : view.status === 'pending'
                  ? 'Ready for your approval'
                  : view.status === 'approved'
                    ? 'Approval recorded'
                    : statusLabels[view.status];
          const details = (
            <>
              <ul aria-label="Tables in this proposal" className="divide-y border-y">
                {view.manifest.plans.map(plan => {
                  const outcome = view.plans.find(item => item.tableId === plan.input.tableId);
                  return (
                    <li
                      key={plan.input.tableId}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3 text-sm"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-foreground wrap-anywhere">{plan.after.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {planSummary(plan)}
                          {plan.input.dependsOn.length > 0 &&
                            ` · Runs after ${plan.input.dependsOn.map(label).join(', ')}`}
                        </p>
                      </div>
                      <Badge
                        variant={
                          outcome?.receipt?.status === 'completed'
                            ? 'success'
                            : outcome?.receipt?.status === 'failed'
                              ? 'destructive'
                              : 'secondary'
                        }
                      >
                        {outcome?.receipt?.status === 'completed'
                          ? 'Done'
                          : outcome?.receipt?.status === 'failed'
                            ? 'Failed'
                            : 'Pending'}
                      </Badge>
                      {view.status !== 'pending' && (
                        <p className="w-full text-xs text-muted-foreground">
                          {outcome ? planOutcome(outcome) : 'Not yet completed'}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
              {view.manifest.plans.map(plan => (
                <Fragment key={plan.input.tableId}>
                  {plan.input.kind === 'schema' && plan.input.transforms.outputs.length > 0 && (
                    <Disclosure title={`Transformation rules · ${plan.after.label}`}>
                      <div className="space-y-3">
                        {plan.input.transforms.outputs.map(output => (
                          <div key={output.fieldId}>
                            <p className="text-sm font-medium">
                              {plan.after.fields.find(field => field.id === output.fieldId)?.label ?? 'Field'}
                            </p>
                            <pre className="overflow-auto whitespace-pre-wrap break-all text-xs">
                              {JSON.stringify(output.expression, null, 2)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    </Disclosure>
                  )}
                  {plan.input.kind === 'import' && (
                    <Disclosure title={`Import mapping · ${plan.after.label}`}>
                      <section className="space-y-3">
                        <p className="text-sm">
                          Source {plan.input.reference.kind === 'file' ? 'attached file' : 'integration result'}
                        </p>
                        <ul className="space-y-1 text-sm">
                          {plan.input.mappings.map(mapping => (
                            <li key={mapping.fieldId}>
                              {mapping.sourceColumn} →{' '}
                              {plan.after.fields.find(field => field.id === mapping.fieldId)?.label ?? 'Field'}
                            </li>
                          ))}
                        </ul>
                        <p className="text-sm">
                          Match on{' '}
                          {plan.input.matchFieldIds
                            .map(fieldId => plan.after.fields.find(field => field.id === fieldId)?.label ?? 'Field')
                            .join(' + ')}
                          . Ambiguous matches are blocked.
                        </p>
                        {plan.audience && (
                          <div className="space-y-1 text-sm">
                            <p>
                              {plan.audience.teams.length} {plan.audience.teams.length === 1 ? 'team' : 'teams'} and{' '}
                              {plan.audience.members.length} {plan.audience.members.length === 1 ? 'person' : 'people'}{' '}
                              have access.
                            </p>
                            <p>
                              File references retain independent permissions. Source-access loss stops unfinished
                              imports, not completed copies.
                            </p>
                          </div>
                        )}
                      </section>
                    </Disclosure>
                  )}
                  <ProposalEffects
                    key={`${view.digest}/${plan.input.tableId}`}
                    api={api}
                    identity={identity}
                    plan={plan}
                    digest={view.digest}
                    onReady={effectsReady}
                  />
                </Fragment>
              ))}
            </>
          );
          return (
            <div className="overflow-hidden rounded-xl border border-input bg-card">
              <header
                className={
                  done
                    ? 'flex items-start gap-3 bg-success-subtle px-4 py-3 text-success'
                    : 'flex items-start gap-3 px-4 pt-4 pb-3'
                }
              >
                <span className="mt-0.5 shrink-0">
                  {sending || (progressing(view) && !read.delayed) ? (
                    <Spinner aria-hidden="true" />
                  ) : done ? (
                    <Check size={20} aria-hidden="true" />
                  ) : (
                    <Database size={20} aria-hidden="true" />
                  )}
                </span>
                <div className="min-w-0 flex-1" role="status">
                  <h2 ref={heading} tabIndex={-1} className="text-base font-medium wrap-anywhere">
                    {stateTitle}
                  </h2>
                  <p className={done ? 'mt-0.5 text-sm' : 'mt-0.5 text-sm text-muted-foreground'}>
                    {sending
                      ? 'Sending your decision. Please wait.'
                      : uncertain
                        ? 'Check the current status before retrying this operation.'
                        : view.status === 'pending'
                          ? `${view.plans.length} ${view.plans.length === 1 ? 'change' : 'changes'} to review. Nothing has been applied yet.`
                          : `${completed} of ${view.plans.length} table changes completed${view.status === 'approved' ? ' · Waiting for execution.' : '.'}`}
                  </p>
                </div>
                {checkStatus}
              </header>
              <div className="max-h-48 space-y-3 overflow-y-auto px-4 py-2">
                {!requester && (
                  <Alert>
                    <AlertDescription>
                      Only the person who requested these changes can approve, reject, cancel, or resume them.
                    </AlertDescription>
                  </Alert>
                )}
                {view.freshness === 'stale' && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      Affected data or permissions changed. Ask the assistant in this chat for a new proposal. This
                      review cannot authorize changed effects.
                    </AlertDescription>
                  </Alert>
                )}
                {(view.expired || (!current && view.freshness === 'current')) && view.status !== 'completed' && (
                  <Alert>
                    <AlertDescription>
                      This review expired. Ask the assistant for a new proposal and review its effects before approving.
                    </AlertDescription>
                  </Alert>
                )}
                {view.manifest.plans.some(plan => plan.input.kind === 'import' && plan.audience) && (
                  <p className="text-xs text-muted-foreground">
                    Imported rows follow destination table permissions. Administrators can access the copy.
                  </p>
                )}
                {feedback(view)}
                <Disclosure title="Completed changes" hidden={!done}>
                  {done && details}
                </Disclosure>
                {!done && details}
                <Disclosure title="Approval details">
                  <p className="text-sm text-muted-foreground">
                    Review expires {new Date(view.manifest.expiresAt).toLocaleString()}.{' '}
                    {applicationNote(view.manifest.plans)}
                  </p>
                </Disclosure>
              </div>
              {requester && !effectsLoaded && ['pending', 'cancelled', 'failed', 'partial'].includes(view.status) && (
                <p role="status" className="px-4 text-sm text-muted-foreground">
                  Row effects are not ready. Open Row effects to check or retry before approving or resuming.
                </p>
              )}
              {progressing(view) && (
                <p className="px-4 text-xs text-muted-foreground">
                  Work continues if you leave this chat. Cancellation stops unfinished work at a safe checkpoint.
                </p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                {hasSchema && canvas && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => canvas.show(schemaCanvasItem(workspaceId, chatId, id, title))}
                  >
                    <SidebarRight size={14} aria-hidden="true" />
                    Open schema
                  </Button>
                )}
                <div className="ml-auto flex flex-wrap gap-2">
                  {requester && view.status === 'pending' && (
                    <>
                      <Button
                        variant="ghost"
                        disabled={disabled || view.expired}
                        aria-busy={sending === 'reject'}
                        onClick={() => submit('reject')}
                      >
                        {sending === 'reject' ? 'Rejecting...' : 'Reject proposal'}
                      </Button>
                      <Button
                        size="lg"
                        disabled={disabled || !current || !effectsLoaded}
                        aria-busy={sending === 'approve'}
                        onClick={() => submit('approve')}
                      >
                        {sending === 'approve'
                          ? 'Approving...'
                          : createsTables
                            ? 'Approve & create'
                            : 'Approve exact changes'}
                      </Button>
                    </>
                  )}
                  {requester &&
                    view.decision === 'approve' &&
                    !['completed', 'rejected', 'cancelled', 'expired'].includes(view.status) && (
                      <Button variant="outline" disabled={disabled} onClick={() => submit('cancel')}>
                        {sending === 'cancel' ? 'Cancelling…' : 'Cancel unfinished work'}
                      </Button>
                    )}
                  {requester &&
                    view.decision === 'approve' &&
                    ['cancelled', 'failed', 'partial'].includes(view.status) && (
                      <Button
                        disabled={disabled || !current || !effectsLoaded}
                        aria-busy={sending === 'resume'}
                        onClick={() => submit('resume')}
                      >
                        {sending === 'resume' ? 'Resuming…' : 'Resume unfinished work'}
                      </Button>
                    )}
                  {done && onlyPlan && (
                    <Button
                      nativeButton={false}
                      render={
                        <Link
                          to="/$workspaceSlug/tables/$tableId"
                          params={{ workspaceSlug, tableId: onlyPlan.input.tableId }}
                        />
                      }
                    >
                      View table
                    </Button>
                  )}
                  {done && !onlyPlan && (
                    <Button
                      nativeButton={false}
                      render={<Link to="/$workspaceSlug/tables" params={{ workspaceSlug }} />}
                    >
                      View tables
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        }}
      </TableRead>
    </section>
  );
  if (!dock) return expanded;
  const review = () => {
    dock.activate();
    if (loaded?.content === 'available' && loaded.manifest.plans.some(plan => plan.input.kind === 'schema'))
      canvas?.show(schemaCanvasItem(workspaceId, chatId, id, title));
  };
  return (
    <>
      <div className="my-3 flex items-center gap-3 py-2">
        <span className="shrink-0 text-muted-foreground">
          <Database size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium wrap-anywhere">{title}</p>
          <p className="text-xs text-muted-foreground">
            {loaded ? statusLabels[loaded.status] : 'Loading table changes…'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={review}>
          Review changes
        </Button>
      </div>
      {dock.active && dock.target && createPortal(expanded, dock.target)}
    </>
  );
}

function ProposalEffects({
  api,
  identity,
  plan,
  digest,
  onReady,
}: {
  api: ProposalApi;
  identity: ProposalIdentity;
  plan: ReviewedPlan;
  digest: string;
  onReady: (tableId: string, ready: boolean) => void;
}) {
  const [cursors, setCursors] = useState<number[]>([-1]);
  const after = cursors.at(-1) ?? -1;
  const read = useTableProposalEffects(api, identity, plan.input.tableId, digest, plan.effectCount, after);
  const ready = read.state.kind === 'ready' && !read.state.error && !read.state.refreshing;
  useEffect(() => {
    onReady(plan.input.tableId, ready);
    return () => onReady(plan.input.tableId, false);
  }, [onReady, plan.input.tableId, ready]);
  if (plan.effectCount === 0) return null;
  return (
    <Disclosure title={`Row effects · ${plan.after.label} (${plan.effectCount.toLocaleString()})`}>
      <p className="mb-3 text-sm text-muted-foreground">
        The first page is a sample of the exact effects. Use the page controls to inspect every affected row.
      </p>
      <TableRead state={read.state} refresh={read.refresh}>
        {page => (
          <div className="space-y-3">
            {page.items.map(({ ordinal, effect }) => (
              <section key={ordinal} className="space-y-2 border-t border-border pt-3">
                <h4 className="break-words text-sm font-medium">
                  {effect.kind === 'create' ? 'Create' : effect.kind === 'delete' ? 'Delete' : 'Update'}{' '}
                  {rowLabel(
                    effect.after ? plan.after : (plan.before ?? plan.after),
                    effect.after ?? effect.before ?? {},
                  )}
                </h4>
                <Table
                  aria-label={`Field changes for row ${ordinal}`}
                  getRowId={row => row.id}
                  data={[...new Set([...Object.keys(effect.before ?? {}), ...Object.keys(effect.after ?? {})])].map(
                    id => ({
                      id,
                      label:
                        plan.after.fields.find(field => field.id === id)?.label ??
                        plan.before?.fields.find(field => field.id === id)?.label ??
                        id,
                      before:
                        effect.before === null
                          ? 'No row'
                          : formatTableValue(effect.before[id], plan.before ?? plan.after, id),
                      after: effect.after === null ? 'Row deleted' : formatTableValue(effect.after[id], plan.after, id),
                    }),
                  )}
                  columns={[
                    { key: 'label', header: 'Field' },
                    {
                      key: 'before',
                      header: 'Before',
                      cell: row => <span className="whitespace-pre-wrap break-all">{row.before}</span>,
                    },
                    {
                      key: 'after',
                      header: 'After',
                      cell: row => <span className="whitespace-pre-wrap break-all">{row.after}</span>,
                    },
                  ]}
                />
              </section>
            ))}
            <nav aria-label={`Effects for ${plan.after.label}`} className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                disabled={cursors.length === 1 || read.state.kind !== 'ready' || read.state.refreshing}
                onClick={() => setCursors(items => items.slice(0, -1))}
              >
                Previous effects
              </Button>
              <span className="text-sm">
                Page {cursors.length} · {page.total.toLocaleString()} effects
              </span>
              <Button
                variant="outline"
                disabled={page.nextCursor === null || read.state.kind !== 'ready' || read.state.refreshing}
                onClick={() => {
                  const cursor = page.nextCursor;
                  if (cursor !== null) setCursors(items => [...items, cursor]);
                }}
              >
                Next effects
              </Button>
            </nav>
          </div>
        )}
      </TableRead>
    </Disclosure>
  );
}
