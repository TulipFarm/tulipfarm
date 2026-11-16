import type { BadgeVariant } from '@tulipfarm/sprout/badge';
import type { TableDefinition } from '@/features/tables/api';
import type { AppSummary, DataView, DataViewAction, DataViewComparison, RuleOp } from './api';
import { servingStatus } from './labels';

export type TableField = TableDefinition['definition']['fields'][number];
/** The view's table title and the fields it uses, or null when the table is gone. */
export type ViewTable = { label: string; fields: TableField[] } | null;

/** Kinds a view may list. Files and linked rows reach other assets, which a view does not grant. */
export const listableKinds: readonly TableField['kind'][] = [
  'text',
  'numeric',
  'boolean',
  'date',
  'timestamp',
  'single-select',
  'multi-select',
];
/** Kinds a rule may compare. */
export const comparableKinds: readonly TableField['kind'][] = listableKinds.filter(kind => kind !== 'multi-select');

export const opLabels: Record<RuleOp, string> = {
  eq: 'is',
  ne: 'is not',
  lt: 'is less than',
  lte: 'is at most',
  gt: 'is greater than',
  gte: 'is at least',
  'is-null': 'is empty',
  'not-null': 'is not empty',
};

export const actionLabels: Record<DataViewAction, string> = {
  read: 'Read rows',
  create: 'Create rows',
  update: 'Update rows',
  delete: 'Delete rows',
};

const actionOrder: readonly DataViewAction[] = ['read', 'create', 'update', 'delete'];

/** The actions as a phrase that fits "this app can … rows", such as "read and update". */
export function actionPhrase(actions: readonly DataViewAction[]) {
  const words = actionOrder.filter(action => actions.includes(action));
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export const tableName = (table: ViewTable) => table?.label ?? 'Unavailable table';

export function viewSummary(view: DataView, table: ViewTable) {
  const actions = actionPhrase(view.actions);
  return [
    tableName(table),
    plural(view.fieldIds.length, 'field', 'fields'),
    view.predicate.all.length ? plural(view.predicate.all.length, 'rule', 'rules') : 'All rows',
    `${actions.charAt(0).toUpperCase()}${actions.slice(1)}`,
  ].join(' · ');
}

export const fieldLabel = (table: ViewTable, fieldId: string) =>
  table?.fields.find(field => field.id === fieldId)?.label ?? 'A removed field';

/** A fixed value as people read it: an option's label, Yes or No, or the text itself. */
export function valueText(table: ViewTable, comparison: Extract<DataViewComparison, { operand: unknown }>) {
  if (comparison.operand.kind !== 'value') return '';
  const value = comparison.operand.value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const field = table?.fields.find(entry => entry.id === comparison.fieldId);
  if (field?.kind === 'single-select') return field.options.find(option => option.id === value)?.label ?? value;
  return value;
}

type ViewStatus = { badge: string; tone: BadgeVariant; sentence: string };

/** What the first blocker means for this view, or that the app can use it now. */
export function viewStatus(view: DataView, app: AppSummary, table: ViewTable): ViewStatus {
  const notInUse = (sentence: string): ViewStatus => ({ badge: 'Not in use', tone: 'secondary', sentence });
  switch (view.blockers[0]) {
    case undefined:
      return { badge: 'In use', tone: 'success', sentence: 'The app can use this data view now.' };
    case 'app-not-serving': {
      if (app.approval.state !== 'approved') return notInUse('The app isn’t approved as a public app yet.');
      const serving = servingStatus(app);
      return notInUse(
        serving && serving.tone !== 'success' ? `${serving.label}.` : 'The app isn’t open to visitors right now.',
      );
    }
    case 'not-approved':
      return view.sharedBy === null
        ? notInUse('This view isn’t shared with the app.')
        : { badge: 'Not in use yet', tone: 'info', sentence: 'Waiting for a workspace admin to approve.' };
    default:
      return {
        badge: 'Not in use',
        tone: 'warning',
        sentence: table
          ? `${table.label} changed, and this view no longer matches it. Create a new data view, then stop sharing this one.`
          : 'The table was deleted. Stop sharing it, then create a new data view from another table.',
      };
  }
}
