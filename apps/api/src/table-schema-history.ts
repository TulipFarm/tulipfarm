import { z } from 'zod';
import {
  AccessDenied,
  canAccessTable,
  lockAuthorization,
  requireTablePermission,
  resolveHuman,
} from '@tulipfarm/access';
import { definitionSchema } from '@tulipfarm/tables/definition';
import { executionCompatibility } from '@tulipfarm/tables/execution';
import { workspaceMembersTable } from '@tulipfarm/tables/store';
import {
  executionReceiptSchema,
  proposalManifestSchema,
  redactedManifestSchema,
} from '@tulipfarm/tables/proposal-contracts';
import type { TableProposalOptions } from '@tulipfarm/tables/proposals';

const phaseSchema = z.enum(['publishing', 'copying', 'reconciling', 'completed', 'blocked']);
export const schemaHistoryEntrySchema = z.object({
  id: z.uuid(),
  revision: z.string().nullable(),
  phase: phaseSchema,
  createdAt: z.iso.datetime(),
  savedAt: z.iso.datetime().nullable(),
  appliedAt: z.iso.datetime().nullable(),
  definition: definitionSchema.nullable(),
  receipt: executionReceiptSchema.nullable(),
});
export const schemaHistorySchema = z.object({
  entries: z.array(schemaHistoryEntrySchema),
  nextCursor: z.uuid().nullable(),
});
export const definitionStateSchema = z.object({
  id: z.uuid(),
  systemKind: z.literal('workspace-members').optional(),
  saved: schemaHistoryEntrySchema.nullable(),
  applied: z
    .object({ revision: z.string(), definition: definitionSchema, appliedAt: z.iso.datetime().nullable() })
    .nullable(),
  rowPermissions: z.object({ create: z.boolean(), update: z.boolean(), delete: z.boolean() }),
});

export function createTableSchemaHistory(options: TableProposalOptions) {
  const rowSchema = z.object({
    id: z.uuid(),
    revision: z.string().nullable(),
    phase: phaseSchema,
    created_at: z.date(),
    saved_at: z.date().nullable(),
    activated_at: z.date().nullable(),
    manifest: z.union([proposalManifestSchema, redactedManifestSchema]),
    receipt: executionReceiptSchema.nullable(),
  });
  async function authorized<T>(
    workspaceId: string,
    userId: string,
    tableId: string,
    action: (
      tx: Parameters<TableProposalOptions['requireSources']>[0],
      actor: Parameters<TableProposalOptions['requireSources']>[1],
    ) => Promise<T>,
  ) {
    return options.runtime.transaction(workspaceId, executionCompatibility, async tx => {
      await lockAuthorization(tx);
      const actor = await resolveHuman(tx, userId);
      await requireTablePermission(tx, actor, tableId, 'table.row.read');
      return action(tx, actor);
    });
  }
  async function entries(
    tx: Parameters<TableProposalOptions['requireSources']>[0],
    actor: Parameters<TableProposalOptions['requireSources']>[1],
    tableId: string,
    query: { after?: string; limit: number; latest?: boolean },
  ) {
    const s = `"${tx.schema}"`;
    const rows = z.array(rowSchema).parse(
      (
        await tx.client.query(
          `
      SELECT e.id,e.revision,e.phase,e.created_at,r.accepted_at AS saved_at,g.activated_at,p.manifest,
        (SELECT receipt FROM ${s}.tf_table_proposal_receipts WHERE proposal_id=e.proposal_id AND table_id=e.table_id ORDER BY attempt DESC LIMIT 1) AS receipt
      FROM ${s}.tf_table_executions e JOIN ${s}.tf_table_proposals p ON p.id=e.proposal_id
      LEFT JOIN ${s}.tf_soul_revisions r ON r.table_execution_id=e.publication_id
      LEFT JOIN ${s}.tf_table_generations g ON g.table_id=e.table_id AND g.revision=e.revision
      WHERE e.table_id=$1 AND ($2::uuid IS NULL OR e.id>$2)
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.manifest->'plans') plan WHERE plan->'input'->>'tableId'=e.table_id::text AND plan->'input'->>'kind'='schema')
        ${query.latest ? 'AND r.revision IS NOT NULL' : ''}
      ORDER BY ${query.latest ? 'r.accepted_at DESC,e.id DESC' : 'e.id'} LIMIT $3`,
          [tableId, query.after ?? null, query.limit],
        )
      ).rows,
    );
    const result = [];
    for (const row of rows) {
      let definition = null;
      try {
        if (!('redactedAt' in row.manifest)) {
          const plan = row.manifest.plans.find(plan => plan.input.tableId === tableId);
          await options.requireSources(tx, actor, [...row.manifest.sources, ...(plan?.importSources ?? [])]);
          definition = plan?.after ?? null;
        }
      } catch (error) {
        if (!(error instanceof AccessDenied)) throw error;
      }
      result.push({
        id: row.id,
        revision: row.revision,
        phase: row.phase,
        createdAt: row.created_at.toISOString(),
        savedAt: row.saved_at?.toISOString() ?? null,
        appliedAt: row.activated_at?.toISOString() ?? null,
        definition,
        receipt: row.receipt,
      });
    }
    return result;
  }
  return {
    history(workspaceId: string, userId: string, tableId: string, query: { after?: string; limit: number }) {
      return authorized(workspaceId, userId, tableId, async (tx, actor) => {
        const rows = await entries(tx, actor, tableId, { ...query, limit: query.limit + 1 });
        const page = rows.slice(0, query.limit);
        return { entries: page, nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null };
      });
    },
    state(workspaceId: string, userId: string, tableId: string) {
      return authorized(workspaceId, userId, tableId, async (tx, actor) => {
        const saved = (await entries(tx, actor, tableId, { limit: 1, latest: true }))[0] ?? null;
        const applied = z
          .object({ revision: z.string(), definition: definitionSchema, activated_at: z.date().nullable() })
          .nullable()
          .parse(
            (
              await tx.client.query(
                `SELECT revision,definition,activated_at FROM "${tx.schema}".tf_table_generations WHERE table_id=$1 AND state='active'`,
                [tableId],
              )
            ).rows[0] ?? null,
          );
        const rowPermissions = {
          create: await canAccessTable(tx, actor, tableId, 'table.row.create'),
          update: await canAccessTable(tx, actor, tableId, 'table.row.update'),
          delete: await canAccessTable(tx, actor, tableId, 'table.row.delete'),
        };
        const memberTableId = (await workspaceMembersTable(tx))?.coreDefinition.id;
        return {
          id: tableId,
          ...(tableId === memberTableId ? { systemKind: 'workspace-members' as const } : {}),
          saved,
          applied: applied
            ? {
                revision: applied.revision,
                definition: applied.definition,
                appliedAt: applied.activated_at?.toISOString() ?? null,
              }
            : null,
          rowPermissions,
        };
      });
    },
  };
}
