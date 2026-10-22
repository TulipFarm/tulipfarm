import { randomUUID } from 'node:crypto';
import { escapeIdentifier } from 'pg';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  requireTablePermission,
  type HumanActor,
  type SourceDependency,
} from '@tulipfarm/access';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { canonicalJson } from './canonical.ts';
import {
  proposalManifestSchema,
  effectSchema,
  TableProposalError,
  type ProposalManifest,
  type ReviewedPlan,
  type TableEffect,
} from './proposal-contracts.ts';
import { tableProposalDigest } from './proposals.ts';
import {
  addedFileIds,
  archiveBlockers,
  destinationAudience,
  fileCheckBatch,
  planAuthority,
  proposalFreshness,
  proposalFreshnessSchema,
  recordEffects,
  requireFileBatches,
  transformedEffect,
  changedEffect,
  requireProposalCaptureCurrent,
  type FileAccess,
} from './proposal-data.ts';
import { evaluateTransforms } from './transforms.ts';
import { fieldIdSchema, validateRecord, type TableDefinition, type TableValues } from './definition.ts';
import { table, type TableRuntime, type TableTransaction } from './service-store.ts';
import * as store from './store.ts';
import { effectiveProposalSources } from './proposal-sources.ts';
import { requireNoMcpDerived } from '@tulipfarm/access';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { recordTableRecommendationChange } from './recommendations.ts';
import { requireFixedTableTitle, reserveDefinitionNames } from './identities.ts';
import type { TableNames } from './names.ts';
import { WorkspaceMemberError } from './workspace-members.ts';

export const executionCompatibility = commonCompatibility;
const executionSchema = z.object({
  id: z.uuid(),
  proposal_id: z.uuid(),
  table_id: z.uuid(),
  phase: z.enum(['publishing', 'copying', 'reconciling', 'completed', 'blocked']),
  source_generation: z.uuid().nullable(),
  target_generation: z.uuid().nullable(),
  checkpoint: z.uuid().nullable(),
  checked_effects: z.int(),
  checked_freshness: z.int(),
  effect_checkpoint: z.int(),
  resumed_sequence: z.int(),
  publication_id: z.uuid(),
  parent_revision: z.string().nullable(),
  revision: z.string().nullable(),
  created_at: z.date(),
  batch_limit: z.int(),
  timeout_failures: z.int(),
});
type Execution = z.infer<typeof executionSchema>;
class ExecutionBudgetExceeded extends Error {}
export type ExecutionAccess = {
  requireSources(
    tx: TableTransaction,
    actor: HumanActor,
    sources: readonly SourceDependency[],
    conversationId: string,
  ): Promise<void>;
  requireFiles?: FileAccess;
  requireImportReference?: (
    tx: TableTransaction,
    actor: HumanActor,
    conversationId: string,
    reference: Extract<ReviewedPlan['input'], { kind: 'import' }>['reference'],
  ) => Promise<void>;
};
export type PrepareTableDefinition = (input: {
  workspaceId: string;
  commandId: string;
  expectedParentCommit: string;
  createdAt: string;
  parent: { key: string; sha256: string } | null;
  definition: TableDefinition;
  tableNames?: TableNames;
}) => Promise<{ commit: string; parentCommit: string; bundle: { key: string; sha256: string }; projection: unknown }>;

async function load(tx: TableTransaction, proposalId: string) {
  await lockAuthorization(tx);
  await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,761031))', [
    `${tx.schema}:${z.uuid().parse(proposalId)}`,
  ]);
  const stored = (
    await tx.client.query(`SELECT manifest,digest,redacted_at FROM ${table(tx, 'tf_table_proposals')} WHERE id=$1`, [
      proposalId,
    ])
  ).rows[0];
  if (stored?.redacted_at) throw new TableProposalError('proposal-redacted');
  const row = z.object({ manifest: proposalManifestSchema, digest: z.string() }).parse(stored);
  if (tableProposalDigest(row.manifest) !== row.digest || row.manifest.workspaceId !== tx.workspaceId)
    throw new TableProposalError('proposal-conflict');
  return row.manifest;
}

