import { createTableProposals, type TableProposalOptions } from '@tulipfarm/tables/proposals';
import { generationProposalData } from '@tulipfarm/tables/store';
import { readableTableFiles, requireTableSources } from './table-sources.ts';
import { createTableImports, type TableImportOptions } from '@tulipfarm/tables/imports';
import { TableProposalValidationError } from '@tulipfarm/tables/proposal-contracts';

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
        if (!(error instanceof TableProposalValidationError)) throw error;
        return error.validation;
      }
    },
  };
}
