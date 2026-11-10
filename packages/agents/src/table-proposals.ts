import { createTableProposals, type TableProposalOptions } from '@tulipfarm/tables/proposals';
import { generationProposalData } from '@tulipfarm/tables/store';
import { readableTableFiles, requireTableSources } from './table-sources.ts';
import {
  createTableImports,
  TableImportError,
  tableImportFailure,
  type TableImportOptions,
} from '@tulipfarm/tables/imports';
import { TableValidationError } from '@tulipfarm/tables/definition';
import {
  proposeTableSchema,
  TableImportPlanError,
  TableProposalError,
  TableProposalValidationError,
  type ImportProblem,
  type ProposalManifest,
} from '@tulipfarm/tables/proposal-contracts';
import { z } from 'zod';

const archiveBlocked = {
  'table-linked':
    'No proposal was created: another active table links to this table, so it cannot be archived. Tell the person which table must stop linking to it first; this is not a permission denial.',
  'workflow-active':
    'No proposal was created: an enabled workflow uses this table, so it cannot be archived. Tell the person to archive or turn off the workflows that use it first; this is not a permission denial.',
} as const;
/** Proposal failures the model can correct or retry, returned with the next step instead of thrown. */
const proposalFailures = {
  'invalid-values':
    'A row value does not fit its field: a link or file field that holds one item needs exactly one ID or null, and a required field needs a value. Fix the value using the schema from schema.inspect and propose again.',
  'invalid-import':
    'The prepared file no longer matches the import reference. Call tables.import.file again in this reply and copy the reference it returns into the plan unchanged.',
  'proposal-too-large': 'The proposal has more than 100,000 rows. Split it into smaller proposals.',
  'table-title-immutable':
    'A table title cannot change after it is created. Keep the title from tables.definitions and propose the other changes.',
  'table-name-unavailable':
    'A table this proposal links to has no permanent name yet. Tell the person, and do not retry in this reply.',
  'proposal-stale':
    'The table, or a row it links to, changed since it was read. Call schema.inspect again, then propose against its current revision and rows.',
  'proposal-conflict':
    'The table changed while the proposal was prepared. Call schema.inspect again and propose against its current revision.',
  'proposal-storage-unavailable':
    'The proposal could not be saved. Call tables.propose once more in this reply; if it fails again, tell the person to try later.',
} as const;
const importNotPrepared =
  'No proposal was created. This is not a permission denial: the import plan does not name a source prepared in this reply. Call tables.import.attachments, then tables.import.file for the chosen attachment in this same reply, and copy the attachmentId and contentDigest it returns into the plan unchanged. For an integration import, use the resultId of a completed read in this chat. Never invent or reuse references from earlier replies.';

const quoted = (value: string | null) => (value === null ? 'an empty value' : `"${value}"`);
const choices = (expected: string[] | undefined) => (expected?.length ? ` (${expected.join(', ')})` : '');
const list = (expected: string[] | undefined) => (expected?.length ? `: ${expected.join(', ')}` : ' unknown');
const fieldName = (problem: ImportProblem) => problem.field ?? problem.fieldId ?? 'a field';
const problemText: Record<ImportProblem['code'], (problem: ImportProblem) => string> = {
  'unknown-column': p => `The file has no column "${p.column}". Its columns are${list(p.expected)}.`,
  'unknown-field': p => `The table has no field ${p.fieldId}. Its fields are${list(p.expected)}.`,
  'key-not-unique': p =>
    `${fieldName(p)} isn’t a unique key of the table, so rows can’t be matched by it. Match by one of its unique keys${list(p.expected)}.`,
  'key-unmapped': p => `No file column is mapped to the match field ${fieldName(p)}.`,
  'missing-key': p => `Data row ${p.row}: ${fieldName(p)} is empty, so the row can’t be matched.`,
  'duplicate-key': p =>
    `Data row ${p.row}: ${fieldName(p)} ${quoted(p.value)} repeats a match value already used in ${p.expected?.[0] ?? 'an earlier data row'}.`,
  'existing-duplicate-key': p => `Several existing rows share the same ${fieldName(p)}, so the file can’t be matched.`,
  'unmapped-value': p =>
    `Data row ${p.row}, column "${p.column}": ${quoted(p.value)} isn’t an option of ${fieldName(p)}${choices(p.expected)}.`,
  'conversion-failed': p =>
    `Data row ${p.row}, column "${p.column}": ${quoted(p.value)} isn’t a valid ${fieldName(p)} value.`,
  'type-mismatch': p =>
    `column "${p.column}" can’t fill ${fieldName(p)}: file values can’t be imported into a link or file field.`,
  'missing-field': p => `Data row ${p.row}: ${fieldName(p)} is required but empty.`,
  'invalid-output': p =>
    `Data row ${p.row}, column "${p.column}": ${quoted(p.value)} doesn’t fit ${fieldName(p)}, for example it is too long or has too many digits.`,
};
const rowConvention = 'Data rows count from the first row after the header.';
const mappingCodes = new Set<ImportProblem['code']>([
  'unknown-column',
  'unknown-field',
  'key-not-unique',
  'key-unmapped',
]);
const importValuesInstruction =
  'No proposal was created and nothing changed. This is not a permission denial, and the file was read. Tell the person, in your own words, every row, column, value and field listed in "problems", numbering rows as data rows the way "reason" does, and the next step: correct those values in the file and attach it again, or ask you to add the missing options to the field first. When a value is an option label written differently, a mapping to another column may be the fix; otherwise never drop, change or guess values to make the import pass.';