async function admit(tx: TableTransaction, manifest: ProposalManifest, plan: ReviewedPlan, access: ExecutionAccess) {
  await requireNoMcpDerived(tx, [...manifest.sources, ...plan.importSources]);
  await currentMember(tx, manifest.requester);
  if (
    (
      await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'tf_table_proposals')} WHERE id=$1 AND expires_at<=clock_timestamp()`,
        [manifest.id],
      )
    ).rowCount
  )
    throw new TableProposalError('proposal-expired');
  if (
    !(
      await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'tf_table_proposals')} p JOIN ${table(tx, 'tf_table_proposal_decisions')} d ON d.proposal_id=p.id AND d.digest=p.digest AND d.membership_id=p.membership_id WHERE p.id=$1 AND p.expires_at>clock_timestamp() AND d.decision='approve'`,
        [manifest.id],
      )
    ).rowCount
  )
    throw new TableProposalError('proposal-not-approved');
  const control = (
    await tx.client.query(
      `SELECT operation FROM ${table(tx, 'tf_table_proposal_controls')} WHERE proposal_id=$1 ORDER BY sequence DESC LIMIT 1`,
      [manifest.id],
    )
  ).rows[0]?.operation;
  if (control === 'cancel') throw new TableProposalError('proposal-cancelled');
  await access.requireSources(
    tx,
    manifest.requester,
    await effectiveProposalSources(tx, manifest, [...manifest.sources, ...plan.importSources]),
    manifest.conversationId,
  );
  await planAuthority(tx, manifest.requester, plan.input, plan.before, []);
  if (plan.input.kind === 'schema') await requireFixedTableTitle(tx, plan.after, plan.before);
  if (plan.input.kind === 'import') {
    if (!access.requireImportReference) throw new AccessDenied();
    await access.requireImportReference(tx, manifest.requester, manifest.conversationId, plan.input.reference);
    if (canonicalJson(await destinationAudience(tx, plan.input.tableId)) !== canonicalJson(plan.audience))
      throw new TableProposalError('proposal-stale');
    const input = plan.input,
      ids = [...input.matchFieldIds].sort();
    if (
      new Set(ids).size !== ids.length ||
      !plan.after.uniqueKeys.some(key => canonicalJson([...key.fieldIds].sort()) === canonicalJson(ids)) ||
      ids.some(id => !input.mappings.some(mapping => mapping.fieldId === id))
    )
      throw new TableProposalError('invalid-import');
    for (const kind of ['create', 'update'] as const) {
      if (
        (
          await tx.client.query(
            `SELECT 1 FROM ${table(tx, 'tf_table_proposal_effects')} WHERE proposal_id=$1 AND table_id=$2 AND effect->>'kind'=$3 LIMIT 1`,
            [manifest.id, plan.input.tableId, kind],
          )
        ).rowCount
      )
        await requireTablePermission(tx, manifest.requester, plan.input.tableId, `table.row.${kind}`);
    }
  }
  if (plan.input.kind === 'schema' && plan.effectCount) {
    await requireTablePermission(tx, manifest.requester, plan.input.tableId, 'table.row.update');
    if (plan.before?.fields.some(field => !plan.after.fields.some(next => next.id === field.id)))
      await requireTablePermission(tx, manifest.requester, plan.input.tableId, 'table.row.delete');
  }
  for (const dependency of plan.input.dependsOn)
    if (
      !(
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'tf_table_proposal_receipts')} WHERE proposal_id=$1 AND table_id=$2 AND receipt->>'status'='completed'`,
          [manifest.id, dependency],
        )
      ).rowCount
    )
      throw new TableProposalError('dependency-unfinished');
}

async function selected(tx: TableTransaction, manifest: ProposalManifest) {
  for (const plan of manifest.plans) {
    if (
      !(
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'tf_table_proposal_receipts')} WHERE proposal_id=$1 AND table_id=$2 AND receipt->>'status'='completed'`,
          [manifest.id, plan.input.tableId],
        )
      ).rowCount
    )
      return plan;
  }
  return null;
}

async function execution(tx: TableTransaction, manifest: ProposalManifest, plan: ReviewedPlan) {
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_table_executions')}(proposal_id,table_id,id,publication_id) VALUES($1,$2,$3,$4) ON CONFLICT(proposal_id,table_id) DO NOTHING`,
    [manifest.id, plan.input.tableId, randomUUID(), randomUUID()],
  );
  return executionSchema.parse(
    (
      await tx.client.query(
        `SELECT * FROM ${table(tx, 'tf_table_executions')} WHERE proposal_id=$1 AND table_id=$2 FOR NO KEY UPDATE`,
        [manifest.id, plan.input.tableId],
      )
    ).rows[0],
  );
}

export function createTablePublication(
  options: ExecutionAccess & { runtime: TableRuntime; prepareRevision: PrepareTableDefinition },
) {
  const transaction = <T>(workspaceId: string, action: (tx: TableTransaction) => Promise<T>) =>
    options.runtime.transaction(workspaceId, executionCompatibility, action);
  return async (workspaceId: string, proposalId: string) => {
    const pending = await transaction(workspaceId, async tx => {
      const manifest = await load(tx, proposalId),
        plan = await selected(tx, manifest);
      if (!plan) return null;
      await admit(tx, manifest, plan, options);
      const job = await execution(tx, manifest, plan);
      if (job.revision || plan.input.kind !== 'schema') return null;
      const tableNames = await reserveDefinitionNames(tx, plan.after);
      const head = z
        .string()
        .parse(
          (await tx.client.query(`SELECT revision FROM ${table(tx, 'tf_soul_head')} WHERE id=1 FOR UPDATE`)).rows[0]
            ?.revision,
        );
      if (job.parent_revision !== head) {
        job.publication_id = randomUUID();
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_table_executions')} SET parent_revision=$2,publication_id=$3 WHERE id=$1`,
          [job.id, head, job.publication_id],
        );
      }
      const parent = z
        .object({ key: z.string(), sha256: z.string() })
        .nullable()
        .parse(
          (
            await tx.client.query(
              `SELECT bundle_key AS key,bundle_sha256 AS sha256 FROM ${table(tx, 'tf_soul_revisions')} WHERE revision=$1`,
              [head],
            )
          ).rows[0] ?? null,
        );
      return { job, head, parent, definition: plan.after, tableNames };
    });
    if (!pending) return 'ready' as const;
    const prepared = await options.prepareRevision({
      workspaceId,
      commandId: pending.job.publication_id,
      expectedParentCommit: pending.head,
      createdAt: pending.job.created_at.toISOString(),
      parent: pending.parent,
      definition: pending.definition,
      ...(pending.tableNames ? { tableNames: pending.tableNames } : {}),
    });
    return transaction(workspaceId, async tx => {
      const manifest = await load(tx, proposalId),
        plan = await selected(tx, manifest);
      if (!plan) return 'ready' as const;
      await admit(tx, manifest, plan, options);
      const job = await execution(tx, manifest, plan);
      if (job.revision) return 'ready' as const;
      if (job.id !== pending.job.id) return 'retry' as const;
      const head = (await tx.client.query(`SELECT revision FROM ${table(tx, 'tf_soul_head')} WHERE id=1 FOR UPDATE`))
        .rows[0]?.revision;
      if (head !== pending.head || job.publication_id !== pending.job.publication_id) return 'retry' as const;
      if (prepared.parentCommit !== head || !/^[a-f0-9]{40}$/.test(prepared.commit))
        throw new TableProposalError('proposal-conflict');
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_soul_revisions')}(revision,parent_revision,table_execution_id,bundle_key,bundle_sha256) VALUES($1,$2,$3,$4,$5)`,
        [prepared.commit, head, job.publication_id, prepared.bundle.key, prepared.bundle.sha256],
      );
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_soul_head')} SET revision=$1,updated_at=clock_timestamp() WHERE id=1`,
        [prepared.commit],
      );
      await tx.client.query(`UPDATE ${table(tx, 'tf_table_executions')} SET revision=$2,projection=$3 WHERE id=$1`, [
        job.id,
        prepared.commit,
        prepared.projection,
      ]);
      if (pending.tableNames)
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_table_soul_files')}(table_id,projection,revision) VALUES($1,$2,$3)
        ON CONFLICT(table_id) DO UPDATE SET projection=EXCLUDED.projection,revision=EXCLUDED.revision`,
          [job.table_id, prepared.projection, prepared.commit],
        );
      await tx.client.query(`UPDATE ${table(tx, 'tf_table_catalog')} SET target_revision=$2 WHERE id=$1`, [
        job.table_id,
        prepared.commit,
      ]);
      return 'ready' as const;
    });
  };
}

async function complete(tx: TableTransaction, job: Execution, revision: string) {
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_table_proposal_receipts')}(proposal_id,table_id,attempt,receipt) SELECT $1,$2,COALESCE(max(attempt)+1,0),$3 FROM ${table(tx, 'tf_table_proposal_receipts')} WHERE proposal_id=$1 AND table_id=$2`,
    [job.proposal_id, job.table_id, { status: 'completed', executionId: job.id, revision }],
  );
  await tx.client.query(`UPDATE ${table(tx, 'tf_table_executions')} SET phase='completed' WHERE id=$1`, [job.id]);
}

