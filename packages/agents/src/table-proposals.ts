import { createTableProposals, type TableProposalOptions } from '@tulipfarm/tables/proposals';
import { generationProposalData } from '@tulipfarm/tables/store';
import { readableTableFiles, requireTableSources } from './table-sources.ts';
import { createTableImports, TableImportError, type TableImportOptions } from '@tulipfarm/tables/imports';
import { TableProposalError, TableProposalValidationError } from '@tulipfarm/tables/proposal-contracts';
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

export function createChatTableProposals(
  runtime: TableProposalOptions['runtime'],
  objects?: Pick<TableImportOptions, 'attachments' | 'snapshots'>,
) {
  const service = createTableProposals(tableProposalOptions(runtime, objects));
  return {
    ...service,
    async propose(...args: Parameters<typeof service.propose>) {
      try {
        const result = await service.propose(...args);
        return 'status' in result ? { ...result, ...structureOnlyNote(args[4]) } : result;
      } catch (error) {
        if (error instanceof TableProposalError && (error.code === 'table-linked' || error.code === 'workflow-active'))
          return { error: error.code, instruction: archiveBlocked[error.code] };
        if (
          (error instanceof TableProposalError && error.code === 'import-reference-unknown') ||
          (error instanceof TableImportError && error.code === 'snapshot-unavailable')
        )
          return { error: 'import-not-prepared', instruction: importNotPrepared };
        if (!(error instanceof TableProposalValidationError)) throw error;
        return error.validation;
      }
    },
  };
}
