import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  humanActorSchema,
  lockAuthorization,
  requireTablePermission,
  resolveHuman,
  sourceDependenciesSchema,
  type HumanActor,
  type SourceDependency,
} from '@tulipfarm/access';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { canonicalJson } from './canonical.ts';
import { requireFixedTableTitle } from './identities.ts';
import { valueSchema, type TableDefinition } from './definition.ts';
import { effectiveProposalSources } from './proposal-sources.ts';
import { requireNoMcpDerived } from '@tulipfarm/access';
import { blockedTableProposalSchema, redactedManifestSchema } from './proposal-contracts.ts';
import { table, type TableRuntime, type TableTransaction } from './service-store.ts';
import {
  addedFileIds,
  archiveBlockers,
  destinationAudience,
  importEffects,
  planAuthority,
  proposalFreshness,
  recordEffects,
  requireProposalCaptureCurrent,
  transformedEffect,
  type ImportMatch,
  type ProposalData,
  type ProposalRecord,
  type ReadableFiles,
} from './proposal-data.ts';
import {
  digestSchema,
  effectSchema,
  executionReceiptSchema,
  importSnapshotSchema,
  proposalControlSchema,
  proposalDecisionSchema,
  proposalManifestSchema,
  proposalPageSchema,
  proposeTableSchema,
  reviewedPlanSchema,
  TableProposalError,
  TableProposalValidationError,
  type InvalidProposalRecord,
  type ProposalManifest,
  type ProposalPlan,
  type TableEffect,
} from './proposal-contracts.ts';

export type { ProposalData } from './proposal-data.ts';
import { generationProposalData, requireMemberMutation, workspaceMembersTable } from './store.ts';
import { WorkspaceMemberError } from './workspace-members.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
export const tableProposalDigest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const range = commonCompatibility;
type Origin = { conversationId: string; turnId: string; sources: readonly SourceDependency[] };
type InstallationOrigin = {
  conversationId: null;
  turnId: null;
  installationId: string;
  sources: readonly SourceDependency[];
};
export type TableProposalOptions = {
  runtime: TableRuntime;
  requireSources(tx: TableTransaction, actor: HumanActor, sources: readonly SourceDependency[]): Promise<void>;
  data?: ProposalData;
  /** Without it, every file reference reads as unavailable and any added reference is denied. */
  readableFiles?: ReadableFiles;
  imports?: {
    readSnapshot(
      tx: TableTransaction,
      actor: HumanActor,
      origin: Origin,
      reference: Extract<ProposalPlan, { kind: 'import' }>['reference'],
    ): Promise<z.infer<typeof importSnapshotSchema>>;
  };
};
const storedMetadata = z.object({ digest: digestSchema, input_digest: digestSchema, expired: z.boolean() });
const storedSchema = z.union([
  storedMetadata.extend({ manifest: proposalManifestSchema, redacted_at: z.null(), redacted_digest: z.null() }),
  storedMetadata.extend({ manifest: redactedManifestSchema, redacted_at: z.date(), redacted_digest: digestSchema }),
]);
function runnable(row: z.infer<typeof storedSchema>) {
  if (row.redacted_at !== null) throw new TableProposalError('proposal-redacted');
  return row;
}
const receiptRowSchema = z.object({ table_id: z.uuid(), attempt: z.int(), receipt: executionReceiptSchema });

function references(...roots: unknown[]) {
  const pending = [...roots];
  const files = new Set<string>();
  const tables = new Set<string>();
  while (pending.length) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null) continue;
    if (
      'kind' in value &&
      ((value.kind === 'file' && 'fileIds' in value) || (value.kind === 'relationship' && 'recordIds' in value))
    ) {
      const parsed = valueSchema.parse(value);
      if (parsed?.kind === 'file') for (const id of parsed.fileIds) files.add(id);
      if (parsed?.kind === 'relationship') tables.add(parsed.tableId);
    } else pending.push(...Object.values(value));
  }
  return { files, tables };
}

