import { z } from 'zod';
import type { SourceDependency } from '@tulipfarm/access';
import type { ProposalManifest } from './proposal-contracts.ts';
import { table, type TableTransaction } from './service-store.ts';

// Only this proposal's own schema execution can advance its original provenance. Publication
// moves the saved revision that `table-schema` pins; completion also moves the applied
// revision that `table-rows` pins. Callers still check current authority for every result.
export async function effectiveProposalSources(
  tx: TableTransaction,
  manifest: ProposalManifest,
  sources: readonly SourceDependency[],
) {
  if (!sources.some(source => source.kind === 'table-rows' || source.kind === 'table-schema')) return sources;
  const transitions = z
    .array(
      z.object({
        kind: z.enum(['table-rows', 'table-schema']),
        table_id: z.uuid(),
        old_revision: z.string(),
        revision: z.string(),
      }),
    )
    .parse(
      (
        await tx.client.query(
          `
    SELECT kind,e.table_id,old.revision AS old_revision,active.revision
    FROM ${table(tx, 'tf_table_executions')} e
    JOIN ${table(tx, 'tf_table_proposal_receipts')} r ON r.proposal_id=e.proposal_id AND r.table_id=e.table_id
      AND r.receipt->>'status'='completed' AND r.receipt->>'executionId'=e.id::text AND r.receipt->>'revision'=e.revision
    JOIN ${table(tx, 'tf_table_generations')} old ON old.id=e.source_generation AND old.table_id=e.table_id
    JOIN ${table(tx, 'tf_table_generations')} active ON active.id=e.target_generation AND active.table_id=e.table_id
      AND active.revision=e.revision AND active.state='active'
    JOIN ${table(tx, 'tf_table_catalog')} c ON c.id=e.table_id AND c.applied_revision=active.revision AND c.physical_table=active.physical_table
    CROSS JOIN unnest(ARRAY['table-rows','table-schema']) AS kind
    WHERE e.proposal_id=$1 AND e.phase='completed'
      AND NOT EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_proposal_receipts')} later
        WHERE later.proposal_id=r.proposal_id AND later.table_id=r.table_id AND later.attempt>r.attempt)
    UNION ALL
    SELECT 'table-schema',e.table_id,active.revision,e.revision
    FROM ${table(tx, 'tf_table_executions')} e
    JOIN ${table(tx, 'tf_table_catalog')} c ON c.id=e.table_id AND c.target_revision=e.revision
    JOIN ${table(tx, 'tf_table_generations')} active ON active.table_id=e.table_id AND active.state='active'
    WHERE e.proposal_id=$1 AND e.phase<>'completed'
  `,
          [manifest.id],
        )
      ).rows,
    );
  return sources.map(source => {
    if (source.kind !== 'table-rows' && source.kind !== 'table-schema') return source;
    const plan = manifest.plans.find(
      plan =>
        plan.input.kind === 'schema' &&
        plan.input.tableId === source.tableId &&
        plan.input.expectedRevision === source.revision,
    );
    const transition =
      plan &&
      transitions.find(
        row => row.kind === source.kind && row.table_id === source.tableId && row.old_revision === source.revision,
      );
    return transition ? { ...source, revision: transition.revision } : source;
  });
}
