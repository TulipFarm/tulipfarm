import { z } from 'zod';
import {
  conditionOutputSchema,
  foundRowsSchema,
  rowChangeSchema,
  withheldOutputSchema,
  type runSchema,
} from '@tulipfarm/workflows/contracts';

const scheduledInput = z.object({
  scheduledFor: z.iso.datetime(),
  missedThrough: z.iso.datetime().optional(),
  missedCount: z.number().int().positive().optional(),
  missedCountCapped: z.literal(true).optional(),
});
const rowSkipInput = z.union([
  z.object({
    firstChangedAt: z.iso.datetime(),
    lastChangedAt: z.iso.datetime(),
    coalescedCount: z.number().int().positive(),
  }),
  z.object({ event: z.enum(['created', 'updated', 'deleted']), recordId: z.string(), changedAt: z.iso.datetime() }),
]);
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

export function runNote(run: Pick<z.infer<typeof runSchema>, 'source' | 'status' | 'input' | 'error'>) {
  if (run.source === 'row') return rowNote(run);
  if (run.source === 'github')
    return run.status === 'skipped' && run.error === 'github-repository-not-connected'
      ? 'Skipped because the sponsor no longer has this GitHub repository in their GitHub Knowledge.'
      : null;
  const input = run.source === 'schedule' || run.source === 'record' ? scheduledInput.safeParse(run.input) : null;
  if (!input?.success) return null;
  const { scheduledFor, missedThrough, missedCount = 1, missedCountCapped } = input.data;
  if (run.source === 'record') {
    if (run.status !== 'skipped') return null;
    if (run.error === 'record-values-too-large')
      return `Skipped the run scheduled for ${when(scheduledFor)} because the record's values are larger than a workflow run can receive.`;
    if (run.error !== 'missed-occurrences-coalesced') return null;
    if (missedCount === 1)
      return `Missed the record run scheduled for ${when(scheduledFor)}. It was more than a day late, so it did not run.`;
    const span =
      missedThrough && missedThrough !== scheduledFor
        ? `from ${when(scheduledFor)} through ${when(missedThrough)}`
        : `for ${when(scheduledFor)}`;
    return `Missed ${missedCount.toLocaleString()} record runs scheduled ${span}. They were more than a day late, so they did not run.`;
  }
  const times =
    missedCount > 1 && missedThrough
      ? `${missedCountCapped ? 'more than ' : ''}${missedCount.toLocaleString()} scheduled runs from ${when(scheduledFor)} through ${when(missedThrough)}`
      : `the run scheduled for ${when(scheduledFor)}`;
  if (run.status === 'skipped' && run.error === 'previous-run-unfinished')
    return `Skipped ${times} because the previous scheduled run had not finished.`;
  if (run.status === 'skipped' && run.error === 'missed-occurrences-coalesced')
    return `Missed ${times}. One late run started instead of catching up.`;
  return `Scheduled for ${when(scheduledFor)}.`;
}

const shortId = (id: string) => id.slice(0, 8);
const count = (amount: number, noun: string) => `${amount.toLocaleString()} ${amount === 1 ? noun : `${noun}s`}`;

function rowNote(run: Pick<z.infer<typeof runSchema>, 'status' | 'input' | 'error'>) {
  const input = run.status === 'skipped' ? rowSkipInput.safeParse(run.input) : null;
  if (!input?.success) return null;
  const skip = input.data;
  if (run.error === 'row-changes-coalesced' && 'coalescedCount' in skip) {
    const span =
      skip.firstChangedAt === skip.lastChangedAt
        ? `at ${when(skip.firstChangedAt)}`
        : `from ${when(skip.firstChangedAt)} through ${when(skip.lastChangedAt)}`;
    return `Skipped ${count(skip.coalescedCount, 'row change')} ${span} because more changes arrived than the workflow can queue.`;
  }
  if (run.error === 'record-values-too-large' && 'recordId' in skip)
    return `Skipped the run for row ${shortId(skip.recordId)}, ${skip.event} at ${when(skip.changedAt)}, because the row's values are larger than a workflow run can receive.`;
  return null;
}

const stepNames = (ids: string[]) => {
  const names = ids.map(id => id.replaceAll('_', ' '));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');
};

function conditionNote({ matched, ran, skipped }: z.infer<typeof conditionOutputSchema>) {
  const actions = [
    ran.length ? `ran ${stepNames(ran)}` : '',
    skipped.length ? `skipped ${stepNames(skipped)}` : '',
  ].filter(Boolean);
  // A comma keeps "ran a and b and skipped c" from reading as one list.
  const joined = actions.join(ran.length > 1 || skipped.length > 1 ? ', and ' : ' and ');
  return `Condition ${matched ? 'met' : 'not met'}${joined ? `, so it ${joined}` : ''}.`;
}

/** Explains a completed step: the branch a condition chose, the rows a table step found or changed, or why its output is withheld. */
export function stepNote(output: unknown) {
  if (withheldOutputSchema.safeParse(output).success)
    return 'This step’s output is hidden because it uses information you cannot access.';
  const condition = conditionOutputSchema.safeParse(output);
  if (condition.success) return conditionNote(condition.data);
  const change = rowChangeSchema.safeParse(output);
  if (change.success)
    return `${change.data.operation === 'created' ? 'Created' : 'Updated'} row ${shortId(change.data.recordId)}, writing ${count(change.data.fieldIds.length, 'field')}.`;
  const found = foundRowsSchema.safeParse(output);
  if (!found.success) return null;
  const { rows, more } = found.data;
  if (!rows.length) return 'Found no matching rows.';
  return `Found ${count(rows.length, 'row')}${more ? ' and left out further matches' : ''}: ${rows.map(row => shortId(row.recordId)).join(', ')}.`;
}
