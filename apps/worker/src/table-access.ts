import type { ExecutionAccess } from '@tulipfarm/tables/execution';
import {
  bindTableSourceAuthorization,
  requireTableSources,
  requireTableFiles,
  requireTableImportReference,
} from '@tulipfarm/agents/table-sources';

// Execution and publication recheck a proposal's sources in their own transactions.
export const tableExecutionAccess = {
  requireSources: requireTableSources,
  requireFiles: requireTableFiles,
  requireImportReference: requireTableImportReference,
  bindSourceAuthorization: bindTableSourceAuthorization,
} satisfies ExecutionAccess;
