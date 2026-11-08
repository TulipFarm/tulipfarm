import { createTableProposals, type TableProposalOptions } from '@tulipfarm/tables/proposals';
import { generationProposalData } from '@tulipfarm/tables/store';
import { readableTableFiles, requireTableSources } from './table-sources.ts';
import { createTableImports, TableImportError, type TableImportOptions } from '@tulipfarm/tables/imports';
import {
  proposeTableSchema,
  TableProposalError,
  TableProposalValidationError,
} from '@tulipfarm/tables/proposal-contracts';
import { z } from 'zod';

const archiveBlocked = {
  'table-linked':
    'No proposal was created: another active table links to this table, so it cannot be archived. Tell the person which table must stop linking to it first; this is not a permission denial.',
  'workflow-active':
    'No proposal was created: an enabled workflow uses this table, so it cannot be archived. Tell the person to archive or turn off the workflows that use it first; this is not a permission denial.',
} as const;
const importNotPrepared =
  'No proposal was created. This is not a permission denial: the import plan does not name a source prepared in this reply. Load the import tools with tools_search, call tables.import.attachments, then tables.import.file for the chosen attachment in this same reply, and copy the attachmentId and contentDigest it returns into the plan unchanged. For an integration import, use the resultId of a completed read in this chat. Never invent or reuse references from earlier replies.';

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
        if (!(error instanceof TableProposalValidationError)) throw error;
        return { ...error.validation, ...missingTransformNote(error.validation, args[4]) };
      }
    },
  };
}
