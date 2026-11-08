import type { Pool } from 'pg';
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
import { pageArchiveVersion, pageRestoreVersion, type TableProposalOptions } from '@tulipfarm/tables/proposals';
import { summarizeSchemaChange } from '@tulipfarm/tables/schema-summary';
import { schemaRevertLinks } from './table-schema-revert.ts';

const phaseSchema = z.enum(['publishing', 'copying', 'reconciling', 'completed', 'blocked']);
/** Why an entry's definition is not shown. Null when the definition is shown. */
const definitionWithheldSchema = z.enum(['blocked-before-save', 'retention', 'source-access']);
export const schemaHistoryEntrySchema = z.object({
  id: z.uuid(),
  revision: z.string().nullable(),
  phase: phaseSchema,
  createdAt: z.iso.datetime(),
  savedAt: z.iso.datetime().nullable(),
  appliedAt: z.iso.datetime().nullable(),
  definition: definitionSchema.nullable(),
  definitionWithheld: definitionWithheldSchema.nullable(),
  /** Plain-language lines describing what the change did; null when its definition is withheld. */
  changes: z.array(z.string()).nullable(),
  approval: z.object({ name: z.string(), formerMember: z.boolean(), approvedAt: z.iso.datetime() }).nullable(),
  receipt: executionReceiptSchema.nullable(),
  /** Whether the person can propose reverting this change now, or must first revert later changes. */
  revert: z.enum(['available', 'later-changes']).nullable(),
  /** The earlier change this change reverted. */
  reverts: z.uuid().nullable(),
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
  archived: z.boolean(),
  canArchive: z.boolean(),
  canRestore: z.boolean(),
});