function operations(options: TableProposalOptions) {
  const data = options.data ?? generationProposalData;
  async function transaction<T>(
    workspaceId: string,
    principal: string | HumanActor,
    operation: (tx: TableTransaction, actor: HumanActor) => Promise<T>,
  ) {
    return options.runtime.transaction(z.uuid().parse(workspaceId), range, async tx => {
      await lockAuthorization(tx);
      const actor =
        typeof principal === 'string' ? await resolveHuman(tx, principal) : humanActorSchema.parse(principal);
      await currentMember(tx, actor);
      return operation(tx, actor);
    });
  }
  async function owned(tx: TableTransaction, actor: HumanActor, conversationId: string) {
    if (
      !(
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'tf_conversations')} WHERE id=$1 AND kind='private' AND owner_user_id=$2 AND owner_membership_id=$3`,
          [z.uuid().parse(conversationId), actor.userId, actor.membershipId],
        )
      ).rowCount
    )
      throw new AccessDenied();
  }
  async function lock(tx: TableTransaction, id: string) {
    await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 761031))', [
      `${tx.schema}:${z.uuid().parse(id)}`,
    ]);
  }
  async function load(tx: TableTransaction, actor: HumanActor, conversationId: string | null, id: string) {
    if (conversationId !== null) await owned(tx, actor, conversationId);
    await lock(tx, id);
    const row = storedSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT *,expires_at<=clock_timestamp() AS expired FROM ${table(tx, 'tf_table_proposals')} WHERE id=$1 AND conversation_id IS NOT DISTINCT FROM $2::uuid AND membership_id=$3 AND user_id=$4`,
            [id, conversationId, actor.membershipId, actor.userId],
          )
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    if (tableProposalDigest(row.manifest) !== (row.redacted_digest ?? row.digest))
      throw new TableProposalError('proposal-conflict');
    if (
      row.redacted_at !== null &&
      (row.manifest.originalDigest !== row.digest ||
        row.manifest.originalInputDigest !== row.input_digest ||
        row.manifest.redactedAt !== row.redacted_at.toISOString())
    )
      throw new TableProposalError('proposal-conflict');
    return row;
  }
  async function effects(tx: TableTransaction, id: string, tableId: string) {
    return z
      .array(z.object({ effect: effectSchema }))
      .parse(
        (
          await tx.client.query(
            `SELECT effect FROM ${table(tx, 'tf_table_proposal_effects')} WHERE proposal_id=$1 AND table_id=$2 ORDER BY ordinal`,
            [id, tableId],
          )
        ).rows,
      )
      .map(row => row.effect);
  }
  async function appliedImportIds(tx: TableTransaction, id: string, tableId: string) {
    return new Set(
      z
        .array(z.object({ row_id: z.uuid() }))
        .parse(
          (
            await tx.client.query(
              `SELECT r.row_id
      FROM ${table(tx, 'tf_table_import_receipts')} r JOIN ${table(tx, 'tf_table_executions')} e ON e.id=r.execution_id
      WHERE e.proposal_id=$1 AND e.table_id=$2`,
              [id, tableId],
            )
          ).rows,
        )
        .map(row => row.row_id),
    );
  }
  async function requireMemberEffects(
    tx: TableTransaction,
    definition: TableDefinition,
    changes: readonly TableEffect[],
    observed?: readonly ProposalRecord[],
  ) {
    if (!changes.length) return;
    const registration = await workspaceMembersTable(tx);
    if (
      !registration ||
      (definition.id !== registration.coreDefinition.id &&
        !definition.fields.some(
          field => field.kind === 'relationship' && field.targetTableId === registration.coreDefinition.id,
        ))
    )
      return;
    const observedRows = observed ? new Map(observed.map(row => [row.id, row.values])) : null;
    for (let offset = 0; offset < changes.length; offset += 1000) {
      const page = changes.slice(offset, offset + 1000);
      const rows =
        observedRows ??
        new Map(
          (
            await data.records(
              tx,
              definition.id,
              null,
              page.map(effect => effect.recordId),
            )
          ).map(row => [row.id, row.values]),
        );
      for (const effect of page) {
        const before = rows.get(effect.recordId) ?? null;
        const merged = { ...before, ...effect.after };
        const values =
          effect.after === null
            ? null
            : Object.fromEntries(definition.fields.map(field => [field.id, merged[field.id] ?? null]));
        await requireMemberMutation(tx, { tableId: definition.id, recordId: effect.recordId, before, values });
      }
    }
  }
  async function receipts(tx: TableTransaction, id: string) {
    return z
      .array(receiptRowSchema)
      .parse(
        (
          await tx.client.query(
            `SELECT DISTINCT ON(table_id) table_id,attempt,receipt FROM ${table(tx, 'tf_table_proposal_receipts')} WHERE proposal_id=$1 ORDER BY table_id,attempt DESC`,
            [id],
          )
        ).rows,
      );
  }
  // Import executions commit checkpointed batches; each committed effect has one import receipt.
  async function importsApplied(tx: TableTransaction, id: string) {
    const rows = z
      .array(z.object({ table_id: z.uuid(), applied: z.int() }))
      .parse(
        (
          await tx.client.query(
            `SELECT e.table_id,count(*)::int AS applied FROM ${table(tx, 'tf_table_import_receipts')} r JOIN ${table(tx, 'tf_table_executions')} e ON e.id=r.execution_id WHERE e.proposal_id=$1 GROUP BY e.table_id`,
            [id],
          )
        ).rows,
      );
    return new Map(rows.map(row => [row.table_id, row.applied]));
  }
  async function state(tx: TableTransaction, row: z.infer<typeof storedSchema>) {
    const id = row.manifest.id;
    const decision = z
      .enum(['approve', 'reject'])
      .nullable()
      .parse(
        (
          await tx.client.query(
            `SELECT decision FROM ${table(tx, 'tf_table_proposal_decisions')} WHERE proposal_id=$1`,
            [id],
          )
        ).rows[0]?.decision ?? null,
      );
    const control = z
      .enum(['cancel', 'resume'])
      .nullable()
      .parse(
        (
          await tx.client.query(
            `SELECT operation FROM ${table(tx, 'tf_table_proposal_controls')} WHERE proposal_id=$1 ORDER BY sequence DESC LIMIT 1`,
            [id],
          )
        ).rows[0]?.operation ?? null,
      );
    const saved = await receipts(tx, id);
    const imported = await importsApplied(tx, id);
    const completed = saved.filter(item => item.receipt.status === 'completed').length;
    const status =
      completed === row.manifest.plans.length
        ? 'completed'
        : decision === 'reject'
          ? 'rejected'
          : control === 'cancel'
            ? 'cancelled'
            : row.expired
              ? 'expired'
              : completed
                ? 'partial'
                : saved.some(item => item.receipt.status === 'failed')
                  ? 'failed'
                  : decision !== 'approve'
                    ? 'pending'
                    : (
                          await tx.client.query(
                            `SELECT 1 FROM ${table(tx, 'tf_table_executions')} WHERE proposal_id=$1`,
                            [id],
                          )
                        ).rowCount
                      ? 'running'
                      : 'approved';
    return {
      id,
      digest: row.digest,
      status,
      decision,
      cancelled: control === 'cancel',
      expired: row.expired,
      plans: row.manifest.plans.map(plan => {
        const applied = imported.get(plan.input.tableId) ?? 0;
        return {
          tableId: plan.input.tableId,
          receipt: saved.find(item => item.table_id === plan.input.tableId)?.receipt ?? null,
          importProgress: plan.input.kind === 'import' ? { applied, remaining: plan.effectCount - applied } : null,
        };
      }),
    };
  }
  async function requireValueAccess(
    tx: TableTransaction,
    actor: HumanActor,
    input: ProposalPlan,
    changes: readonly TableEffect[],
  ) {
    for (const id of references(input, ...changes).tables)
      await requireTablePermission(tx, actor, id, 'table.row.read');
  }
  async function readable(tx: TableTransaction, actor: HumanActor, ids: readonly string[]) {
    return ids.length && options.readableFiles ? options.readableFiles(tx, actor, ids) : new Set<string>();
  }
  // Kept and removed references stay unchecked, as on the human table API. Transform literals are new writes.
  async function requireAddedFiles(
    tx: TableTransaction,
    actor: HumanActor,
    input: ProposalPlan,
    changes: readonly TableEffect[],
  ) {
    const ids = [
      ...new Set([
        ...(input.kind === 'schema' ? references(input.transforms).files : []),
        ...changes.flatMap(effect => addedFileIds(effect.before, effect.after)),
      ]),
    ].sort();
    const open = await readable(tx, actor, ids);
    if (ids.some(id => !open.has(id))) throw new AccessDenied();
  }
  async function unavailableFiles(tx: TableTransaction, actor: HumanActor, groups: readonly unknown[]) {
    const referenced = groups.map(group => [...references(group).files].sort());
    const open = await readable(tx, actor, [...new Set(referenced.flat())]);
    return referenced.map(ids => ids.filter(id => !open.has(id)));
  }
  async function requireImportReference(
    tx: TableTransaction,
    actor: HumanActor,
    conversationId: string,
    plan: Extract<ProposalPlan, { kind: 'import' }>,
  ) {
    const reference = plan.reference;
    if (reference.kind === 'file') {
      if (
        !(
          await tx.client.query(
            `SELECT 1 FROM ${table(tx, 'tf_conversation_attachments')} WHERE id=$1 AND conversation_id=$2 AND membership_id=$3 AND sha256=$4 AND state='bound'`,
            [reference.attachmentId, conversationId, actor.membershipId, reference.contentDigest],
          )
        ).rowCount
      )
        throw new AccessDenied();
    } else if (
      !(
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'tf_conversation_tool_calls')} WHERE id=$1 AND conversation_id=$2 AND status='completed' AND tool IN ('github.issue.read','google.read','atlassian.read')`,
          [reference.resultId, conversationId],
        )
      ).rowCount
    )
      throw new AccessDenied();
  }
  async function preview(
    tx: TableTransaction,
    actor: HumanActor,
    origin: { conversationId: string | null; turnId: string | null; sources: readonly SourceDependency[] },
    plan: ProposalPlan,
    proposalId: string,
  ) {
    const source = await data.definition(tx, plan.tableId);
    if ((source?.revision ?? null) !== plan.expectedRevision) throw new TableProposalError('proposal-stale');
    const before = source?.definition ?? null;
    const archived = Boolean(
      (
        await tx.client.query(
          `SELECT archived_at IS NOT NULL AS archived FROM ${table(tx, 'tf_table_catalog')} WHERE id=$1`,
          [plan.tableId],
        )
      ).rows[0]?.archived,
    );
    if (
      (plan.kind === 'archive' && archived) ||
      (plan.kind === 'restore' && !archived) ||
      (archived && plan.kind !== 'restore')
    )
      throw new TableProposalError('proposal-stale');
    if (plan.kind === 'archive') {
      const blocker = await archiveBlockers(tx, plan.tableId);
      if (blocker) throw new TableProposalError(blocker);
    }
    await planAuthority(tx, actor, plan, before, []);
    if (plan.kind === 'schema') await requireFixedTableTitle(tx, plan.target, before);
    const after = plan.kind === 'schema' ? plan.target : before;
    if (!after) throw new TableProposalError('proposal-stale');
    await requireValueAccess(tx, actor, plan, []);
    const changes: TableEffect[] = [];
    const observed: ProposalRecord[] = [];
    const matches: ImportMatch[] = [];
    let importSources: SourceDependency[] = [];
    if (plan.kind === 'schema' && source) {
      let cursor: string | null = null;
      let count = 0;
      let invalidTotal = 0;
      const invalidRecords: InvalidProposalRecord[] = [];
      for (;;) {
        const page = await data.records(tx, plan.tableId, cursor);
        observed.push(...page);
        count += page.length;
        if (count > 100000) throw new TableProposalError('proposal-too-large');
        for (const record of page) {
          try {
            const effect = transformedEffect(plan, record);
            if (effect) changes.push(effect);
          } catch (error) {
            if (!(error instanceof TableProposalValidationError)) throw error;
            invalidTotal++;
            if (invalidRecords.length < 100) invalidRecords.push(...error.validation.records);
          }
        }
        const last = page.at(-1);
        if (!last) break;
        cursor = last.id;
      }
      if (invalidTotal)
        throw new TableProposalValidationError(plan.tableId, source.revision, invalidRecords, invalidTotal);
    } else if (plan.kind === 'records') {
      const rows = await data.records(
        tx,
        plan.tableId,
        null,
        plan.changes.map(change => change.recordId),
      );
      observed.push(...rows);
      changes.push(...recordEffects(plan, after, rows));
    } else if (plan.kind === 'import') {
      if (!options.imports) throw new TableProposalError('import-adapter-required');
      if (
        !after.uniqueKeys.some(
          key => canonicalJson([...key.fieldIds].sort()) === canonicalJson([...plan.matchFieldIds].sort()),
        )
      )
        throw new TableProposalError('invalid-import');
      const reference = plan.reference;
      if (origin.conversationId === null || origin.turnId === null) throw new AccessDenied();
      await requireImportReference(tx, actor, origin.conversationId, plan);
      const snapshot = importSnapshotSchema.parse(
        await options.imports.readSnapshot(
          tx,
          actor,
          { ...origin, conversationId: origin.conversationId, turnId: origin.turnId },
          reference,
        ),
      );
      if (
        snapshot.contentDigest !== reference.contentDigest ||
        (reference.kind === 'integration' && !snapshot.sources.length)
      )
        throw new TableProposalError('invalid-import');
      importSources = snapshot.sources;
      await options.requireSources(tx, actor, importSources);
      const records = [];
      let cursor: string | null = null;
      for (;;) {
        const page = await data.records(tx, plan.tableId, cursor);
        records.push(...page);
        if (records.length > 100000) throw new TableProposalError('proposal-too-large');
        const last = page.at(-1);
        if (!last) break;
        cursor = last.id;
      }
      changes.push(
        ...importEffects(
          plan,
          after,
          records,
          snapshot.rows,
          index => {
            const hash = tableProposalDigest([proposalId, plan.tableId, index]);
            return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
          },
          matches,
        ),
      );
      observed.push(...records);
    }
    changes.sort((a, b) => a.recordId.localeCompare(b.recordId));
    for (const effect of changes)
      for (const value of Object.values(effect.after ?? {})) {
        if (value?.kind === 'relationship') {
          await requireTablePermission(tx, actor, value.tableId, 'table.row.read');
          const linked = await data.records(tx, value.tableId, null, value.recordIds);
          if (linked.length !== value.recordIds.length) throw new TableProposalError('proposal-stale');
        }
      }
    await requireValueAccess(tx, actor, plan, changes);
    await planAuthority(tx, actor, plan, before, changes);
    await requireMemberEffects(tx, after, changes, observed);
    const freshness = proposalFreshness(plan, before, changes, observed, matches);
    const reviewed = reviewedPlanSchema.parse({
      input: plan,
      before,
      after,
      effectCount: changes.length,
      effectsDigest: tableProposalDigest(changes),
      freshnessDigest: tableProposalDigest(freshness),
      ...(plan.kind === 'import' ? { importMatchesDigest: tableProposalDigest(matches) } : {}),
      audience: plan.kind === 'import' ? await destinationAudience(tx, plan.tableId) : null,
      importSources,
    });
    return { reviewed, changes, freshness, matches };
  }
  async function current(tx: TableTransaction, actor: HumanActor, manifest: ProposalManifest) {
    await requireNoMcpDerived(tx, [...manifest.sources, ...manifest.plans.flatMap(plan => plan.importSources)]);
    await options.requireSources(tx, actor, await effectiveProposalSources(tx, manifest, manifest.sources));
    const saved = await receipts(tx, manifest.id);
    for (const plan of manifest.plans) {
      if (saved.some(item => item.table_id === plan.input.tableId && item.receipt.status === 'completed')) continue;
      const captured = Boolean(
        (
          await tx.client.query(
            `SELECT 1 FROM ${table(tx, 'tf_table_proposal_capture')} WHERE proposal_id=$1 AND table_id=$2`,
            [manifest.id, plan.input.tableId],
          )
        ).rowCount,
      );
      if (
        !captured &&
        (
          await tx.client.query(
            `SELECT 1 FROM ${table(tx, 'tf_table_generations')} WHERE table_id=$1 AND state='active'`,
            [plan.input.tableId],
          )
        ).rowCount
      )
        throw new TableProposalError('proposal-stale');
      if (captured) {
        const definition = await data.definition(tx, plan.input.tableId);
        if (
          (definition?.revision ?? null) !== plan.input.expectedRevision ||
          canonicalJson(definition?.definition ?? null) !== canonicalJson(plan.before)
        )
          throw new TableProposalError('proposal-stale');
        if (plan.input.kind === 'schema') await requireFixedTableTitle(tx, plan.after, plan.before);
        await options.requireSources(tx, actor, await effectiveProposalSources(tx, manifest, plan.importSources));
        if (plan.input.kind === 'import') {
          if (manifest.conversationId === null) throw new AccessDenied();
          await requireImportReference(tx, actor, manifest.conversationId, plan.input);
          if (canonicalJson(await destinationAudience(tx, plan.input.tableId)) !== canonicalJson(plan.audience))
            throw new TableProposalError('proposal-stale');
        }
        await requireProposalCaptureCurrent(tx, manifest.id, plan.input.tableId);
        const stored = await effects(tx, manifest.id, plan.input.tableId);
        const applied =
          plan.input.kind === 'import'
            ? await appliedImportIds(tx, manifest.id, plan.input.tableId)
            : new Set<string>();
        await requireMemberEffects(
          tx,
          plan.after,
          stored.filter(effect => !applied.has(effect.recordId)),
        );
        if (plan.input.kind === 'archive') {
          const blocker = await archiveBlockers(tx, plan.input.tableId);
          if (blocker) throw new TableProposalError(blocker);
        }
        continue;
      }
      const latest = await preview(tx, actor, manifest, plan.input, manifest.id).catch(error => {
        if (error instanceof TableProposalValidationError) throw new TableProposalError('proposal-stale');
        throw error;
      });
      if (plan.input.kind === 'import') {
        const applied = await appliedImportIds(tx, manifest.id, plan.input.tableId);
        if (applied.size) {
          const stored = await effects(tx, manifest.id, plan.input.tableId);
          const fresh = z
            .array(z.object({ snapshot: z.unknown() }))
            .parse(
              (
                await tx.client.query(
                  `SELECT snapshot FROM ${table(tx, 'tf_table_proposal_freshness')} WHERE proposal_id=$1 AND table_id=$2 AND NOT(row_id=ANY($3::uuid[])) ORDER BY row_id`,
                  [manifest.id, plan.input.tableId, [...applied]],
                )
              ).rows,
            )
            .map(row => row.snapshot);
          const remaining = stored.filter(effect => !applied.has(effect.recordId));
          const expected = {
            ...plan,
            effectCount: remaining.length,
            effectsDigest: tableProposalDigest(remaining),
            freshnessDigest: tableProposalDigest(fresh),
          };
          const changes = latest.changes.filter(effect => !applied.has(effect.recordId));
          const reviewed = {
            ...latest.reviewed,
            effectCount: changes.length,
            effectsDigest: tableProposalDigest(changes),
            freshnessDigest: tableProposalDigest(latest.freshness.filter(row => !applied.has(row.id))),
          };
          if (canonicalJson(expected) !== canonicalJson(reviewed)) throw new TableProposalError('proposal-stale');
          continue;
        }
      }
      if (canonicalJson(latest.reviewed) !== canonicalJson(plan)) throw new TableProposalError('proposal-stale');
      const stored = await effects(tx, manifest.id, plan.input.tableId);
      if (tableProposalDigest(stored) !== plan.effectsDigest) throw new TableProposalError('proposal-conflict');
    }
  }
  const visible = async (
    tx: TableTransaction,
    actor: HumanActor,
    manifest: ProposalManifest,
    files: 'require-added' | 'unchecked',
  ) => {
    await options.requireSources(tx, actor, await effectiveProposalSources(tx, manifest, manifest.sources));
    for (const plan of manifest.plans) {
      await options.requireSources(tx, actor, await effectiveProposalSources(tx, manifest, plan.importSources));
      const stored = await effects(tx, manifest.id, plan.input.tableId);
      if (tableProposalDigest(stored) !== plan.effectsDigest) throw new TableProposalError('proposal-conflict');
      if (
        plan.importMatchesDigest &&
        (
          await tx.client.query(
            `SELECT 1 FROM ${table(tx, 'tf_table_proposal_capture')} WHERE proposal_id=$1 AND table_id=$2`,
            [manifest.id, plan.input.tableId],
          )
        ).rowCount
      ) {
        const matches = (
          await tx.client.query(
            `SELECT source_index AS "sourceIndex",row_id AS "recordId",matched,key_id AS "keyId",key_value AS "keyValue",mapped FROM ${table(tx, 'tf_table_proposal_matches')} WHERE proposal_id=$1 AND table_id=$2 ORDER BY source_index`,
            [manifest.id, plan.input.tableId],
          )
        ).rows;
        if (tableProposalDigest(matches) !== plan.importMatchesDigest)
          throw new TableProposalError('proposal-conflict');
      }
      await planAuthority(tx, actor, plan.input, plan.before, stored);
      await requireValueAccess(tx, actor, plan.input, stored);
      if (files === 'require-added') await requireAddedFiles(tx, actor, plan.input, stored);
    }
  };
  async function propose(
    workspaceId: string,
    actor: HumanActor,
    id: string,
    origin: Origin | InstallationOrigin,
    value: unknown,
  ) {
    const input = proposeTableSchema.parse(value);
    const sources = sourceDependenciesSchema.parse(origin.sources);
    const outcome = await transaction(workspaceId, actor, async (tx, requester) => {
      await requireNoMcpDerived(
        tx,
        origin.conversationId === null
          ? sources
          : [{ kind: 'private-conversation', conversationId: origin.conversationId }, ...sources],
      );
      await lock(tx, id);
      if (origin.conversationId === null) {
        if (input.plans.some(plan => !['schema', 'records'].includes(plan.kind))) throw new AccessDenied();
        if (
          !(
            await tx.client.query(
              `SELECT 1 FROM ${table(tx, 'tf_system_package_installations')} WHERE id=$1 AND membership_id=$2 AND user_id=$3`,
              [origin.installationId, requester.membershipId, requester.userId],
            )
          ).rowCount
        )
          throw new AccessDenied();
      } else {
        await owned(tx, requester, origin.conversationId);
        if (
          !(
            await tx.client.query(
              `SELECT 1 FROM ${table(tx, 'tf_conversation_turns')} t JOIN ${table(tx, 'tf_conversation_messages')} m ON m.id=t.source_message_id WHERE t.id=$1 AND t.conversation_id=$2 AND m.author_kind='human' AND m.membership_id=$3 AND t.status NOT IN ('cancelled','blocked')`,
              [z.uuid().parse(origin.turnId), origin.conversationId, requester.membershipId],
            )
          ).rowCount
        )
          throw new AccessDenied();
      }
      const inputDigest = tableProposalDigest({
        input,
        sources,
        conversationId: origin.conversationId,
        turnId: origin.turnId,
        ...('installationId' in origin ? { installationId: origin.installationId } : {}),
        requester,
      });
      const blocked =
        origin.conversationId === null ? null : await blockedReport(tx, requester, origin.conversationId, id);
      if (blocked) {
        if (blocked.input_digest !== inputDigest) throw new TableProposalError('proposal-conflict');
        return blocked.report;
      }
      if ((await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_table_blocked_reports')} WHERE id=$1`, [id])).rowCount)
        throw new AccessDenied();
      const existing = (await tx.client.query(`SELECT id FROM ${table(tx, 'tf_table_proposals')} WHERE id=$1`, [id]))
        .rowCount;
      if (existing) {
        const row = runnable(await load(tx, requester, origin.conversationId, id));
        if (row.input_digest !== inputDigest) throw new TableProposalError('proposal-conflict');
        await visible(tx, requester, row.manifest, 'require-added');
        return { id, digest: row.digest, expiresAt: row.manifest.expiresAt, status: (await state(tx, row)).status };
      }
      await options.requireSources(tx, requester, sources);
      const capture = await data.lock(tx, input.plans.map(plan => plan.tableId).sort(), 'scan');
      if (
        capture !== 'capture' &&
        (
          await tx.client.query(
            `SELECT 1 FROM ${table(tx, 'tf_table_generations')} WHERE table_id=ANY($1::uuid[]) AND state='active'`,
            [input.plans.map(plan => plan.tableId)],
          )
        ).rowCount
      )
        throw new TableProposalError('proposal-storage-unavailable');
      const snapshot =
        capture === 'capture'
          ? z
              .string()
              .parse((await tx.client.query('SELECT pg_current_snapshot()::text AS snapshot')).rows[0]?.snapshot)
          : null;
      const previews = [];
      for (const plan of input.plans) {
        try {
          const item = await preview(tx, requester, { ...origin, sources }, plan, id);
          await requireAddedFiles(tx, requester, plan, item.changes);
          previews.push(item);
        } catch (error) {
          if (!(error instanceof TableProposalValidationError)) throw error;
          if (origin.conversationId === null) throw error;
          const report = blockedTableProposalSchema.parse(error.validation);
          const dependencies = sourceDependenciesSchema.parse([
            ...sources,
            ...previews.flatMap(item => item.reviewed.importSources),
            { kind: 'table-rows', tableId: report.tableId, revision: report.revision },
          ]);
          await options.requireSources(tx, requester, dependencies);
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_table_blocked_reports')}(id,conversation_id,turn_id,membership_id,user_id,input_digest,report,sources) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              id,
              origin.conversationId,
              origin.turnId,
              requester.membershipId,
              requester.userId,
              inputDigest,
              report,
              JSON.stringify(dependencies),
            ],
          );
          return report;
        }
      }
      const expiresAt = z
        .date()
        .parse((await tx.client.query("SELECT clock_timestamp()+interval '24 hours' AS expiry")).rows[0]?.expiry)
        .toISOString();
      const manifest = proposalManifestSchema.parse({
        version: 1,
        id,
        workspaceId,
        requester,
        conversationId: origin.conversationId,
        turnId: origin.turnId,
        ...('installationId' in origin ? { installationId: origin.installationId } : {}),
        sources,
        expiresAt,
        plans: previews.map(item => item.reviewed),
      });
      const digest = tableProposalDigest(manifest);
      const storesFreshness = Boolean(
        (await tx.client.query('SELECT to_regclass($1) AS relation', [table(tx, 'tf_table_proposal_freshness')]))
          .rows[0]?.relation,
      );
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_table_proposals')}(id,conversation_id,turn_id,membership_id,user_id,input_digest,digest,manifest,expires_at${'installationId' in origin ? ',installation_id' : ''}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9${'installationId' in origin ? ',$10' : ''})`,
        [
          id,
          origin.conversationId,
          origin.turnId,
          requester.membershipId,
          requester.userId,
          inputDigest,
          digest,
          manifest,
          expiresAt,
          ...('installationId' in origin ? [origin.installationId] : []),
        ],
      );
      for (const item of previews) {
        if (snapshot) {
          const scanFields =
            item.reviewed.input.kind === 'schema'
              ? [...new Set(item.freshness.flatMap(row => Object.keys(row.fields)))]
              : [];
          if (item.reviewed.input.kind === 'schema') {
            const input = item.reviewed.input;
            scanFields.push(
              ...input.transforms.outputs.map(output => output.fieldId),
              ...(item.reviewed.before?.fields ?? [])
                .filter(field => !input.target.fields.some(target => target.id === field.id))
                .map(field => field.id),
            );
          }
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_table_proposal_capture')}(proposal_id,table_id,snapshot,scan_fields) VALUES($1,$2,$3,$4)`,
            [id, item.reviewed.input.tableId, snapshot, [...new Set(scanFields)]],
          );
          for (let offset = 0; offset < item.matches.length; offset += 500) {
            await tx.client.query(
              `INSERT INTO ${table(tx, 'tf_table_proposal_matches')}(proposal_id,table_id,source_index,row_id,matched,key_id,key_value,mapped) SELECT $1,$2,(m->>'sourceIndex')::integer,(m->>'recordId')::uuid,(m->>'matched')::boolean,(m->>'keyId')::uuid,m->'keyValue',m->'mapped' FROM jsonb_array_elements($3::jsonb) m`,
              [id, item.reviewed.input.tableId, JSON.stringify(item.matches.slice(offset, offset + 500))],
            );
          }
        }
        for (let offset = 0; storesFreshness && offset < item.freshness.length; offset += 500) {
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_table_proposal_freshness')}(proposal_id,table_id,row_id,snapshot) SELECT $1,$2,(snapshot->>'id')::uuid,snapshot FROM jsonb_array_elements($3::jsonb) AS e(snapshot)`,
            [id, item.reviewed.input.tableId, JSON.stringify(item.freshness.slice(offset, offset + 500))],
          );
        }
        for (let offset = 0; offset < item.changes.length; offset += 500) {
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_table_proposal_effects')}(proposal_id,table_id,ordinal,effect) SELECT $1,$2,$3+ordinality-1,effect FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS e(effect,ordinality)`,
            [id, item.reviewed.input.tableId, offset, JSON.stringify(item.changes.slice(offset, offset + 500))],
          );
        }
      }
      if (snapshot) {
        await data.lock(tx, input.plans.map(plan => plan.tableId).sort(), 'finalize');
        await current(tx, requester, manifest);
      }
      return { id, digest, expiresAt, status: 'pending' };
    });
    if ('records' in outcome)
      throw new TableProposalValidationError(outcome.tableId, outcome.revision, outcome.records, outcome.total);
    return outcome;
  }
  async function blockedReport(tx: TableTransaction, actor: HumanActor, conversationId: string, id: string) {
    await owned(tx, actor, conversationId);
    const row = z
      .object({ input_digest: digestSchema, report: blockedTableProposalSchema, sources: sourceDependenciesSchema })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT input_digest,report,sources FROM ${table(tx, 'tf_table_blocked_reports')} WHERE id=$1 AND conversation_id=$2 AND membership_id=$3 AND user_id=$4`,
            [z.uuid().parse(id), conversationId, actor.membershipId, actor.userId],
          )
        ).rows[0],
      );
    if (row) {
      await requireTablePermission(tx, actor, row.report.tableId, 'table.row.read');
      await options.requireSources(tx, actor, row.sources);
    }
    return row;
  }
  return {
    propose,
    outcome: async (workspaceId: string, userId: string, chatId: string, id: string) =>
      transaction(workspaceId, userId, async (tx, actor) => {
        await lock(tx, id);
        const blocked = await blockedReport(tx, actor, chatId, id);
        if (blocked) return { kind: 'blocked' as const, report: blocked.report };
        const row = await load(tx, actor, chatId, id);
        if (row.redacted_at === null) await visible(tx, actor, row.manifest, 'unchecked');
        return { kind: 'proposal' as const };
      }),
    list: (workspaceId: string, userId: string, chatId: string, after?: string) =>
      transaction(workspaceId, userId, async (tx, actor) => {
        await owned(tx, actor, chatId);
        const rows = z
          .array(z.object({ id: z.uuid() }))
          .parse(
            (
              await tx.client.query(
                `SELECT id FROM ${table(tx, 'tf_table_proposals')} WHERE conversation_id=$1 AND membership_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 26`,
                [chatId, actor.membershipId, after ? z.uuid().parse(after) : null],
              )
            ).rows,
          );
        const items = [];
        for (const row of rows.slice(0, 25)) items.push(await state(tx, await load(tx, actor, chatId, row.id)));
        return { items, nextCursor: rows.length > 25 ? (items.at(-1)?.id ?? null) : null };
      }),
    read: (workspaceId: string, userId: string, chatId: string, id: string) =>
      transaction(workspaceId, userId, async (tx, actor) => {
        const row = await load(tx, actor, chatId, id);
        if (row.redacted_at !== null)
          return {
            content: 'redacted' as const,
            manifest: row.manifest,
            ...(await state(tx, row)),
            freshness: 'expired' as const,
          };
        await visible(tx, actor, row.manifest, 'unchecked');
        let freshness: 'current' | 'stale' = 'current';
        try {
          await current(tx, actor, row.manifest);
        } catch (error) {
          if (
            !(
              error instanceof TableProposalError && ['proposal-stale', 'table-title-immutable'].includes(error.code)
            ) &&
            !(error instanceof WorkspaceMemberError && error.status === 409)
          )
            throw error;
          freshness = 'stale';
        }
        const [unavailableFileIds = []] = await unavailableFiles(tx, actor, [row.manifest]);
        return {
          content: 'available' as const,
          manifest: row.manifest,
          ...(await state(tx, row)),
          freshness,
          ...(unavailableFileIds.length ? { unavailableFileIds } : {}),
        };
      }),
    status: (workspaceId: string, userId: string, chatId: string, id: string) =>
      transaction(workspaceId, userId, async (tx, actor) => state(tx, await load(tx, actor, chatId, id))),
    effects: (workspaceId: string, userId: string, chatId: string, id: string, tableId: string, query: unknown) =>
      transaction(workspaceId, userId, async (tx, actor) => {
        const row = runnable(await load(tx, actor, chatId, id));
        await visible(tx, actor, row.manifest, 'unchecked');
        const plan = row.manifest.plans.find(item => item.input.tableId === z.uuid().parse(tableId));
        if (!plan) throw new AccessDenied();
        const page = proposalPageSchema.parse(query);
        const rows = z
          .array(z.object({ ordinal: z.int(), effect: effectSchema }))
          .parse(
            (
              await tx.client.query(
                `SELECT ordinal,effect FROM ${table(tx, 'tf_table_proposal_effects')} WHERE proposal_id=$1 AND table_id=$2 AND ordinal>$3 ORDER BY ordinal LIMIT $4`,
                [id, tableId, page.after, page.limit + 1],
              )
            ).rows,
          );
        const items = rows.slice(0, page.limit);
        const unavailable = await unavailableFiles(
          tx,
          actor,
          items.map(item => item.effect),
        );
        return {
          digest: row.digest,
          total: plan.effectCount,
          items: items.map((item, index) =>
            unavailable[index]?.length ? { ...item, unavailableFileIds: unavailable[index] } : item,
          ),
          nextCursor: rows.length > page.limit ? (items.at(-1)?.ordinal ?? null) : null,
        };
      }),
    async human(
      workspaceId: string,
      userId: string,
      chatId: string | null,
      id: string,
      value: unknown,
      kind: 'decision' | 'control',
      persist: (
        tx: TableTransaction,
        manifest: ProposalManifest,
        input: z.infer<typeof proposalDecisionSchema> | z.infer<typeof proposalControlSchema>,
      ) => Promise<void>,
    ) {
      const input = kind === 'decision' ? proposalDecisionSchema.parse(value) : proposalControlSchema.parse(value);
      return transaction(workspaceId, userId, async (tx, actor) => {
        const row = runnable(await load(tx, actor, chatId, id));
        if (input.digest !== row.digest) throw new TableProposalError('proposal-conflict');
        const target = kind === 'decision' ? 'tf_table_proposal_decisions' : 'tf_table_proposal_controls';
        const previous = (
          await tx.client.query(`SELECT * FROM ${table(tx, target)} WHERE membership_id=$1 AND command_id=$2`, [
            actor.membershipId,
            input.commandId,
          ])
        ).rows[0];
        const action = 'decision' in input ? input.decision : input.operation;
        if (previous) {
          if (
            previous.proposal_id !== id ||
            previous.digest !== input.digest ||
            (previous.decision ?? previous.operation) !== action
          )
            throw new TableProposalError('proposal-conflict');
          return state(tx, row);
        }
        const status = await state(tx, row);
        if (kind === 'decision' && status.decision) throw new TableProposalError('proposal-conflict');
        if (action === 'approve' || action === 'resume') {
          if (row.expired) throw new TableProposalError('proposal-expired');
          if (action === 'approve' && status.cancelled) throw new TableProposalError('proposal-cancelled');
          if (action === 'resume' && status.decision !== 'approve')
            throw new TableProposalError('proposal-not-approved');
          await visible(tx, actor, row.manifest, 'require-added');
          await data.lock(tx, row.manifest.plans.map(plan => plan.input.tableId).sort(), 'finalize');
          await current(tx, actor, row.manifest);
        }
        await persist(tx, row.manifest, input);
        return state(tx, row);
      });
    },
  };
}

export function createTableProposals(options: TableProposalOptions) {
  const { human: _human, ...service } = operations(options);
  return service;
}

export function createTableProposalDecisions(
  options: TableProposalOptions & { resolveConfirmationCredential(workspaceId: string): Promise<string> },
) {
  const service = operations(options);
  const act =
    (kind: 'decision' | 'control') =>
    (workspaceId: string, userId: string, chatId: string | null, id: string, input: unknown) =>
      service.human(workspaceId, userId, chatId, id, input, kind, async (_tx, manifest, value) => {
        await withMaintenanceTransaction({
          connectionString: await options.resolveConfirmationCredential(workspaceId),
          workspaceId,
          capability: 'confirmation',
          operation: async tx => {
            const member = manifest.requester.membershipId;
            if ('decision' in value) {
              const inserted = await tx.client.query(
                `INSERT INTO ${table(tx, 'tf_table_proposal_decisions')}(proposal_id,digest,membership_id,command_id,decision) SELECT id,digest,membership_id,$4,$5 FROM ${table(tx, 'tf_table_proposals')} WHERE id=$1 AND digest=$2 AND membership_id=$3 AND ($5='reject' OR expires_at>clock_timestamp())`,
                [id, value.digest, member, value.commandId, value.decision],
              );
              if (inserted.rowCount !== 1) throw new TableProposalError('proposal-expired');
            } else {
              await tx.client.query(
                `INSERT INTO ${table(tx, 'tf_table_proposal_controls')}(proposal_id,digest,membership_id,command_id,sequence,operation) SELECT $1,$2,$3,$4,COALESCE(max(sequence)+1,0),$5 FROM ${table(tx, 'tf_table_proposal_controls')} WHERE proposal_id=$1`,
                [id, value.digest, member, value.commandId, value.operation],
              );
            }
          },
        });
      });
  return { decide: act('decision'), control: act('control') };
}