const importMappingInstruction =
  'No proposal was created and nothing changed. This is not a permission denial: the import plan does not fit the file or the table. Fix the plan using "problems" (use only the listed file columns, field IDs from the table schema, and matchFieldIds equal to one unique key), then propose again in this reply. If the table has no unique key that the file can fill, tell the person.';

/** What chat is told when an import plan's file values or mappings cannot become rows; names each problem. */
export function importPlanResult(error: TableImportPlanError) {
  const mapping = error.problems.some(problem => mappingCodes.has(problem.code));
  const listed = error.problems.slice(0, 5).map(problem => problemText[problem.code](problem));
  const more = error.total - listed.length;
  const reason = `No review prepared: ${
    mapping
      ? 'the import plan doesn’t fit the file or table.'
      : error.total === 1
        ? '1 value in the file doesn’t fit the table.'
        : `${error.total} values in the file don’t fit the table.`
  } ${listed.join(' ')}${more > 0 ? ` And ${more} more.` : ''}${
    error.problems.some(problem => problem.row !== null) ? ` ${rowConvention}` : ''
  }`;
  return {
    error: mapping ? ('import-mapping-invalid' as const) : ('import-values-invalid' as const),
    reason,
    problems: error.problems,
    total: error.total,
    truncated: error.truncated,
    instruction: mapping ? importMappingInstruction : importValuesInstruction,
  };
}

const planKinds = z.object({
  plans: z.array(z.object({ kind: z.string(), expectedRevision: z.string().nullable().optional() })),
});
const structureOnly =
  'This review creates only the structure of the new table: it holds no rows, so approving it imports nothing. If the person asked to import a file or add rows, say plainly that the rows are not in this review. Tell them that after they approve the table, you can import the file into it as a separate review, or add the rows.';

/** A note for a proposal that creates a table but brings no rows, so chat never calls it an import. */
export function structureOnlyNote(value: unknown) {
  const parsed = planKinds.safeParse(value);
  if (!parsed.success) return {};
  const input = parsed.data;
  const createsTable = input.plans.some(plan => plan.kind === 'schema' && plan.expectedRevision === null);
  const bringsRows = input.plans.some(plan => plan.kind === 'records' || plan.kind === 'import');
  return createsTable && !bringsRows ? { rowsIncluded: false as const, instruction: structureOnly } : {};
}

export function tableReviewSummary(
  plans: ProposalManifest['plans'],
  attachments: readonly { attachmentId: string; filename: string }[],
) {
  const changes = plans.map(plan => {
    const table = JSON.stringify(plan.after.label);
    if (plan.input.kind === 'import') {
      const reference = plan.input.reference;
      const source =
        reference.kind === 'file'
          ? JSON.stringify(
              attachments.find(file => file.attachmentId === reference.attachmentId)?.filename ??
                reference.attachmentId,
            )
          : `integration result ${reference.resultId}`;
      return `Import ${plan.effectCount} row changes into ${table} from ${source}.`;
    }
    if (plan.input.kind === 'records') return `Review ${plan.effectCount} row changes in ${table}.`;
    if (plan.input.kind === 'schema')
      return `Review the structure of ${table}.${plan.input.expectedRevision === null ? ' This creates the table only; no rows are included.' : ''}`;
    return `Review the ${plan.input.kind} of ${table}.`;
  });
  return `A review card is ready in this chat.\n\n${changes.join('\n\n')}\n\nNothing in this card has been applied. Review and approve it to apply these changes.`;
}

const keptValues =
  'These fields have no transform output, so each row kept its current value, which does not fit the field’s new definition. If a field changed kind, its existing values need a convert transform: add {"fieldId":F,"expression":{"op":"convert","input":{"op":"field","fieldId":F},"to":KIND,"timezone":"UTC","onError":"error"}} to transforms.outputs and propose again, so that only values that truly cannot convert are blocked. convert supports text, numeric, boolean, date and timestamp targets under the rules in proposalInputSchema; never tell the person that conversion is unsupported.';
const blockedRecords = z.object({
  tableId: z.string(),
  records: z.array(z.object({ fieldId: z.string().nullable(), code: z.string() })),
});
const schemaOutputs = z.object({
  plans: z.array(
    z.object({
      kind: z.string(),
      tableId: z.string(),
      transforms: z.object({ outputs: z.array(z.object({ fieldId: z.string() })) }).optional(),
    }),
  ),
});