export function createTableSchemaHistory(
  options: TableProposalOptions & {
    /** Resolves approver names. */
    identity?: Pick<Pool, 'query'>;
  },
) {
  async function names(userIds: string[]) {
    if (!options.identity || !userIds.length) return new Map<string, string>();
    const rows = z
      .array(z.object({ id: z.string(), name: z.string() }))
      .parse((await options.identity.query('SELECT id, name FROM app.users WHERE id = ANY($1)', [userIds])).rows);
    return new Map(rows.map(row => [row.id, row.name.trim() || 'Unnamed member']));
  }
  const rowSchema = z.object({
    id: z.uuid(),
    revision: z.string().nullable(),
    phase: phaseSchema,
    created_at: z.date(),
    saved_at: z.date().nullable(),
    activated_at: z.date().nullable(),
    published_definition: definitionSchema.nullable(),
    manifest: z.union([proposalManifestSchema, redactedManifestSchema]),
    receipt: executionReceiptSchema.nullable(),
    approved_at: z.date().nullable(),
    approver_user_id: z.string().nullable(),
    approver_removed_at: z.date().nullable(),
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
      SELECT e.id,e.revision,e.phase,e.created_at,r.accepted_at AS saved_at,g.activated_at,g.definition AS published_definition,p.manifest,
        (SELECT receipt FROM ${s}.tf_table_proposal_receipts WHERE proposal_id=e.proposal_id AND table_id=e.table_id ORDER BY attempt DESC LIMIT 1) AS receipt,
        d.created_at AS approved_at,m.user_id AS approver_user_id,m.removed_at AS approver_removed_at
      FROM ${s}.tf_table_executions e JOIN ${s}.tf_table_proposals p ON p.id=e.proposal_id
      LEFT JOIN ${s}.tf_soul_revisions r ON r.table_execution_id=e.publication_id
      LEFT JOIN ${s}.tf_table_generations g ON g.table_id=e.table_id AND g.revision=e.revision
      LEFT JOIN ${s}.tf_table_proposal_decisions d ON d.proposal_id=e.proposal_id AND d.decision='approve'
      LEFT JOIN ${s}.tf_memberships m ON m.id=d.membership_id
      WHERE e.table_id=$1
        AND ($2::uuid IS NULL OR (e.created_at,e.id)<(SELECT created_at,id FROM ${s}.tf_table_executions WHERE id=$2))
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.manifest->'plans') plan WHERE plan->'input'->>'tableId'=e.table_id::text AND plan->'input'->>'kind'='schema')
        ${query.latest ? 'AND r.revision IS NOT NULL' : ''}
      ORDER BY ${query.latest ? 'r.accepted_at DESC,e.id DESC' : 'e.created_at DESC,e.id DESC'} LIMIT $3`,
          [tableId, query.after ?? null, query.limit],
        )
      ).rows,
    );
    const approvers = await names([
      ...new Set(rows.flatMap(row => (row.approver_user_id ? [row.approver_user_id] : []))),
    ]);
    const result = [];
    for (const row of rows) {
      // A saved definition was published to the Soul, so it is table schema rather than proposal content.
      let definition = row.published_definition;
      let changes = null;
      const redacted = 'redactedAt' in row.manifest;
      if (!('redactedAt' in row.manifest)) {
        const plan = row.manifest.plans.find(plan => plan.input.tableId === tableId);
        let visible = row.saved_at !== null;
        if (!visible)
          try {
            await options.requireSources(tx, actor, [...row.manifest.sources, ...(plan?.importSources ?? [])]);
            visible = true;
          } catch (error) {
            if (!(error instanceof AccessDenied)) throw error;
          }
        if (visible && plan) {
          definition ??= plan.after;
          changes = summarizeSchemaChange(
            plan.before,
            plan.after,
            plan.input.kind === 'schema' ? plan.input.transforms.outputs.map(output => output.fieldId) : [],
          );
        }
      }
      const definitionWithheld = definition
        ? null
        : !row.saved_at && row.phase === 'blocked'
          ? 'blocked-before-save'
          : redacted
            ? 'retention'
            : 'source-access';
      result.push({
        id: row.id,
        revision: row.revision,
        phase: row.phase,
        createdAt: row.created_at.toISOString(),
        savedAt: row.saved_at?.toISOString() ?? null,
        appliedAt: row.activated_at?.toISOString() ?? null,
        definition,
        definitionWithheld,
        changes,
        approval:
          row.approved_at && row.approver_user_id
            ? {
                name: approvers.get(row.approver_user_id) ?? 'Workspace member',
                formerMember: row.approver_removed_at !== null,
                approvedAt: row.approved_at.toISOString(),
              }
            : null,
        receipt: row.receipt,
      });
    }
    return result;
  }
  return {
    history(workspaceId: string, userId: string, tableId: string, query: { after?: string; limit: number }) {
      return authorized(workspaceId, userId, tableId, async (tx, actor) => {
        const rows = await entries(tx, actor, tableId, { ...query, limit: query.limit + 1 });
        const links = await schemaRevertLinks(tx, actor, tableId);
        const page = rows
          .slice(0, query.limit)
          .map(entry => ({ ...entry, revert: links.revert(entry.id), reverts: links.reverts(entry.id) }));
        return { entries: page, nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null };
      });
    },
    state(workspaceId: string, userId: string, tableId: string) {
      return authorized(workspaceId, userId, tableId, async (tx, actor) => {
        // A new table has executions before its catalog row; an address with neither is not a table.
        const exists = !!(
          await tx.client.query(
            `SELECT 1 FROM "${tx.schema}".tf_table_catalog WHERE id=$1 UNION ALL SELECT 1 FROM "${tx.schema}".tf_table_executions WHERE table_id=$1 LIMIT 1`,
            [tableId],
          )
        ).rowCount;
        if (!exists) throw new AccessDenied();
        const latest = (await entries(tx, actor, tableId, { limit: 1, latest: true }))[0];
        const links = latest && (await schemaRevertLinks(tx, actor, tableId));
        const saved =
          latest && links ? { ...latest, revert: links.revert(latest.id), reverts: links.reverts(latest.id) } : null;
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
        const archived = !!(
          await tx.client.query(
            `SELECT 1 FROM "${tx.schema}".tf_table_catalog WHERE id=$1 AND archived_at IS NOT NULL`,
            [tableId],
          )
        ).rowCount;
        const manages =
          applied !== null &&
          tableId !== memberTableId &&
          tx.commonVersion >= (archived ? pageRestoreVersion : pageArchiveVersion) &&
          (await canAccessTable(tx, actor, tableId, 'table.schema.manage'));
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
          archived,
          canArchive: manages && !archived,
          canRestore: manages && archived,
        };
      });
    },
  };
}
