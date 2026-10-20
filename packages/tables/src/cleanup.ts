import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { lockAuthorization } from '@tulipfarm/access';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { errorAttributes, withErrorStage } from '@tulipfarm/observability';
import { executionCompatibility } from './execution.ts';
import { table, type TableTransaction } from './service-store.ts';
import { proposalManifestSchema, redactedManifestSchema } from './proposal-contracts.ts';
import { tableProposalDigest } from './proposals.ts';
import { fieldColumn, generationSchema, lockCatalogs, pruneHistoryValues, workspaceMembersTable } from './store.ts';
import { workspaceMemberFields } from './workspace-members.ts';

async function pruneMemberImages(tx: TableTransaction, limit: number) {
  const registration = await workspaceMembersTable(tx);
  if (!registration) return 0;
  const tableId = registration.coreDefinition.id;
  await lockCatalogs(tx, [tableId], true);
  const generations = z
    .array(generationSchema)
    .parse(
      (
        await tx.client.query(
          `SELECT * FROM ${table(tx, 'tf_table_generations')} WHERE table_id=$1 AND physical_removed_at IS NULL`,
          [tableId],
        )
      ).rows,
    );
  const reference = `($3 || i.member_id::text || '/photos/' || i.digest)`;
  const retained = generations.map(
    generation => `NOT EXISTS(SELECT 1 FROM ${table(tx, generation.physical_table)} r
    WHERE r.id=i.member_id AND r.${fieldColumn(workspaceMemberFields.photo)}=${reference})`,
  );
  retained.push(`NOT EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_row_history_data')} h
    WHERE h.table_id=i.table_id AND h.row_id=i.member_id
      AND (strpos(h.values::text,${reference})>0 OR strpos(h.before_values::text,${reference})>0))`);
  retained.push(`NOT EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_row_requests')} r
    WHERE r.table_id=i.table_id AND (strpos(r.input::text,${reference})>0 OR strpos(r.result::text,${reference})>0))`);
  retained.push(`NOT EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_proposals')} p
    WHERE p.redacted_at IS NULL AND strpos(p.manifest::text,${reference})>0)`);
  for (const [name, column] of [
    ['tf_table_proposal_effects', 'effect'],
    ['tf_table_proposal_freshness', 'snapshot'],
    ['tf_table_proposal_matches', 'mapped'],
    ['tf_table_proposal_changes', 'key_value'],
  ] as const)
    retained.push(`NOT EXISTS(SELECT 1 FROM ${table(tx, name)} r
    WHERE r.table_id=i.table_id AND strpos(r.${column}::text,${reference})>0)`);
  return (
    (
      await tx.client.query(
        `WITH expired AS (
    SELECT i.member_id,i.digest FROM ${table(tx, 'tf_workspace_member_images')} i
    WHERE i.table_id=$1 AND i.created_at<=clock_timestamp()-interval '30 days' AND ${retained.join(' AND ')}
    ORDER BY i.created_at,i.member_id,i.digest LIMIT $2
  ) DELETE FROM ${table(tx, 'tf_workspace_member_images')} i USING expired e
    WHERE i.member_id=e.member_id AND i.digest=e.digest`,
        [tableId, limit, `/v1/workspaces/${tx.workspaceId}/workspace-members/`],
      )
    ).rowCount ?? 0
  );
}

const proposalCopies = ['tf_table_proposal_matches', 'tf_table_proposal_freshness', 'tf_table_proposal_capture'];

async function retryAuthorization<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt >= 2 ||
        !z.object({ code: z.literal('55P03') }).safeParse(error).success ||
        errorAttributes(error)['error.stage'] !== 'table-cleanup-authorization'
      )
        throw error;
      await delay(50 * (attempt + 1));
    }
  }
}

