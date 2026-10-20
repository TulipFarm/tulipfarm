import type { ReactNode, RefObject } from 'react';
import { Database } from 'reicon-react/icons/Database';
import { ReviewCard, ReviewRow, ReviewRows } from '@tulipfarm/sprout/review-card';
import { Button } from '@tulipfarm/sprout/button';
import { Disclosure } from '@/components/disclosure';
import { UnsavedChanges } from '@/features/tables/feedback';
import { formatTableValue } from '@/features/tables/definition-view';
import type { DraftView, RowProposal } from '@tulipfarm/agents/draft-contracts';

type Values = NonNullable<DraftView['rowCurrent']>;
const verbs = { create: 'Add', update: 'Update', delete: 'Delete' } as const;
const operation = ({ input }: RowProposal) =>
  input.tool === 'rows.create'
    ? ('create' as const)
    : input.tool === 'rows.update'
      ? ('update' as const)
      : ('delete' as const);

export function RowDraftCard({
  id,
  draft,
  proposal,
  locked,
  sending,
  dirty,
  decide,
  result,
  feedback,
  checkStatus,
}: {
  id: string;
  draft: DraftView;
  proposal: RowProposal;
  locked: boolean;
  sending: boolean;
  dirty: boolean;
  decide: (decision: 'save' | 'dismiss') => void;
  result: RefObject<HTMLDivElement | null>;
  feedback: ReactNode;
  checkStatus: ReactNode;
}) {
  const kind = operation(proposal);
  const table = draft.rowTable;
  const tableName = table?.name ?? 'a table you cannot see';
  const { input } = proposal;
  const proposed: Values = input.tool === 'rows.delete' ? {} : input.values;
  const fields = (values: Values) =>
    Object.keys(values).map(fieldId => ({
      fieldId,
      label: table?.fields.find(field => field.id === fieldId)?.label ?? fieldId,
    }));
  const format = (values: Values, fieldId: string) =>
    formatTableValue(values[fieldId] ?? null, table ?? { fields: [] }, fieldId);
  const shown = kind === 'delete' ? fields(draft.rowCurrent ?? {}) : fields(proposed);
  return (
    <ReviewCard
      label="Review row change"
      icon={<Database size={16} />}
      title={`${verbs[kind]} a row in ${tableName}`}
      badge={badges[draft.status]}
      settled={draft.status === 'saved' || draft.status === 'dismissed' || draft.status === 'failed'}
      actions={
        draft.status === 'pending' ? (
          <>
            <Button
              variant={kind === 'delete' ? 'destructive' : 'default'}
              disabled={locked}
              aria-busy={sending}
              onClick={() => decide('save')}
            >
              {kind === 'delete' ? 'Approve deletion' : 'Approve change'}
            </Button>
            <Button variant="ghost" disabled={locked} onClick={() => decide('dismiss')}>
              Dismiss
            </Button>
          </>
        ) : undefined
      }
      status={
        <>
          <UnsavedChanges dirty={dirty} />
          <div ref={result} tabIndex={-1} className="text-sm">
            {draft.status === 'stale' && (
              <div className="space-y-2">
                <p role="status">
                  The table or row changed after this draft. Nothing was changed. Ask chat for a fresh draft and review
                  it again.
                </p>
                {!draft.outcome && (
                  <Button variant="ghost" disabled={locked} onClick={() => decide('dismiss')}>
                    Dismiss draft
                  </Button>
                )}
              </div>
            )}
            {draft.status === 'failed' && (
              <p role="status">The row could not be changed. Ask chat for a fresh draft.</p>
            )}
            {draft.status === 'preparing' && <p role="status">Your approval is recorded. The row is being changed.</p>}
            {draft.status === 'saved' && (
              <p role="status">
                {kind === 'create' ? 'Row added.' : kind === 'update' ? 'Row updated.' : 'Row deleted.'}
              </p>
            )}
            {draft.status === 'dismissed' && <p role="status">Draft dismissed. No row was changed.</p>}
          </div>
          {feedback}
        </>
      }
    >
      <ReviewRows>
        <ReviewRow label="Change">
          {kind === 'create'
            ? 'Adds a new row'
            : kind === 'update'
              ? 'Updates an existing row'
              : 'Deletes an existing row'}
        </ReviewRow>
        <ReviewRow label="Table">{tableName}</ReviewRow>
      </ReviewRows>
      {shown.length > 0 ? (
        <ReviewRows>
          {shown.map(({ fieldId, label }) => (
            <ReviewRow key={fieldId} label={label}>
              <div className="grid justify-items-end gap-0.5">
                <span className="break-words">
                  {kind === 'delete' ? format(draft.rowCurrent ?? {}, fieldId) : format(proposed, fieldId)}
                </span>
                {kind === 'update' && draft.rowCurrent && (
                  <span className="text-xs text-muted-foreground">Currently {format(draft.rowCurrent, fieldId)}</span>
                )}
              </div>
            </ReviewRow>
          ))}
        </ReviewRows>
      ) : (
        <p className="text-sm text-muted-foreground">
          {kind === 'delete' ? 'Current row values are unavailable. See technical details.' : 'No field values set.'}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        This chat used content from outside your tables, such as web pages, knowledge, files or connected apps, so the
        change waits for your approval. Approving makes this exact change with your table access.
      </p>
      <Disclosure title="Technical details">
        <dl aria-label="Technical details" className="grid gap-2 text-xs text-muted-foreground">
          <TechnicalDetail term="Table ID">{input.tableId}</TechnicalDetail>
          {input.tool !== 'rows.create' && <TechnicalDetail term="Row ID">{input.recordId}</TechnicalDetail>}
          <TechnicalDetail term="Applied revision">{input.expectedAppliedRevision}</TechnicalDetail>
          <TechnicalDetail term="Draft ID">{id}</TechnicalDetail>
          <TechnicalDetail term="SHA-256">{draft.digest}</TechnicalDetail>
        </dl>
      </Disclosure>
      {checkStatus}
    </ReviewCard>
  );
}

export function TechnicalDetail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="font-medium text-foreground">{term}</dt>
      <dd className="break-all font-mono">{children}</dd>
    </div>
  );
}

const badges = {
  pending: { label: 'Needs approval', variant: 'warning' },
  preparing: { label: 'Applying', variant: 'secondary' },
  saved: { label: 'Applied', variant: 'info' },
  dismissed: { label: 'Dismissed', variant: 'secondary' },
  stale: { label: 'Out of date', variant: 'warning' },
  failed: { label: 'Not applied', variant: 'destructive' },
} as const;