async function expectedEffect(tx: TableTransaction, job: Execution, id: string) {
  return effectSchema
    .nullable()
    .parse(
      (
        await tx.client.query(
          `SELECT effect FROM ${table(tx, 'tf_table_proposal_effects')} WHERE proposal_id=$1 AND table_id=$2 AND effect->>'recordId'=$3`,
          [job.proposal_id, job.table_id, id],
        )
      ).rows[0]?.effect ?? null,
    );
}

async function checkValues(
  tx: TableTransaction,
  manifest: ProposalManifest,
  access: ExecutionAccess,
  tableId: string,
  recordId: string,
  before: TableValues | null,
  values: TableValues | null,
) {
  const endpoints = store.endpoints(tableId, recordId, before, values);
  await store.lockCatalogs(
    tx,
    endpoints.map(endpoint => endpoint.tableId),
  );
  for (const id of new Set(endpoints.map(endpoint => endpoint.tableId)))
    if (id !== tableId) await requireTablePermission(tx, manifest.requester, id, 'table.row.read');
  await store.lockIdentities(tx, endpoints);
  for (const endpoint of store.endpoints(tableId, recordId, values).slice(1)) {
    if (endpoint.tableId === tableId && endpoint.recordId === recordId) continue;
    if (!(await store.identity(tx, endpoint.tableId, endpoint.recordId))?.live)
      throw new store.GenerationError('linked-record');
  }
  const files = addedFileIds(before, values);
  await requireFileBatches(tx, manifest.requester, files, access.requireFiles);
  return files;
}

async function copyRecord(
  tx: TableTransaction,
  job: Execution,
  plan: ReviewedPlan,
  source: store.Generation,
  target: store.Generation,
  id: string,
  manifest: ProposalManifest,
  access: ExecutionAccess,
) {
  if (plan.input.kind !== 'schema') throw new TableProposalError('proposal-conflict');
  const row = await store.readRecord(tx, source, id);
  const expected = await expectedEffect(tx, job, id);
  const effect = row ? transformedEffect(plan.input, row) : null;
  if (canonicalJson(effect) !== canonicalJson(expected)) throw new TableProposalError('proposal-stale');
  const approved = proposalFreshnessSchema
    .nullable()
    .parse(
      (
        await tx.client.query(
          `SELECT snapshot FROM ${table(tx, 'tf_table_proposal_freshness')} WHERE proposal_id=$1 AND table_id=$2 AND row_id=$3`,
          [job.proposal_id, job.table_id, id],
        )
      ).rows[0]?.snapshot ?? null,
    );
  const records = await store.generationProposalData.records(tx, source.table_id, null, [id]);
  const fresh = proposalFreshness(plan.input, plan.before, effect ? [effect] : [], records)[0] ?? null;
  if (canonicalJson(fresh) !== canonicalJson(approved)) throw new TableProposalError('proposal-stale');
  const current = await store.identity(tx, source.table_id, id);
  if (!current) throw new store.GenerationError('stale-record');
  const result = row
    ? evaluateTransforms({ transforms: plan.input.transforms, values: row.values, target: target.definition })
    : null;
  if (result && !result.ok) throw new TableProposalError('invalid-transform');
  if (Buffer.byteLength(canonicalJson(row)) + Buffer.byteLength(canonicalJson(result)) > 1048576)
    throw new TableProposalError('proposal-too-large');
  const values = result?.ok ? result.values : null;
  const files = await checkValues(tx, manifest, access, source.table_id, id, row?.values ?? null, values);
  await tx.client.query(`DELETE FROM ${table(tx, 'tf_table_execution_files')} WHERE execution_id=$1 AND row_id=$2`, [
    job.id,
    id,
  ]);
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_table_execution_files')}(execution_id,row_id,file_id,authority_epoch) SELECT $1,$2,unnest($3::uuid[]),lock_version FROM ${table(tx, 'tf_authorization_lock')} WHERE id=1`,
    [job.id, id, files],
  );
  await store.writeGenerationRecord(tx, {
    generationId: target.id,
    recordId: id,
    token: row?.token ?? current.token,
    values: result?.ok ? result.values : null,
  });
  const versions = { ...records[0]?.fieldVersions };
  const changed = [...new Set([...Object.keys(row?.values ?? {}), ...Object.keys(values ?? {})])]
    .map(field => fieldIdSchema.parse(field))
    .filter(field => canonicalJson(row?.values[field] ?? null) !== canonicalJson(values?.[field] ?? null));
  const written = new Set([
    ...plan.input.transforms.outputs.map(output => output.fieldId),
    ...changed,
    ...(plan.before?.fields
      .filter(field => !plan.after.fields.some(next => next.id === field.id))
      .map(field => field.id) ?? []),
  ]);
  for (const field of written) versions[field] = target.id;
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_table_generation_versions')}(generation_id,row_id,base_token,field_versions) VALUES($1,$2,$3,$4) ON CONFLICT(generation_id,row_id) DO UPDATE SET base_token=EXCLUDED.base_token,field_versions=EXCLUDED.field_versions`,
    [target.id, id, row?.token ?? current.token, versions],
  );
  if (row && values)
    await store.stageTransformHistory(tx, {
      generation: target,
      recordId: id,
      token: row.token,
      before: row.values,
      values,
      actor: manifest.requester,
    });
  else
    await tx.client.query(
      `DELETE FROM ${table(tx, 'tf_table_row_history_data')} WHERE generation_id=$1 AND row_id=$2 AND operation='transform'`,
      [target.id, id],
    );
  const prior = (
    await tx.client.query(
      `SELECT has_effect,has_freshness FROM ${table(tx, 'tf_table_execution_checks')} WHERE execution_id=$1 AND row_id=$2`,
      [job.id, id],
    )
  ).rows[0];
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_table_execution_checks')}(execution_id,row_id,has_effect,has_freshness) VALUES($1,$2,$3,$4) ON CONFLICT(execution_id,row_id) DO UPDATE SET has_effect=EXCLUDED.has_effect,has_freshness=EXCLUDED.has_freshness`,
    [job.id, id, effect !== null, fresh !== null],
  );
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_table_executions')} SET checked_effects=checked_effects+$2,checked_freshness=checked_freshness+$3 WHERE id=$1`,
    [
      job.id,
      Number(effect !== null) - Number(prior?.has_effect === true),
      Number(fresh !== null) - Number(prior?.has_freshness === true),
    ],
  );
}