async function hasCleanupCandidates(tx: TableTransaction) {
  // A negative preflight skips only this sweep; mutations still recheck under the authority fence.
  const result = await tx.client.query(`SELECT EXISTS(
    SELECT 1 FROM ${table(tx, 'tf_table_proposals')} p
    WHERE p.redacted_at IS NULL AND p.expires_at<=clock_timestamp()-interval '30 days'
  ) OR EXISTS(
    SELECT 1 FROM ${table(tx, 'tf_table_proposal_effects')} e
    JOIN ${table(tx, 'tf_table_proposals')} p ON p.id=e.proposal_id
    WHERE p.redacted_at IS NOT NULL AND NOT(e.effect ? 'redacted')
  ) OR ${proposalCopies
    .map(
      name => `EXISTS(
    SELECT 1 FROM ${table(tx, name)} v JOIN ${table(tx, 'tf_table_proposals')} p ON p.id=v.proposal_id
    WHERE p.redacted_at IS NOT NULL
  )`,
    )
    .join(' OR ')} OR EXISTS(
    SELECT 1 FROM ${table(tx, 'tf_table_proposal_changes')} d
    WHERE d.created_at<=clock_timestamp()-interval '30 days'
  ) OR EXISTS(
    SELECT 1 FROM ${table(tx, 'tf_table_row_history_data')} h
    JOIN ${table(tx, 'tf_table_generations')} g ON g.id=h.generation_id
    WHERE (CASE WHEN h.operation='transform' THEN g.activated_at+interval '30 days' ELSE h.recoverable_until END)<=clock_timestamp()
      AND (h.values IS NOT NULL OR h.before_values IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_history_holds')} hold WHERE hold.history_id=h.id)
  ) OR EXISTS(
    SELECT 1 FROM ${table(tx, 'tf_table_row_requests')} r
    WHERE r.created_at<=clock_timestamp()-interval '30 days' AND r.input IS NOT NULL
  ) OR EXISTS(
    SELECT 1 FROM ${table(tx, 'tf_table_generations')} g
    WHERE g.state<>'active' AND g.physical_table ~ '^g_' AND g.physical_removed_at IS NULL
      AND COALESCE(g.retired_at,g.created_at)<clock_timestamp()-interval '30 days'
  ) AS needed`);
  if (z.object({ needed: z.boolean() }).parse(result.rows[0]).needed) return true;
  const registration = await workspaceMembersTable(tx);
  if (!registration) return false;
  const images = await tx.client.query(
    `SELECT 1 FROM ${table(tx, 'tf_workspace_member_images')}
    WHERE table_id=$1 AND created_at<=clock_timestamp()-interval '30 days' LIMIT 1`,
    [registration.coreDefinition.id],
  );
  return images.rows.length > 0;
}