/** A note for a blocked schema change whose invalid fields had no transform output, so chat adds the conversion. */
export function missingTransformNote(report: unknown, input: unknown) {
  const blocked = blockedRecords.safeParse(report);
  const parsed = schemaOutputs.safeParse(input);
  if (!blocked.success || !parsed.success) return {};
  const plan = parsed.data.plans.find(plan => plan.kind === 'schema' && plan.tableId === blocked.data.tableId);
  if (!plan?.transforms) return {};
  const outputs = new Set(plan.transforms.outputs.map(output => output.fieldId));
  const fieldIds = [
    ...new Set(
      blocked.data.records.flatMap(record =>
        record.code === 'invalid-output' && record.fieldId && !outputs.has(record.fieldId) ? [record.fieldId] : [],
      ),
    ),
  ];
  return fieldIds.length ? { fieldsWithoutTransform: fieldIds, transformInstruction: keptValues } : {};
}

export function tableProposalOptions(
  runtime: TableProposalOptions['runtime'],
  objects?: Pick<TableImportOptions, 'attachments' | 'snapshots'>,
): TableProposalOptions {
  return {
    runtime,
    data: generationProposalData,
    ...(objects ? { imports: createTableImports({ ...objects, requireSources: requireTableSources }) } : {}),
    requireSources: requireTableSources,
    readableFiles: readableTableFiles,
  };
}

type BlockingWorkflow = { id: string; name: string; url?: string };
type WorkflowsUsing = (tableId: string) => Promise<BlockingWorkflow[]>;

/** What chat is told when an archive is blocked: the readable workflows that block it, or the generic reason. */
export async function blockedArchive(
  code: 'table-linked' | 'workflow-active',
  value: unknown,
  workflowsUsing?: WorkflowsUsing,
) {
  const input = proposeTableSchema.safeParse(value);
  const found = new Map<string, BlockingWorkflow>();
  if (code === 'workflow-active' && workflowsUsing && input.success)
    for (const plan of input.data.plans)
      if (plan.kind === 'archive')
        for (const workflow of await workflowsUsing(plan.tableId).catch(() => [])) found.set(workflow.id, workflow);
  return found.size
    ? {
        error: code,
        workflows: [...found.values()],
        instruction: `No proposal was created. The table cannot be archived because active workflows the person can see use it. Name and link each workflow in the "workflows" field and tell the person to disable or archive it, then try again. Other active workflows the person cannot see may also use the table; do not guess about them. This is not a permission denial.`,
      }
    : { error: code, instruction: archiveBlocked[code] };
}

export function createChatTableProposals(
  runtime: TableProposalOptions['runtime'],
  objects?: Pick<TableImportOptions, 'attachments' | 'snapshots'>,
  /** Enabled workflows using a table that the person can read; unreadable ones must never be returned. */
  workflowsUsing?: WorkflowsUsing,
) {
  const service = createTableProposals(tableProposalOptions(runtime, objects));
  return {
    ...service,
    async propose(...args: Parameters<typeof service.propose>) {
      try {
        const result = await service.propose(...args);
        if (!('status' in result)) return result;
        return result.status === 'blocked'
          ? { ...result, ...missingTransformNote(result, args[4]) }
          : { ...result, ...structureOnlyNote(args[4]) };
      } catch (error) {
        if (error instanceof TableProposalError && (error.code === 'table-linked' || error.code === 'workflow-active'))
          return blockedArchive(error.code, args[4], workflowsUsing);
        if (
          (error instanceof TableProposalError && error.code === 'import-reference-unknown') ||
          (error instanceof TableImportError && error.code === 'snapshot-unavailable')
        )
          return { error: 'import-not-prepared', instruction: importNotPrepared };
        if (error instanceof TableImportPlanError) return importPlanResult(error);
        if (error instanceof TableImportError)
          return {
            ...tableImportFailure(error),
            instruction:
              'No proposal was created and nothing changed. This is not a permission denial. The prepared file could not be read for this import. Tell the person this reason in plain words, without tool names, and what they can do next.',
          };
        if (error instanceof TableValidationError)
          return {
            error: 'invalid-values' as const,
            message: error.message,
            ...(error.fieldId ? { fieldId: error.fieldId } : {}),
            instruction: `No proposal was created and nothing changed. This is not a permission denial. ${proposalFailures['invalid-values']}`,
          };
        if (
          error instanceof TableProposalError &&
          error.code in proposalFailures &&
          !(error instanceof TableProposalValidationError)
        )
          return {
            error: error.code,
            instruction: `No proposal was created and nothing changed. This is not a permission denial. ${proposalFailures[error.code as keyof typeof proposalFailures]}`,
          };
        if (!(error instanceof TableProposalValidationError)) throw error;
        return { ...error.validation, ...missingTransformNote(error.validation, args[4]) };
      }
    },
  };
}