async function switchGeneration(
  tx: TableTransaction,
  job: Execution,
  target: store.Generation,
  source: store.Generation | null,
) {
  await store.requireUniqueGeneration(tx, target);
  await store.activateReverseFields(tx, target);
  if (source) {
    await tx.client.query(
      `UPDATE ${table(tx, 'tf_table_generations')} SET state='retired',retired_at=clock_timestamp() WHERE id=$1`,
      [source.id],
    );
    await tx.client.query(
      `REVOKE ALL ON ${table(tx, source.physical_table)} FROM ${escapeIdentifier(`${tx.schema}_runtime`)}`,
    );
  }
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_table_generations')} SET state='active',activated_at=clock_timestamp() WHERE id=$1`,
    [target.id],
  );
  await tx.client.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ${table(tx, target.physical_table)} TO ${escapeIdentifier(`${tx.schema}_runtime`)}`,
  );
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_table_catalog')} SET physical_table=$2,display_name=$3,target_revision=$4,applied_revision=$4,applied_definition=$5 WHERE id=$1`,
    [job.table_id, target.physical_table, target.definition.label, target.revision, target.definition],
  );
  await recordTableRecommendationChange(tx, job.table_id, 'definition', job.source_generation !== null);
  await complete(tx, job, target.revision);
}