async function pruneProposals(tx: TableTransaction, limit: number) {
  // The authority fence also excludes previews that have not inserted their capture yet.
  await withErrorStage('table-cleanup-authorization', () => lockAuthorization(tx, 'write'));
  const row = (
    await tx.client.query(`SELECT p.* FROM ${table(tx, 'tf_table_proposals')} p
    WHERE p.redacted_at IS NULL AND GREATEST(p.expires_at,
      COALESCE((SELECT max(created_at) FROM ${table(tx, 'tf_table_proposal_decisions')} WHERE proposal_id=p.id),p.created_at),
      COALESCE((SELECT max(created_at) FROM ${table(tx, 'tf_table_proposal_receipts')} WHERE proposal_id=p.id),p.created_at),
      COALESCE((SELECT max(created_at) FROM ${table(tx, 'tf_table_proposal_controls')} WHERE proposal_id=p.id),p.created_at),
      COALESCE((SELECT max(created_at) FROM ${table(tx, 'tf_table_executions')} WHERE proposal_id=p.id),p.created_at))<=clock_timestamp()-interval '30 days'
    AND NOT EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_row_history_data')} h
      JOIN ${table(tx, 'tf_table_generations')} g ON g.id=h.generation_id
      WHERE (EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_proposal_effects')} e WHERE e.proposal_id=p.id AND e.table_id=h.table_id AND e.effect->>'recordId'=h.row_id::text)
        OR EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_proposal_freshness')} f WHERE f.proposal_id=p.id AND f.table_id=h.table_id AND f.row_id=h.row_id)
        OR EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_proposal_matches')} m WHERE m.proposal_id=p.id AND m.table_id=h.table_id AND m.row_id=h.row_id)
        OR EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_executions')} e WHERE e.proposal_id=p.id AND h.generation_id IN (e.source_generation,e.target_generation)))
      AND (EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_history_holds')} hold WHERE hold.history_id=h.id)
        OR (CASE WHEN h.operation='transform' THEN g.activated_at+interval '30 days' ELSE h.recoverable_until END)>clock_timestamp()))
    ORDER BY p.created_at,p.id LIMIT 1 FOR UPDATE OF p SKIP LOCKED`)
  ).rows[0];
  if (row) {
    await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,761031))', [`${tx.schema}:${row.id}`]);
    const manifest = proposalManifestSchema.parse(row.manifest);
    if (tableProposalDigest(manifest) !== row.digest) throw new Error('proposal-retention-integrity');
    const redactedAt = new Date().toISOString();
    const metadata = redactedManifestSchema.parse({
      version: 1,
      id: manifest.id,
      workspaceId: manifest.workspaceId,
      requester: manifest.requester,
      conversationId: manifest.conversationId,
      turnId: manifest.turnId,
      expiresAt: manifest.expiresAt,
      createdAt: z.date().parse(row.created_at).toISOString(),
      redactedAt,
      originalDigest: row.digest,
      originalInputDigest: row.input_digest,
      plans: manifest.plans.map(plan => ({
        input: { tableId: plan.input.tableId, kind: plan.input.kind },
        fieldIds: [...new Set([...plan.after.fields, ...(plan.before?.fields ?? [])].map(field => field.id))],
        effectCount: plan.effectCount,
        effectsDigest: plan.effectsDigest,
        freshnessDigest: plan.freshnessDigest,
        ...(plan.importMatchesDigest ? { importMatchesDigest: plan.importMatchesDigest } : {}),
      })),
    });
    await tx.client.query(
      `UPDATE ${table(tx, 'tf_table_proposals')} SET manifest=$2,redacted_at=$3,redacted_digest=$4 WHERE id=$1`,
      [manifest.id, metadata, redactedAt, tableProposalDigest(metadata)],
    );
    await tx.client.query(
      `UPDATE ${table(tx, 'tf_table_executions')} SET phase='blocked',error_code=COALESCE(error_code,'proposal-redacted') WHERE proposal_id=$1 AND phase<>'completed'`,
      [manifest.id],
    );
    return true;
  }
  const effects = await tx.client.query(
    `WITH expired AS (
    SELECT e.proposal_id,e.table_id,e.ordinal FROM ${table(tx, 'tf_table_proposal_effects')} e
    JOIN ${table(tx, 'tf_table_proposals')} p ON p.id=e.proposal_id
    WHERE p.redacted_at IS NOT NULL AND NOT(e.effect ? 'redacted') LIMIT $1
  ) UPDATE ${table(tx, 'tf_table_proposal_effects')} e SET effect=jsonb_build_object(
    'redacted',true,'recordId',e.effect->'recordId','kind',e.effect->'kind',
    'fieldIds',(SELECT COALESCE(jsonb_agg(field),'[]'::jsonb) FROM (
      SELECT jsonb_object_keys(COALESCE(NULLIF(e.effect->'before','null'::jsonb),'{}'::jsonb)) field
      UNION SELECT jsonb_object_keys(COALESCE(NULLIF(e.effect->'after','null'::jsonb),'{}'::jsonb)) field) fields))
    FROM expired x WHERE (e.proposal_id,e.table_id,e.ordinal)=(x.proposal_id,x.table_id,x.ordinal)`,
    [limit],
  );
  if (effects.rowCount) return true;
  for (const name of proposalCopies) {
    if (
      (
        await tx.client.query(
          `DELETE FROM ${table(tx, name)} WHERE ctid IN (
      SELECT v.ctid FROM ${table(tx, name)} v JOIN ${table(tx, 'tf_table_proposals')} p ON p.id=v.proposal_id WHERE p.redacted_at IS NOT NULL LIMIT $1)`,
          [limit],
        )
      ).rowCount
    )
      return true;
  }
  // A change log entry may still invalidate an in-flight preview or resumable import.
  if (
    (
      await tx.client.query(
        `DELETE FROM ${table(tx, 'tf_table_proposal_changes')} WHERE ctid IN (
    SELECT d.ctid FROM ${table(tx, 'tf_table_proposal_changes')} d WHERE d.created_at<=clock_timestamp()-interval '30 days'
    AND NOT EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_proposal_capture')} c JOIN ${table(tx, 'tf_table_proposals')} p ON p.id=c.proposal_id
      WHERE p.redacted_at IS NULL AND c.table_id=d.table_id AND d.xid>=pg_snapshot_xmin(c.snapshot) AND NOT pg_visible_in_snapshot(d.xid,c.snapshot)) LIMIT $1)`,
        [limit],
      )
    ).rowCount
  )
    return true;
  return false;
}

