import { z } from 'zod';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import type { HumanActor, AuthorizationTransaction } from './contracts.ts';
import type { KnowledgeSearchFilters } from '../contracts.ts';

export async function knowledgeAvailability(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  filters: KnowledgeSearchFilters,
  google: boolean,
  readers: { slack: boolean | undefined; github: boolean | undefined; atlassian: boolean | undefined },
) {
  const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, `tf_knowledge_${name}`);
  const unavailable =
    google && filters.kinds.includes('google')
      ? z.object({ unavailable: z.boolean() }).parse(
          (
            await tx.client.query(
              `SELECT EXISTS (
        SELECT 1 FROM ${table(tx, 'google_members')} a JOIN ${table(tx, 'sources')} s ON s.id=a.source_id
        WHERE a.membership_id=$1 AND s.state<>'removed' AND (cardinality($2::uuid[])=0 OR s.id=ANY($2::uuid[]))
          AND (NOT EXISTS (SELECT 1 FROM ${table(tx, 'google_readers')} r WHERE r.source_id=s.id AND r.membership_id=$1)
          OR EXISTS (SELECT 1 FROM ${table(tx, 'documents')} d WHERE d.source_id=s.id AND d.tombstoned_at IS NULL
            AND (cardinality($3::uuid[])=0 OR d.id=ANY($3::uuid[])) AND NOT EXISTS (
              SELECT 1 FROM ${table(tx, 'google_eligible')} e WHERE e.document_id=d.id AND e.membership_id=$1)))) AS unavailable`,
              [actor.membershipId, filters.sourceIds, filters.documentIds],
            )
          ).rows[0],
        ).unavailable
      : false;
  const slackUnavailable =
    readers.slack === filters.kinds.includes('slack')
      ? z.object({ unavailable: z.boolean() }).parse(
          (
            await tx.client.query(
              `WITH readable AS MATERIALIZED (SELECT document_id FROM ${table(tx, 'slack_eligible_for')}($1::uuid,$4::text))
        SELECT EXISTS (
        SELECT 1 FROM ${table(tx, 'slack_members')} a JOIN ${table(tx, 'sources')} s ON s.id=a.source_id
        WHERE a.membership_id=$1 AND s.state<>'removed' AND (cardinality($2::uuid[])=0 OR s.id=ANY($2::uuid[]))
          AND (EXISTS (SELECT 1 FROM ${table(tx, 'slack_conversations')} c WHERE c.source_id=s.id AND c.state<>'active')
          OR EXISTS (SELECT 1 FROM ${table(tx, 'documents')} d WHERE d.source_id=s.id AND d.tombstoned_at IS NULL
            AND (cardinality($3::uuid[])=0 OR d.id=ANY($3::uuid[])) AND NOT EXISTS (
              SELECT 1 FROM readable e WHERE e.document_id=d.id)))) AS unavailable`,
              [actor.membershipId, filters.sourceIds, filters.documentIds, actor.userId],
            )
          ).rows[0],
        ).unavailable
      : false;
  const githubUnavailable =
    readers.github === filters.kinds.includes('github')
      ? z.object({ unavailable: z.boolean() }).parse(
          (
            await tx.client.query(
              `WITH readable AS MATERIALIZED (SELECT document_id FROM ${table(tx, 'github_eligible_for')}($1::uuid,$4::text))
        SELECT EXISTS (
        SELECT 1 FROM ${table(tx, 'github_members')} a JOIN ${table(tx, 'sources')} s ON s.id=a.source_id
        WHERE a.membership_id=$1 AND s.state<>'removed' AND (cardinality($2::uuid[])=0 OR s.id=ANY($2::uuid[]))
          AND (EXISTS (SELECT 1 FROM ${table(tx, 'github_repositories')} c WHERE c.source_id=s.id AND c.state<>'active')
          OR EXISTS (SELECT 1 FROM ${table(tx, 'documents')} d WHERE d.source_id=s.id AND d.tombstoned_at IS NULL
            AND (cardinality($3::uuid[])=0 OR d.id=ANY($3::uuid[])) AND NOT EXISTS (
              SELECT 1 FROM readable e WHERE e.document_id=d.id)))) AS unavailable`,
              [actor.membershipId, filters.sourceIds, filters.documentIds, actor.userId],
            )
          ).rows[0],
        ).unavailable
      : false;
  const atlassianUnavailable =
    readers.atlassian === (filters.kinds.includes('confluence') || filters.kinds.includes('jira'))
      ? z.object({ unavailable: z.boolean() }).parse(
          (
            await tx.client.query(
              `WITH readable AS MATERIALIZED (SELECT document_id FROM ${table(tx, 'atlassian_eligible_for')}($1::uuid,$4::text))
        SELECT EXISTS (
        SELECT 1 FROM ${table(tx, 'atlassian_members')} a JOIN ${table(tx, 'sources')} s ON s.id=a.source_id
        WHERE a.membership_id=$1 AND s.state<>'removed' AND s.provider=ANY($5::text[]) AND (cardinality($2::uuid[])=0 OR s.id=ANY($2::uuid[]))
          AND (EXISTS (SELECT 1 FROM ${table(tx, 'atlassian_targets')} t WHERE t.source_id=s.id AND t.state<>'active')
          OR EXISTS (SELECT 1 FROM ${table(tx, 'documents')} d WHERE d.source_id=s.id AND d.tombstoned_at IS NULL
            AND (cardinality($3::uuid[])=0 OR d.id=ANY($3::uuid[])) AND NOT EXISTS (
              SELECT 1 FROM readable e WHERE e.document_id=d.id)))) AS unavailable`,
              [actor.membershipId, filters.sourceIds, filters.documentIds, actor.userId, filters.kinds],
            )
          ).rows[0],
        ).unavailable
      : false;

  return unavailable || slackUnavailable || githubUnavailable || atlassianUnavailable;
}
