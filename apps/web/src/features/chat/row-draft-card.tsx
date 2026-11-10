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
const reasons = {
  'too-many-rows': 'Chat changes up to 5 rows on its own. Larger changes wait for your approval.',
  'table-not-named': 'You didn’t name this table in the chat, so the change waits for your approval.',
  'table-change-pending': 'Chat prepared a table change in the same reply, so this row change waits for your approval.',
} as const;
/** The element a reply that was held behind this card scrolls to. */
export const rowDraftElementId = (id: string) => `row-draft-${id}`;
const operation = ({ input }: RowProposal) =>
  input.tool === 'rows.create' || input.tool === 'rows.create.batch'
    ? ('create' as const)
    : input.tool === 'rows.update' || input.tool === 'rows.update.batch'
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
  const { input, written } = proposal;
  const updates = input.tool === 'rows.update.batch' ? input.rows : null;
  const batch =
    input.tool === 'rows.create.batch' ? input.rows.map(row => row.values) : updates?.map(row => row.values);
  const count = batch?.length ?? 1;
  const proposed: Values =
    input.tool === 'rows.delete' || input.tool === 'rows.create.batch' || input.tool === 'rows.update.batch'
      ? {}
      : input.values;
  const fields = (values: Values) =>
    Object.keys(values).map(fieldId => ({
      fieldId,
      label: table?.fields.find(field => field.id === fieldId)?.label ?? fieldId,
    }));
  const format = (values: Values, fieldId: string) =>
    formatTableValue(values[fieldId] ?? null, table ?? { fields: [] }, fieldId);
  const rowLabel = (index: number) => {
    const before = updates && draft.rowCurrents?.[updates[index]!.recordId];
    const ids = table?.labelFieldIds?.length
      ? table.labelFieldIds
      : [(table?.fields.find(field => field.kind === 'text') ?? table?.fields[0])?.id].filter(
          (id): id is string => id !== undefined,
        );
    return before && ids.some(id => before[id] != null)
      ? ids.map(id => format(before, id)).join(' · ')
      : `Row ${index + 1}`;
  };
  const shown = kind === 'delete' ? fields(draft.rowCurrent ?? {}) : fields(proposed);
  return (
    <ReviewCard
      id={rowDraftElementId(id)}
      tabIndex={-1}
      label="Review row change"
      icon={<Database size={16} />}
      title={`${verbs[kind]} ${count === 1 ? 'a row' : `${count} rows`} in ${tableName}`}
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
              {kind === 'delete' ? 'Approve deletion' : count === 1 ? 'Approve change' : `Approve ${count} rows`}
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
              <p role="status">
                {count === 1
                  ? 'The row could not be changed.'
                  : kind === 'update'
                    ? 'No rows changed.'
                    : 'The rows could not be added.'}{' '}
                Ask chat for a fresh draft.
              </p>
            )}
            {draft.status === 'preparing' && (
              <p role="status">
                Your approval is recorded.{' '}
                {count === 1
                  ? 'The row is being changed.'
                  : kind === 'update'
                    ? 'The rows are being updated.'
                    : 'The rows are being added.'}
              </p>
            )}
            {draft.status === 'saved' && (
              <p role="status">
                {count > 1
                  ? `${count} rows ${kind === 'update' ? 'updated' : 'added'}.`
                  : kind === 'create'
                    ? 'Row added.'
                    : kind === 'update'
                      ? 'Row updated.'
                      : 'Row deleted.'}
              </p>
            )}
            {draft.status === 'dismissed' && (
              <p role="status">
                Draft dismissed.{' '}
                {count === 1 ? 'No row was changed.' : kind === 'update' ? 'No rows changed.' : 'No rows were added.'}
              </p>
            )}
          </div>
          {feedback}
        </>
      }
    >
      <ReviewRows>
        <ReviewRow label="Change">
          {count > 1
            ? kind === 'update'
              ? `Updates ${count} existing rows together`
              : `Adds ${count} new rows together`
            : kind === 'create'
              ? 'Adds a new row'
              : kind === 'update'
                ? 'Updates an existing row'
                : 'Deletes an existing row'}
        </ReviewRow>
        <ReviewRow label="Table">{tableName}</ReviewRow>
      </ReviewRows>
      {written && (
        <section aria-label="Rows already changed" className="grid gap-2 text-sm">
          <p role="note">
            {written.count === 1 ? '1 row was' : `${written.count} rows were`} already changed in this reply. Those
            changes stay. This card holds only the other {count === 1 ? 'row' : `${count} rows`}, which need your
            approval.
          </p>
          {written.rows.length > 0 && (
            <ol aria-label="Already added" className="grid gap-2">
              {written.rows.map((row, index) => (
                <li key={row.recordId}>
                  <ReviewRows>
                    <ReviewRow label={`Already added ${index + 1}`}>
                      <span className="break-words">
                        {fields(row.values)
                          .map(({ fieldId, label }) => `${label}: ${format(row.values, fieldId)}`)
                          .join(' · ') || 'No field values set.'}
                      </span>
                    </ReviewRow>
                  </ReviewRows>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      {batch ? (
        <ol aria-label={kind === 'update' ? 'Rows to update' : 'Rows to add'} className="grid gap-2">
          {batch.map((values, index) => (
            <li key={index}>
              <ReviewRows>
                <ReviewRow label={updates ? rowLabel(index) : `Row ${index + 1}`}>
                  {updates ? (
                    <div className="grid gap-1">
                      {fields(values).map(({ fieldId, label }) => {
                        const before = draft.rowCurrents?.[updates[index]!.recordId];
                        return (
                          <div key={fieldId} className="grid gap-0.5">
                            <span className="break-words">
                              {label}: {format(values, fieldId)}
                            </span>
                            <span className="break-words text-xs text-muted-foreground">
                              {before ? `Before ${format(before, fieldId)}` : 'Previous value unavailable.'}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="break-words">
                      {fields(values)
                        .map(({ fieldId, label }) => `${label}: ${format(values, fieldId)}`)
                        .join(' · ') || 'No field values set.'}
                    </span>
                  )}
                </ReviewRow>
              </ReviewRows>
            </li>
          ))}
        </ol>
      ) : shown.length > 0 ? (
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
        {proposal.reason
          ? reasons[proposal.reason]
          : 'This chat used content from outside your tables, such as web pages, knowledge, files or connected apps, so the change waits for your approval.'}{' '}
        Approving makes this exact change with your table access.
      </p>
      <Disclosure title="Technical details">
        <dl aria-label="Technical details" className="grid gap-2 text-xs text-muted-foreground">
          <TechnicalDetail term="Table ID">{input.tableId}</TechnicalDetail>
          {(input.tool === 'rows.update' || input.tool === 'rows.delete') && (
            <TechnicalDetail term="Row ID">{input.recordId}</TechnicalDetail>
          )}
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
  continued: { label: 'Continued in builder', variant: 'secondary' },
} as const;
