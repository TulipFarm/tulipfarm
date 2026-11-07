import { createTableProposals, type TableProposalOptions } from '@tulipfarm/tables/proposals';
import { generationProposalData } from '@tulipfarm/tables/store';
import { readableTableFiles, requireTableSources } from './table-sources.ts';
import { createTableImports, type TableImportOptions } from '@tulipfarm/tables/imports';
import { TableProposalError, TableProposalValidationError } from '@tulipfarm/tables/proposal-contracts';

const archiveBlocked = {
  'table-linked':
    'No proposal was created: another active table links to this table, so it cannot be archived. Tell the person which table must stop linking to it first; this is not a permission denial.',
  'workflow-active':
    'No proposal was created: an enabled workflow uses this table, so it cannot be archived. Tell the person to archive or turn off the workflows that use it first; this is not a permission denial.',
} as const;

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
        return await service.propose(...args);
      } catch (error) {
        if (error instanceof TableProposalError && (error.code === 'table-linked' || error.code === 'workflow-active'))
          return { error: error.code, instruction: archiveBlocked[error.code] };
        if (!(error instanceof TableProposalValidationError)) throw error;
        return error.validation;
      }
    },
  };
}