export function createTableExecution(
  options: ExecutionAccess & {
    resolveMigrationCredential(workspaceId: string): Promise<string>;
    batchRows?: number;
    cutoverRows?: number;
  },
) {
  const batchRows = z
    .int()
    .min(1)
    .max(1000)
    .parse(options.batchRows ?? 100);
  const cutoverRows = z
    .int()
    .min(0)
    .max(100)
    .parse(options.cutoverRows ?? 16);
  return async (workspaceId: string, proposalId: string): Promise<'more' | 'publish' | 'completed' | 'blocked'> => {
    let recovery: { xid: string; job: Execution } | undefined;
    try {
      return await withMaintenanceTransaction({
        workspaceId,
        connectionString: await options.resolveMigrationCredential(workspaceId),
        capability: 'migration',
        operation: async transaction => {
          const tx = { ...transaction, workspaceId, commonVersion: executionCompatibility.minimum };
          await tx.client.query(
            "SET LOCAL lock_timeout='250ms'; SET LOCAL transaction_timeout='2s'; SET LOCAL statement_timeout='1500ms'",
          );
          const clock = z
            .object({ xid: z.string(), elapsed: z.coerce.number() })
            .parse(
              (
                await tx.client.query(
                  'SELECT pg_current_xact_id()::text xid,extract(epoch FROM clock_timestamp()-transaction_timestamp())*1000 elapsed',
                )
              ).rows[0],
            );
          const deadline = performance.now() + 2000 - clock.elapsed;
          let slowestWorkMs = 25;
          const hasBudget = () => performance.now() + 300 + Math.max(100, slowestWorkMs * 2) < deadline;
          const work = async (action: () => Promise<void>) => {
            const start = performance.now();
            await tx.client.query("SELECT set_config('statement_timeout',$1,true)", [
              `${Math.max(1, Math.floor(deadline - start - 300))}ms`,
            ]);
            await action();
            slowestWorkMs = Math.max(slowestWorkMs, performance.now() - start);
          };
          const manifest = await load(tx, proposalId),
            plan = await selected(tx, manifest);
          if (!plan) return 'completed';
          const previous = executionSchema
            .optional()
            .parse(
              (
                await tx.client.query(
                  `SELECT * FROM ${table(tx, 'tf_table_executions')} WHERE proposal_id=$1 AND table_id=$2`,
                  [proposalId, plan.input.tableId],
                )
              ).rows[0],
            );
          if (previous) recovery = { xid: clock.xid, job: previous };
          await admit(tx, manifest, plan, options);
          const job = await execution(tx, manifest, plan);
          const limit = Math.min(batchRows, job.batch_limit);
          if (job.phase === 'blocked') {
            const control = z
              .object({ sequence: z.int(), operation: z.string() })
              .optional()
              .parse(
                (
                  await tx.client.query(
                    `SELECT sequence,operation FROM ${table(tx, 'tf_table_proposal_controls')} WHERE proposal_id=$1 ORDER BY sequence DESC LIMIT 1`,
                    [proposalId],
                  )
                ).rows[0],
              );
            if (!control || control.operation !== 'resume' || control.sequence <= job.resumed_sequence)
              return 'blocked';
            if (job.target_generation) {
              const target = store.generationSchema.parse(
                (
                  await tx.client.query(`SELECT * FROM ${table(tx, 'tf_table_generations')} WHERE id=$1`, [
                    job.target_generation,
                  ])
                ).rows[0],
              );
              await tx.client.query(`TRUNCATE ${table(tx, target.physical_table)}`);
              for (const name of [
                'tf_table_generation_links',
                'tf_table_unique_values',
                'tf_table_generation_conflicts',
                'tf_table_generation_versions',
                'tf_table_row_history_data',
              ]) {
                const deleted = await tx.client.query(
                  `DELETE FROM ${table(tx, name)} WHERE ctid IN (SELECT ctid FROM ${table(tx, name)} WHERE generation_id=$1 LIMIT $2)`,
                  [target.id, batchRows],
                );
                if (deleted.rowCount) return 'more';
              }
            }
            if (
              (
                await tx.client.query(
                  `DELETE FROM ${table(tx, 'tf_table_execution_checks')} WHERE ctid IN (SELECT ctid FROM ${table(tx, 'tf_table_execution_checks')} WHERE execution_id=$1 LIMIT $2)`,
                  [job.id, batchRows],
                )
              ).rowCount
            )
              return 'more';
            if (
              (
                await tx.client.query(
                  `DELETE FROM ${table(tx, 'tf_table_execution_files')} WHERE ctid IN (SELECT ctid FROM ${table(tx, 'tf_table_execution_files')} WHERE execution_id=$1 LIMIT $2)`,
                  [job.id, batchRows],
                )
              ).rowCount
            )
              return 'more';
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_table_executions')} SET phase='publishing',checkpoint=NULL,checked_effects=0,checked_freshness=0,target_generation=NULL,error_code=NULL,timeout_failures=0,resumed_sequence=$2 WHERE id=$1`,
              [job.id, control.sequence],
            );
            return 'more';
          }
          if (job.phase === 'publishing') {
            const effects = z
              .array(z.object({ effect: effectSchema }))
              .parse(
                (
                  await tx.client.query(
                    `SELECT effect FROM ${table(tx, 'tf_table_proposal_effects')} WHERE proposal_id=$1 AND table_id=$2 ORDER BY ordinal`,
                    [proposalId, job.table_id],
                  )
                ).rows,
              )
              .map(row => row.effect);
            if (effects.length !== plan.effectCount || tableProposalDigest(effects) !== plan.effectsDigest)
              throw new TableProposalError('proposal-conflict');
            const freshness = z
              .array(z.object({ snapshot: proposalFreshnessSchema }))
              .parse(
                (
                  await tx.client.query(
                    `SELECT snapshot FROM ${table(tx, 'tf_table_proposal_freshness')} WHERE proposal_id=$1 AND table_id=$2 ORDER BY row_id`,
                    [proposalId, job.table_id],
                  )
                ).rows,
              )
              .map(row => row.snapshot);
            if (tableProposalDigest(freshness) !== plan.freshnessDigest) throw new TableProposalError('proposal-stale');
            await tx.client.query(`UPDATE ${table(tx, 'tf_table_executions')} SET expected_freshness=$2 WHERE id=$1`, [
              job.id,
              freshness.length,
            ]);
          }
          if (plan.input.kind === 'archive' || plan.input.kind === 'restore') {
            await store.lockCatalogs(tx, [job.table_id], true);
            const source = store.generationSchema
              .optional()
              .parse(
                (
                  await tx.client.query(
                    `SELECT * FROM ${table(tx, 'tf_table_generations')} WHERE table_id=$1 AND state='active'`,
                    [job.table_id],
                  )
                ).rows[0],
              );
            if (!source || source.revision !== plan.input.expectedRevision)
              throw new TableProposalError('proposal-stale');
            const archived = Boolean(
              (
                await tx.client.query(
                  `SELECT archived_at IS NOT NULL AS archived FROM ${table(tx, 'tf_table_catalog')} WHERE id=$1 FOR UPDATE`,
                  [job.table_id],
                )
              ).rows[0]?.archived,
            );
            if ((plan.input.kind === 'archive' && archived) || (plan.input.kind === 'restore' && !archived))
              throw new TableProposalError('proposal-stale');
            if (plan.input.kind === 'archive') {
              const blocker = await archiveBlockers(tx, job.table_id);
              if (blocker) throw new TableProposalError(blocker);
            }
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_table_catalog')} SET archived_at=${plan.input.kind === 'archive' ? 'clock_timestamp()' : 'NULL'} WHERE id=$1`,
              [job.table_id],
            );
            await recordTableRecommendationChange(tx, job.table_id, 'definition', plan.input.kind === 'archive');
            await complete(tx, job, source.revision);
            return 'more';
          }
          if (plan.input.kind === 'schema' && !job.revision) return 'publish';
          const cutoverLimit = Math.min(cutoverRows, limit);
          const backlog =
            job.phase === 'reconciling'
              ? (
                  await tx.client.query(
                    `SELECT row_id FROM ${table(tx, 'tf_table_execution_dirty')} WHERE execution_id=$1 LIMIT $2`,
                    [job.id, cutoverLimit + 1],
                  )
                ).rows.length
              : 0;
          const activating = job.phase === 'reconciling' && backlog <= cutoverLimit;
          await store.lockCatalogs(
            tx,
            [
              job.table_id,
              ...[...plan.after.fields, ...(plan.before?.fields ?? [])].flatMap(field =>
                field.kind === 'relationship' ? [field.targetTableId] : [],
              ),
            ],
            plan.input.kind !== 'schema' || job.phase === 'publishing' || activating,
          );
          if (plan.input.kind === 'import') await requireProposalCaptureCurrent(tx, proposalId, job.table_id);
          const source = store.generationSchema
            .nullable()
            .parse(
              (
                await tx.client.query(
                  `SELECT * FROM ${table(tx, 'tf_table_generations')} WHERE table_id=$1 AND state='active'`,
                  [job.table_id],
                )
              ).rows[0] ?? null,
            );
          if ((source?.revision ?? null) !== plan.input.expectedRevision)
            throw new TableProposalError('proposal-stale');
          if (plan.input.kind === 'records' || plan.input.kind === 'import') {
            if (!source) throw new TableProposalError('proposal-stale');
            const page =
              plan.input.kind === 'import'
                ? z
                    .array(z.object({ ordinal: z.int(), effect: effectSchema }))
                    .parse(
                      (
                        await tx.client.query(
                          `SELECT ordinal,effect FROM ${table(tx, 'tf_table_proposal_effects')} WHERE proposal_id=$1 AND table_id=$2 AND ordinal>$3 ORDER BY ordinal LIMIT $4`,
                          [proposalId, job.table_id, job.effect_checkpoint, limit],
                        )
                      ).rows,
                    )
                : [];
            const rows = await store.generationProposalData.records(
              tx,
              source.table_id,
              null,
              plan.input.kind === 'records'
                ? plan.input.changes.map(change => change.recordId)
                : page.map(row => row.effect.recordId),
            );
            const effects: TableEffect[] =
              plan.input.kind === 'records'
                ? recordEffects(plan.input, source.definition, rows)
                : page.map(row => row.effect);
            if (plan.input.kind === 'records') {
              if (tableProposalDigest(effects) !== plan.effectsDigest) throw new TableProposalError('proposal-stale');
              if (
                tableProposalDigest(proposalFreshness(plan.input, plan.before, effects, rows)) !== plan.freshnessDigest
              )
                throw new TableProposalError('proposal-stale');
            }
            await planAuthority(tx, manifest.requester, plan.input, plan.before, effects);
            let applied = 0;
            for (const effect of effects) {
              if (plan.input.kind === 'import' && !hasBudget()) break;
              await work(async () => {
                if (plan.input.kind === 'import') {
                  const row = rows.find(row => row.id === effect.recordId);
                  const matched = await store.matchUniqueRecord(
                    tx,
                    source,
                    plan.input.matchFieldIds,
                    effect.after ?? {},
                  );
                  if (matched !== (effect.kind === 'create' ? null : effect.recordId))
                    throw new TableProposalError('proposal-stale');
                  const after =
                    effect.after === null
                      ? null
                      : validateRecord(source.definition, { ...row?.values, ...effect.after });
                  if (
                    canonicalJson(
                      changedEffect(effect.recordId, row?.values ?? null, after, plan.input.matchFieldIds),
                    ) !== canonicalJson(effect)
                  )
                    throw new TableProposalError('proposal-stale');
                  const approved = proposalFreshnessSchema.parse(
                    (
                      await tx.client.query(
                        `SELECT snapshot FROM ${table(tx, 'tf_table_proposal_freshness')} WHERE proposal_id=$1 AND table_id=$2 AND row_id=$3`,
                        [proposalId, job.table_id, effect.recordId],
                      )
                    ).rows[0]?.snapshot,
                  );
                  if (
                    canonicalJson(proposalFreshness(plan.input, plan.before, [effect], row ? [row] : [])[0]) !==
                    canonicalJson(approved)
                  )
                    throw new TableProposalError('proposal-stale');
                }
                const before = rows.find(row => row.id === effect.recordId)?.values ?? null;
                if (effect.kind === 'create' && (await store.identity(tx, job.table_id, effect.recordId)))
                  throw new TableProposalError('proposal-stale');
                const values =
                  effect.after === null ? null : validateRecord(source.definition, { ...before, ...effect.after });
                await store.lockUniqueValues(tx, source, [before, values]);
                await checkValues(tx, manifest, options, job.table_id, effect.recordId, before, values);
                const change =
                  plan.input.kind === 'records'
                    ? plan.input.changes.find(change => change.recordId === effect.recordId)
                    : null;
                const result = await store.persistMutation(tx, {
                  generation: source,
                  recordId: effect.recordId,
                  before,
                  values,
                  actor: manifest.requester,
                  operation: effect.kind,
                  imported: plan.input.kind === 'import',
                  ...(change?.kind === 'update'
                    ? { writtenFieldIds: Object.keys(change.values) }
                    : plan.input.kind === 'import'
                      ? { writtenFieldIds: plan.input.mappings.map(mapping => mapping.fieldId) }
                      : {}),
                });
                if (plan.input.kind === 'import')
                  await tx.client.query(
                    `INSERT INTO ${table(tx, 'tf_table_import_receipts')}(execution_id,ordinal,row_id,token) VALUES($1,$2,$3,$4)`,
                    [
                      job.id,
                      page.find(item => item.effect.recordId === effect.recordId)?.ordinal,
                      effect.recordId,
                      result.token,
                    ],
                  );
              });
              applied++;
            }
            if (plan.input.kind === 'import' && effects.length && !applied) throw new ExecutionBudgetExceeded();
            await admit(tx, manifest, plan, options);
            if (plan.input.kind === 'import') {
              await tx.client.query(
                `UPDATE ${table(tx, 'tf_table_executions')} SET phase='copying',effect_checkpoint=COALESCE($2,effect_checkpoint),timeout_failures=CASE WHEN $3>0 THEN 0 ELSE timeout_failures END WHERE id=$1`,
                [job.id, page[applied - 1]?.ordinal ?? null, applied],
              );
              if (applied < page.length || page.length === limit) return 'more';
            }
            await complete(tx, job, source.revision);
            if (plan.input.kind === 'import') await recordTableRecommendationChange(tx, job.table_id, 'rows');
            return 'more';
          }
          if (!job.revision) return 'publish';
          if (!job.target_generation) {
            const target = await store.createGeneration(tx, { definition: plan.after, revision: job.revision });
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_table_executions')} SET target_generation=$2,source_generation=$3,phase=$4 WHERE id=$1`,
              [job.id, target.id, source?.id ?? null, source ? 'copying' : 'reconciling'],
            );
            return 'more';
          }
          const target = store.generationSchema.parse(
            (
              await tx.client.query(`SELECT * FROM ${table(tx, 'tf_table_generations')} WHERE id=$1`, [
                job.target_generation,
              ])
            ).rows[0],
          );
          if ((source?.id ?? null) !== job.source_generation) throw new TableProposalError('proposal-stale');
          if (job.phase === 'copying' && source) {
            const rows = await store.readRecords(tx, source, { after: job.checkpoint, limit });
            let copied = 0;
            for (const row of rows) {
              if (!hasBudget()) break;
              await work(() => copyRecord(tx, job, plan, source, target, row.id, manifest, options));
              copied++;
            }
            if (rows.length && !copied) throw new ExecutionBudgetExceeded();
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_table_executions')} SET checkpoint=COALESCE($2,checkpoint),phase=$3,timeout_failures=CASE WHEN $4>0 THEN 0 ELSE timeout_failures END WHERE id=$1`,
              [
                job.id,
                rows[copied - 1]?.id ?? null,
                copied === rows.length && rows.length < limit ? 'reconciling' : 'copying',
                copied,
              ],
            );
            return 'more';
          }
          const dirty = z
            .array(z.object({ row_id: z.uuid(), version: z.string() }))
            .parse(
              (
                await tx.client.query(
                  `SELECT row_id,version::text FROM ${table(tx, 'tf_table_execution_dirty')} WHERE execution_id=$1 ORDER BY row_id LIMIT $2`,
                  [job.id, activating ? cutoverLimit + 1 : limit],
                )
              ).rows,
            );
          if (activating && dirty.length > cutoverLimit) return 'more';
          let reconciled = 0;
          for (const item of dirty) {
            if (!hasBudget()) {
              if (!reconciled) throw new ExecutionBudgetExceeded();
              return 'more';
            }
            if (!source) throw new TableProposalError('proposal-stale');
            const currentSource = source;
            await work(() => copyRecord(tx, job, plan, currentSource, target, item.row_id, manifest, options));
            await tx.client.query(
              `DELETE FROM ${table(tx, 'tf_table_execution_dirty')} WHERE execution_id=$1 AND row_id=$2 AND version=$3`,
              [job.id, item.row_id, item.version],
            );
            if (job.timeout_failures)
              await tx.client.query(`UPDATE ${table(tx, 'tf_table_executions')} SET timeout_failures=0 WHERE id=$1`, [
                job.id,
              ]);
            reconciled++;
          }
          if (!activating) return 'more';
          if (!hasBudget()) {
            if (!reconciled) throw new ExecutionBudgetExceeded();
            return 'more';
          }
          const checked = z
            .int()
            .parse(
              (
                await tx.client.query(`SELECT checked_effects FROM ${table(tx, 'tf_table_executions')} WHERE id=$1`, [
                  job.id,
                ])
              ).rows[0]?.checked_effects,
            );
          if (checked !== plan.effectCount) throw new TableProposalError('proposal-stale');
          if (
            !(
              await tx.client.query(
                `SELECT 1 FROM ${table(tx, 'tf_table_executions')} WHERE id=$1 AND checked_freshness=expected_freshness`,
                [job.id],
              )
            ).rowCount
          )
            throw new TableProposalError('proposal-stale');
          await admit(tx, manifest, plan, options);
          const files = z
            .array(z.object({ row_id: z.uuid(), file_id: z.uuid() }))
            .parse(
              (
                await tx.client.query(
                  `SELECT row_id,file_id FROM ${table(tx, 'tf_table_execution_files')} WHERE execution_id=$1 AND authority_epoch<(SELECT lock_version FROM ${table(tx, 'tf_authorization_lock')} WHERE id=1) ORDER BY authority_epoch LIMIT $2`,
                  [job.id, Math.min(fileCheckBatch, job.batch_limit)],
                )
              ).rows,
            );
          if (files.length) {
            await requireFileBatches(
              tx,
              manifest.requester,
              files.map(file => file.file_id),
              options.requireFiles,
            );
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_table_execution_files')} f SET authority_epoch=a.lock_version FROM ${table(tx, 'tf_authorization_lock')} a,jsonb_to_recordset($2::jsonb) AS checked(row_id uuid,file_id uuid) WHERE a.id=1 AND f.execution_id=$1 AND f.row_id=checked.row_id AND f.file_id=checked.file_id`,
              [job.id, JSON.stringify(files)],
            );
            if (job.timeout_failures)
              await tx.client.query(`UPDATE ${table(tx, 'tf_table_executions')} SET timeout_failures=0 WHERE id=$1`, [
                job.id,
              ]);
            return 'more';
          }
          await switchGeneration(tx, job, target, source);
          return 'more';
        },
      });
    } catch (cause) {
      const error =
        cause instanceof Error &&
        'code' in cause &&
        cause.code === 'P0001' &&
        cause.message === 'proposal-stale' &&
        'where' in cause &&
        typeof cause.where === 'string' &&
        cause.where.includes('.tf_table_import_completion_current()')
          ? new TableProposalError('proposal-stale')
          : cause;
      const timeout =
        error instanceof ExecutionBudgetExceeded ||
        (typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          ['25P03', '25P04', '57014'].includes(String(error.code)));
      if (timeout && recovery) {
        const failed = recovery;
        return withMaintenanceTransaction({
          workspaceId,
          connectionString: await options.resolveMigrationCredential(workspaceId),
          capability: 'migration',
          operation: async transaction => {
            const tx = { ...transaction, workspaceId, commonVersion: executionCompatibility.minimum };
            await tx.client.query("SET LOCAL lock_timeout='250ms'; SET LOCAL transaction_timeout='2s'");
            await load(tx, proposalId);
            const status = (await tx.client.query('SELECT pg_xact_status($1::xid8) status', [failed.xid])).rows[0]
              ?.status;
            const current = executionSchema.parse(
              (
                await tx.client.query(`SELECT * FROM ${table(tx, 'tf_table_executions')} WHERE id=$1 FOR UPDATE`, [
                  failed.job.id,
                ])
              ).rows[0],
            );
            // A new integration holds the same execution fence. An aborted xid proves
            // all record writes rolled back; the checkpoint proves no successor ran.
            if (status !== 'aborted' || canonicalJson(current) !== canonicalJson(failed.job)) throw error;
            if (current.phase === 'blocked') return 'blocked';
            const failures = current.timeout_failures + 1;
            const blocked = failures >= 8;
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_table_executions')} SET batch_limit=$2,timeout_failures=$3,phase=CASE WHEN $4 THEN 'blocked' ELSE phase END,error_code=CASE WHEN $4 THEN 'execution-timeout' ELSE error_code END,resumed_sequence=CASE WHEN $4 THEN COALESCE((SELECT max(sequence) FROM ${table(tx, 'tf_table_proposal_controls')} WHERE proposal_id=$5),-1) ELSE resumed_sequence END WHERE id=$1`,
              [
                current.id,
                Math.max(1, Math.floor(Math.min(batchRows, current.batch_limit) / 2)),
                failures,
                blocked,
                proposalId,
              ],
            );
            if (blocked)
              await tx.client.query(
                `INSERT INTO ${table(tx, 'tf_table_proposal_receipts')}(proposal_id,table_id,attempt,receipt) SELECT $1,$2,COALESCE(max(attempt)+1,0),$3 FROM ${table(tx, 'tf_table_proposal_receipts')} WHERE proposal_id=$1 AND table_id=$2`,
                [
                  proposalId,
                  current.table_id,
                  { status: 'failed', executionId: current.id, code: 'execution-timeout' },
                ],
              );
            return blocked ? 'blocked' : 'more';
          },
        });
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505' &&
        'constraint' in error &&
        error.constraint === 'tf_table_execution_live'
      )
        return 'more';
      if (error instanceof store.GenerationError && error.code === 'stale-record') return 'more';
      const constraintFailure =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        ['23505', '23503', '23514', '23502'].includes(String(error.code));
      const storageFault =
        typeof error === 'object' && error !== null && 'code' in error && /^42[0-9A-Z]{3}$/.test(String(error.code));
      if (
        error instanceof AccessDenied ||
        error instanceof TableProposalError ||
        error instanceof store.GenerationError ||
        error instanceof WorkspaceMemberError ||
        constraintFailure ||
        storageFault
      ) {
        if (
          error instanceof TableProposalError &&
          ['proposal-redacted', 'proposal-not-approved', 'dependency-unfinished'].includes(error.code)
        )
          return 'blocked';
        await withMaintenanceTransaction({
          workspaceId,
          connectionString: await options.resolveMigrationCredential(workspaceId),
          capability: 'migration',
          operation: async transaction => {
            const tx = { ...transaction, workspaceId, commonVersion: executionCompatibility.minimum };
            const manifest = await load(tx, proposalId),
              plan = await selected(tx, manifest);
            if (!plan) return;
            let existing = (
              await tx.client.query(
                `SELECT * FROM ${table(tx, 'tf_table_executions')} WHERE proposal_id=$1 AND table_id=$2 FOR UPDATE`,
                [proposalId, plan.input.tableId],
              )
            ).rows[0];
            if (existing?.phase === 'blocked') return;
            if (!existing)
              existing = (
                await tx.client.query(
                  `INSERT INTO ${table(tx, 'tf_table_executions')}(proposal_id,table_id,id,publication_id,phase) VALUES($1,$2,$3,$4,'blocked') RETURNING *`,
                  [proposalId, plan.input.tableId, randomUUID(), randomUUID()],
                )
              ).rows[0];
            const job = executionSchema.parse(existing);
            const code =
              error instanceof AccessDenied
                ? 'access-denied'
                : error instanceof TableProposalError ||
                    error instanceof store.GenerationError ||
                    error instanceof WorkspaceMemberError
                  ? error.code
                  : storageFault
                    ? 'storage-fault'
                    : 'invalid-transform';
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_table_executions')} SET phase='blocked',error_code=$2,resumed_sequence=COALESCE((SELECT max(sequence) FROM ${table(tx, 'tf_table_proposal_controls')} WHERE proposal_id=$3),-1) WHERE id=$1`,
              [job.id, code, proposalId],
            );
            await tx.client.query(
              `INSERT INTO ${table(tx, 'tf_table_proposal_receipts')}(proposal_id,table_id,attempt,receipt) SELECT $1,$2,COALESCE(max(attempt)+1,0),$3 FROM ${table(tx, 'tf_table_proposal_receipts')} WHERE proposal_id=$1 AND table_id=$2`,
              [proposalId, job.table_id, { status: 'failed', executionId: job.id, code }],
            );
          },
        });
        return 'blocked';
      }
      throw error;
    }
  };
}