export function createTableCleanup(options: {
  resolveMigrationCredential(workspaceId: string): Promise<string>;
  batchRows?: number;
}) {
  const limit = z
    .int()
    .min(1)
    .max(1000)
    .parse(options.batchRows ?? 100);
  const credential = (workspaceId: string) =>
    withErrorStage('table-cleanup-credentials', () => options.resolveMigrationCredential(workspaceId));
  const database = (workspaceId: string) =>
    retryAuthorization(async () =>
      withMaintenanceTransaction({
        workspaceId,
        connectionString: await credential(workspaceId),
        capability: 'migration',
        operation: async transaction => {
          const tx = { ...transaction, workspaceId, commonVersion: executionCompatibility.minimum };
          await withErrorStage('maintenance-settings', () =>
            tx.client.query(
              "SET LOCAL lock_timeout='250ms'; SET LOCAL transaction_timeout='2s'; SET LOCAL statement_timeout='1500ms'",
            ),
          );
          if (!(await withErrorStage('table-cleanup-discovery', () => hasCleanupCandidates(tx))))
            return 'completed' as const;
          if (await withErrorStage('table-cleanup-proposals', () => pruneProposals(tx, limit))) return 'more' as const;
          const pruned = await withErrorStage('table-cleanup-history', () => pruneHistoryValues(tx, limit));
          if (pruned) return 'more' as const;
          const receipts = await withErrorStage('table-cleanup-receipts', () =>
            tx.client.query(
              `WITH expired AS (
      SELECT r.membership_id,r.table_id,r.request_id FROM ${table(tx, 'tf_table_row_requests')} r
      WHERE r.created_at<=clock_timestamp()-interval '30 days' AND r.input IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_row_history_data')} h
          JOIN ${table(tx, 'tf_table_history_holds')} hold ON hold.history_id=h.id
          WHERE h.table_id=r.table_id AND h.row_id=(r.result->>'id')::uuid)
      ORDER BY r.created_at,r.membership_id,r.table_id,r.request_id LIMIT $1 FOR UPDATE OF r SKIP LOCKED
    ) UPDATE ${table(tx, 'tf_table_row_requests')} r
      SET input=NULL,result=jsonb_build_object('kind','expired','id',r.result->'id','token',r.result->'token')
      FROM expired e WHERE (r.membership_id,r.table_id,r.request_id)=(e.membership_id,e.table_id,e.request_id)`,
              [limit],
            ),
          );
          if (receipts.rowCount) return 'more' as const;
          const eligible = `g.state<>'active' AND g.physical_table ~ '^g_' AND g.physical_removed_at IS NULL
      AND COALESCE(g.retired_at,g.created_at)<clock_timestamp()-interval '30 days'
      AND NOT EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_catalog')} c WHERE c.physical_table=g.physical_table)
      AND NOT EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_executions')} e JOIN ${table(tx, 'tf_table_proposals')} p ON p.id=e.proposal_id
        WHERE (e.source_generation=g.id OR e.target_generation=g.id)
          AND p.redacted_at IS NULL AND (e.phase IN ('publishing','copying','reconciling') OR (e.phase='blocked' AND p.expires_at>clock_timestamp())))
      AND NOT EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_row_history_data')} h WHERE h.generation_id=g.id
        AND ((CASE WHEN h.operation='transform' THEN g.activated_at+interval '30 days' ELSE h.recoverable_until END)>clock_timestamp()
          OR EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_history_holds')} hold WHERE hold.history_id=h.id)))`;
          const generation = await withErrorStage('table-cleanup-generation', async () =>
            generationSchema
              .optional()
              .parse(
                (
                  await tx.client.query(
                    `SELECT g.* FROM ${table(tx, 'tf_table_generations')} g WHERE ${eligible} ORDER BY g.created_at,g.id LIMIT 1 FOR UPDATE OF g`,
                  )
                ).rows[0],
              ),
          );
          if (!generation)
            return (await withErrorStage('table-cleanup-member-images', () => pruneMemberImages(tx, limit)))
              ? ('more' as const)
              : ('completed' as const);
          await withErrorStage('table-cleanup-catalog', () => lockCatalogs(tx, [generation.table_id], true));
          if (
            !(
              await withErrorStage('table-cleanup-generation', () =>
                tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_table_generations')} g WHERE g.id=$1 AND ${eligible}`, [
                  generation.id,
                ]),
              )
            ).rowCount
          )
            return 'more' as const;
          for (const name of [
            'tf_table_generation_links',
            'tf_table_unique_values',
            'tf_table_generation_conflicts',
            'tf_table_generation_versions',
          ]) {
            if (
              (
                await withErrorStage('table-cleanup-generation-data', () =>
                  tx.client.query(
                    `DELETE FROM ${table(tx, name)} WHERE ctid IN (SELECT ctid FROM ${table(tx, name)} WHERE generation_id=$1 LIMIT $2)`,
                    [generation.id, limit],
                  ),
                )
              ).rowCount
            )
              return 'more' as const;
          }
          if (
            generation.state === 'building' &&
            (
              await withErrorStage('table-cleanup-generation-data', () =>
                tx.client.query(
                  `DELETE FROM ${table(tx, 'tf_table_row_history_data')} WHERE id IN (SELECT id FROM ${table(tx, 'tf_table_row_history_data')} WHERE generation_id=$1 LIMIT $2)`,
                  [generation.id, limit],
                ),
              )
            ).rowCount
          )
            return 'more' as const;
          await withErrorStage('table-cleanup-drop', () =>
            tx.client.query(`DROP TABLE IF EXISTS ${table(tx, generation.physical_table)}`),
          );
          await withErrorStage('table-cleanup-generation', () =>
            tx.client.query(
              `UPDATE ${table(tx, 'tf_table_generations')} SET physical_removed_at=clock_timestamp() WHERE id=$1`,
              [generation.id],
            ),
          );
          return 'more' as const;
        },
      }),
    );
  return async (workspaceId: string) => {
    const result = await database(workspaceId);
    const queued = await retryAuthorization(async () =>
      withMaintenanceTransaction({
        workspaceId,
        connectionString: await credential(workspaceId),
        capability: 'migration',
        operation: async tx => {
          await withErrorStage('maintenance-settings', () =>
            tx.client.query(
              "SET LOCAL lock_timeout='250ms'; SET LOCAL transaction_timeout='2s'; SET LOCAL statement_timeout='1500ms'",
            ),
          );
          const needed = await withErrorStage(
            'table-cleanup-imports',
            async () =>
              z.object({ needed: z.boolean() }).parse(
                (
                  await tx.client.query(`SELECT EXISTS(
        SELECT 1 FROM ${table(tx, 'tf_table_import_objects')}
        WHERE cleanup_pending_at IS NULL AND last_used_at<=clock_timestamp()-interval '30 days'
      ) AS needed`)
                ).rows[0],
              ).needed,
          );
          if (!needed) return false;
          await withErrorStage('table-cleanup-authorization', () => lockAuthorization(tx, 'write'));
          const marked = await withErrorStage('table-cleanup-imports', () =>
            tx.client.query(
              `UPDATE ${table(tx, 'tf_table_import_objects')} o SET cleanup_pending_at=clock_timestamp()
        WHERE o.object_key IN (SELECT o.object_key FROM ${table(tx, 'tf_table_import_objects')} o
          WHERE cleanup_pending_at IS NULL AND last_used_at<=clock_timestamp()-interval '30 days'
          AND NOT EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_proposals')} p, jsonb_array_elements(p.manifest->'plans') plan
            WHERE p.redacted_at IS NULL AND p.membership_id=o.membership_id AND p.conversation_id=o.conversation_id
              AND (plan->'input'->'reference'->>'kind')=o.kind
              AND COALESCE(plan->'input'->'reference'->>'attachmentId',plan->'input'->'reference'->>'resultId')=o.reference_id::text)
          AND NOT EXISTS(SELECT 1 FROM ${table(tx, 'tf_conversation_turns')} t WHERE t.id=o.turn_id AND t.status IN ('queued','processing','waiting','reconciling','failed'))
          LIMIT $1 FOR UPDATE OF o SKIP LOCKED)`,
              [limit],
            ),
          );
          return Boolean(marked.rowCount);
        },
      }),
    );
    return queued ? ('more' as const) : result;
  };
}
