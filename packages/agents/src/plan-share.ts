import { z } from 'zod';
import {
  AccessDenied,
  canAccessTable,
  requireProtectedSource,
  sourceDependenciesSchema,
  type HumanActor,
  type SourceDependency,
} from '@tulipfarm/access';
import { requireReadableFile } from '@tulipfarm/files';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { relation, type AgentTransaction } from './store.ts';

export type ShareSubject = { kind: 'individual' | 'team'; id: string };

/** Sources that say nothing about what a reader of the document could learn are left out of the share check. */
const ignored = new Set<SourceDependency['kind']>([
  'private-conversation',
  'personal-memory',
  'public-web',
  'agent-definition',
  'workspace-skill',
  'workflow-definition',
  'workflow-provider',
  'private-task',
  'project',
  'creation-team',
]);

/**
 * The plan whose document PDF is this file, or null for any other file. Plans record their PDF in
 * `tf_agent_plans.document_file_id`, and each rendered revision in `tf_agent_plan_documents.pdf_file_id`.
 */
export async function planForDocumentFile(tx: AgentTransaction, fileId: string): Promise<string | null> {
  const row = (
    await tx.client.query(
      `SELECT id FROM ${relation(tx, 'tf_agent_plans')} WHERE document_file_id=$1
       UNION SELECT plan_id AS id FROM ${relation(tx, 'tf_agent_plan_documents')} WHERE pdf_file_id=$1 LIMIT 1`,
      [fileId],
    )
  ).rows[0];
  return row ? z.uuid().parse(row.id) : null;
}

/**
 * What the coordinator read in the turns that wrote the plan: the turn that created it and every turn that updated it,
 * taken from those turns' tool and model source receipts. Tables are reduced to the table itself, since a reader must be
 * able to read its rows now rather than at one revision.
 */
export async function planSources(tx: AgentTransaction, planId: string): Promise<SourceDependency[]> {
  const rows = z.array(z.object({ sources: z.unknown() })).parse(
    (
      await tx.client.query(
        `WITH plan AS (SELECT id,conversation_id,source_turn_id FROM ${relation(tx, 'tf_agent_plans')} WHERE id=$1),
        writers AS (
          SELECT source_turn_id AS id FROM plan WHERE source_turn_id IS NOT NULL
          UNION SELECT s.turn_id FROM ${relation(tx, 'tf_conversation_execution_steps')} s
            JOIN ${relation(tx, 'tf_conversation_turns')} t ON t.id=s.turn_id JOIN plan ON t.conversation_id=plan.conversation_id
            WHERE s.call->>'tool' IN ('plans.create','plans.update')
              AND (s.call->>'planId'=$1::text OR s.output->>'id'=$1::text OR s.output->'plan'->>'id'=$1::text))
        SELECT sources FROM ${relation(tx, 'tf_conversation_execution_steps')} WHERE turn_id IN (SELECT id FROM writers)
        UNION ALL SELECT sources FROM ${relation(tx, 'tf_conversation_model_sources')} WHERE turn_id IN (SELECT id FROM writers)`,
        [planId],
      )
    ).rows,
  );
  const unique = new Map<string, SourceDependency>();
  for (const row of rows) {
    const parsed = sourceDependenciesSchema.safeParse(row.sources);
    // A receipt this check cannot read could hide anything, so it counts as a source no one else may share.
    const sources: SourceDependency[] = parsed.success ? parsed.data : [{ kind: 'unknown' }];
    for (const source of sources) {
      if (ignored.has(source.kind)) continue;
      const reduced: SourceDependency =
        source.kind === 'table-rows' || source.kind === 'table-schema'
          ? { kind: 'table', tableId: source.tableId }
          : source;
      unique.set(canonicalJson(reduced), reduced);
    }
  }
  return [...unique.values()];
}

async function canRead(tx: AgentTransaction, reader: HumanActor, source: SourceDependency) {
  if (source.kind === 'unknown' || source.kind === 'unavailable') return false;
  await tx.client.query('SAVEPOINT tf_plan_share_source');
  try {
    if (source.kind === 'table') {
      if (!(await canAccessTable(tx, reader, source.tableId, 'table.row.read'))) throw new AccessDenied();
    } else if (source.kind === 'library-file' || source.kind === 'tulipfarm-file')
      await requireReadableFile(tx, reader, source.fileId);
    else await requireProtectedSource(tx, reader, source);
    await tx.client.query('RELEASE SAVEPOINT tf_plan_share_source');
    return true;
  } catch (error) {
    await tx.client.query('ROLLBACK TO SAVEPOINT tf_plan_share_source');
    if (error instanceof AccessDenied) return false;
    throw error;
  }
}

/**
 * The subjects who cannot read every source of the plan. A team is left out when any of its active members cannot.
 * Personal sources pinned to the starter, such as their own Google or GitHub account, leave everyone else out.
 */
export async function subjectsWithoutPlanSources(
  tx: AgentTransaction,
  planId: string,
  subjects: readonly ShareSubject[],
): Promise<ShareSubject[]> {
  const sources = await planSources(tx, planId);
  if (!sources.length) return [];
  const members = z.array(z.object({ id: z.uuid(), user_id: z.string(), team_ids: z.array(z.uuid()) })).parse(
    (
      await tx.client.query(
        `SELECT m.id,m.user_id,COALESCE(array_agg(e.team_id) FILTER (WHERE e.team_id IS NOT NULL),'{}') AS team_ids
          FROM ${relation(tx, 'tf_memberships')} m LEFT JOIN ${relation(tx, 'tf_member_teams')} e ON e.membership_id=m.id
          WHERE m.removed_at IS NULL AND (m.id=ANY($1::uuid[]) OR e.team_id=ANY($2::uuid[]))
          GROUP BY m.id,m.user_id`,
        [
          subjects.filter(subject => subject.kind === 'individual').map(subject => subject.id),
          subjects.filter(subject => subject.kind === 'team').map(subject => subject.id),
        ],
      )
    ).rows,
  );
  const verdicts = new Map<string, boolean>();
  const readsAll = async (member: (typeof members)[number]) => {
    let verdict = verdicts.get(member.id);
    if (verdict === undefined) {
      verdict = true;
      for (const source of sources)
        if (!(await canRead(tx, { kind: 'human', userId: member.user_id, membershipId: member.id }, source))) {
          verdict = false;
          break;
        }
      verdicts.set(member.id, verdict);
    }
    return verdict;
  };
  const excluded: ShareSubject[] = [];
  for (const subject of subjects) {
    const audience = members.filter(member =>
      subject.kind === 'individual' ? member.id === subject.id : member.team_ids.includes(subject.id),
    );
    let ok = true;
    for (const member of audience)
      if (!(await readsAll(member))) {
        ok = false;
        break;
      }
    if (!ok) excluded.push(subject);
  }
  return excluded;
}
