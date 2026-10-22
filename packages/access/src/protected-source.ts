import { escapeIdentifier } from 'pg';
import { z } from 'zod';
import {
  AccessDenied,
  canAccessAsset,
  canAccessTable,
  currentMember,
  requirePersonalGitHubSource,
  type AuthorizationTransaction,
  type HumanActor,
} from './index.ts';
import { requireMcpSource, requireMcpTaskRun, requirePrivateTaskSource } from './mcp-source.ts';
import type { SourceDependency } from './source-dependencies.ts';
import { requireAgentGrant, requireSkillGrant } from './agent-permissions.ts';
import { requireWorkflowSource } from './workflow-source.ts';
import { requireOrdinaryGitHubChat } from './github-source.ts';
import { requireGitHubTask } from './github-task.ts';

export type TulipFarmFileReference = Omit<Extract<SourceDependency, { kind: 'tulipfarm-file' }>, 'read'>;

/** The member referenced this file in this chat and can read it now. Files supplies the readability check. */
export async function requireTulipFarmFileReference(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  reference: TulipFarmFileReference,
) {
  if (reference.membershipId !== actor.membershipId || !tx.requireTulipFarmFile) throw new AccessDenied();
  const parts = `${escapeIdentifier(tx.schema)}.${escapeIdentifier('tf_conversation_parts')}`,
    messages = `${escapeIdentifier(tx.schema)}.${escapeIdentifier('tf_conversation_messages')}`;
  if (
    !(
      await tx.client.query(
        `SELECT 1 FROM ${parts} p JOIN ${messages} m ON m.id=p.message_id AND m.conversation_id=p.conversation_id
    WHERE p.conversation_id=$1 AND p.kind='file' AND p.file_id=$2 AND m.author_kind='human' AND m.membership_id=$3`,
        [reference.conversationId, reference.fileId, actor.membershipId],
      )
    ).rowCount
  )
    throw new AccessDenied();
  await tx.requireTulipFarmFile(actor, reference);
}

export type GoogleFileReference = Omit<Extract<SourceDependency, { kind: 'google-file' }>, 'read'>;

/**
 * The member sent this Drive file in this private chat through this exact Google integration, and that integration is still theirs,
 * connected, and at the same generation. Google decides whether the file itself can be read; the caller reads through the binding.
 */
export async function requireGoogleFileReference(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  reference: GoogleFileReference,
) {
  if (reference.membershipId !== actor.membershipId) throw new AccessDenied();
  const table = (name: string) => `${escapeIdentifier(tx.schema)}.${escapeIdentifier(name)}`;
  if (
    !(
      await tx.client.query(
        `SELECT 1 FROM ${table('tf_conversation_parts')} p JOIN ${table('tf_conversation_messages')} m ON m.id=p.message_id AND m.conversation_id=p.conversation_id
    JOIN ${table('tf_conversations')} c ON c.id=p.conversation_id
    WHERE p.conversation_id=$1 AND p.kind='google-file' AND m.author_kind='human' AND m.membership_id=$2 AND c.project_id IS NULL
      AND p.google_file @> jsonb_build_object('fileId',$3::text,'integrationId',$4::text,'accountId',$5::text,'generation',$6::integer)`,
        [
          reference.conversationId,
          actor.membershipId,
          reference.fileId,
          reference.integrationId,
          reference.accountId,
          reference.generation,
        ],
      )
    ).rowCount
  )
    throw new AccessDenied();
  await requireGoogleDriveBinding(tx, actor, reference);
}

/** The bound Google integration is still the member's, connected, at the same account and generation, and holds Drive access. */
export async function requireGoogleDriveBinding(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  binding: { integrationId: string; accountId: string; generation: number },
) {
  const table = `${escapeIdentifier(tx.schema)}.${escapeIdentifier('tf_google_integrations')}`;
  await tx.client.query(`SELECT id FROM ${table} WHERE id=$1 FOR SHARE`, [binding.integrationId]);
  const row = (
    await tx.client.query(
      `SELECT scopes FROM ${table} WHERE id=$1 AND account_id=$2 AND membership_id=$3 AND user_id=$4 AND generation=$5 AND status='connected'`,
      [binding.integrationId, binding.accountId, actor.membershipId, actor.userId, binding.generation],
    )
  ).rows[0];
  if (!z.array(z.string()).optional().parse(row?.scopes)?.includes('https://www.googleapis.com/auth/drive'))
    throw new AccessDenied();
}

/** Personal memory is readable only by the current member who saved it. */
export async function requirePersonalMemorySource(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  source: Extract<SourceDependency, { kind: 'personal-memory' }>,
) {
  if (source.membershipId !== actor.membershipId) throw new AccessDenied();
  await currentMember(tx, actor);
}

export async function requireProtectedSource(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  source: SourceDependency,
  runId?: string,
  publicOnly = false,
) {
  const table = (name: string) => `${escapeIdentifier(tx.schema)}.${escapeIdentifier(name)}`;
  switch (source.kind) {
    case 'knowledge-document':
      if (!tx.requireKnowledgeSource) throw new AccessDenied();
      await tx.requireKnowledgeSource(actor, source, { ...(runId === undefined ? {} : { runId }), publicOnly });
      break;
    case 'tulipfarm-file':
      if (runId || publicOnly) throw new AccessDenied();
      await requireTulipFarmFileReference(tx, actor, source);
      break;
    case 'google-file':
      if (runId || publicOnly) throw new AccessDenied();
      await requireGoogleFileReference(tx, actor, source);
      break;
    case 'private-task':
      if (publicOnly) throw new AccessDenied();
      await requirePrivateTaskSource(tx, actor, source.taskId);
      if (runId) await requireMcpTaskRun(tx, actor, runId);
      break;
    case 'mcp-integration':
      if (publicOnly) throw new AccessDenied();
      if (runId) await requireMcpTaskRun(tx, actor, runId);
      await requireMcpSource(tx, actor, source);
      break;
    case 'github-personal':
      if (publicOnly) throw new AccessDenied();
      if (
        runId &&
        (source.origin !== 'task' ||
          !(
            await tx.client.query(
              `SELECT 1 FROM ${table('tf_agent_task_runs')} b JOIN ${table('tf_agent_tasks')} t ON t.id=b.task_id WHERE b.run_id=$1 AND b.task_id=$2 AND b.generation=t.generation`,
              [runId, source.taskId],
            )
          ).rowCount)
      )
        throw new AccessDenied();
      await requirePersonalGitHubSource(tx, actor, source);
      break;
    case 'table':
    case 'table-rows':
    case 'table-schema':
      if (!(await tx.client.query(`SELECT 1 FROM ${table('tf_table_catalog')} WHERE id=$1`, [source.tableId])).rowCount)
        throw new AccessDenied();
      if (
        source.kind !== 'table' &&
        !(
          await tx.client.query(
            `SELECT 1 FROM ${table('tf_table_catalog')} WHERE id=$1 AND ${source.kind === 'table-schema' ? 'target_revision' : 'applied_revision'}=$2 FOR SHARE`,
            [source.tableId, source.revision],
          )
        ).rowCount
      )
        throw new AccessDenied();
      if (
        !(await canAccessTable(tx, actor, source.tableId, 'table.row.read')) &&
        !(source.kind === 'table-schema' && (await canAccessTable(tx, actor, source.tableId, 'table.schema.manage')))
      )
        throw new AccessDenied();
      if (runId && !(await canAccessTable(tx, { kind: 'agent', runId }, source.tableId, 'table.row.read')))
        throw new AccessDenied();
      break;
    case 'github-source':
      if (
        !(
          await tx.client.query(
            `SELECT 1 FROM ${table('tf_integrations')} WHERE id=$1 AND generation=$2 AND grants_version=$3 AND enabled AND deleted_at IS NULL FOR SHARE`,
            [source.integrationId, source.generation, source.grantsVersion],
          )
        ).rowCount
      )
        throw new AccessDenied();
      if (source.investigation) {
        const { origin, membershipId, selectionVersion } = source.investigation;
        if (
          publicOnly ||
          membershipId !== actor.membershipId ||
          !source.readProof ||
          !source.requiredPermissions?.length ||
          !tx.requireTeamGitHubSource
        )
          throw new AccessDenied();
        if (source.readProof.operation.kind.startsWith('project.')) throw new AccessDenied();
        if (origin.kind === 'chat') {
          if (runId) throw new AccessDenied();
          await requireOrdinaryGitHubChat(tx, actor, origin.conversationId);
        } else {
          const task = await requireGitHubTask(tx, actor, origin.taskId);
          if (task.generation < origin.generation) throw new AccessDenied();
          if (
            runId &&
            !(
              await tx.client.query(
                `SELECT 1 FROM ${table('tf_agent_task_runs')} WHERE run_id=$1 AND task_id=$2 AND generation=$3`,
                [runId, origin.taskId, task.generation],
              )
            ).rowCount
          )
            throw new AccessDenied();
        }
        const selectedTable = origin.kind === 'chat' ? 'tf_github_chat_selection' : 'tf_github_task_selection';
        const column = origin.kind === 'chat' ? 'conversation_id' : 'task_id';
        if (
          !(
            await tx.client.query(
              `SELECT 1 FROM ${table(selectedTable)} WHERE ${column}=$1 AND integration_id=$2 AND integration_generation=$3 AND version=$4 AND investigation AND account_id IS NULL FOR SHARE`,
              [
                origin.kind === 'chat' ? origin.conversationId : origin.taskId,
                source.integrationId,
                source.generation,
                selectionVersion,
              ],
            )
          ).rowCount
        )
          throw new AccessDenied();
        if (
          !(await canAccessAsset(tx, actor, source.integrationId, 'integration.use')) ||
          !(
            await tx.client.query(
              `SELECT 1 FROM ${table('tf_integration_sources')} WHERE id=$1 AND integration_id=$2`,
              [source.sourceId, source.integrationId],
            )
          ).rowCount
        )
          throw new AccessDenied();
        for (const permission of source.requiredPermissions)
          if (!(await canAccessAsset(tx, actor, source.sourceId, permission))) throw new AccessDenied();
        await tx.requireTeamGitHubSource(actor, source);
        break;
      }
      if (source.requiredPermissions || source.readProof) throw new AccessDenied();
      await requireProtectedSource(
        tx,
        actor,
        { kind: 'integration-source', integrationId: source.integrationId, sourceId: source.sourceId },
        runId,
        publicOnly,
      );
      break;
    case 'integration-source':
      if (runId) throw new AccessDenied();
      if (
        !(await canAccessAsset(tx, actor, source.integrationId, 'integration.use')) ||
        !(await canAccessAsset(tx, actor, source.sourceId, 'github.issue.read')) ||
        !(
          await tx.client.query(
            `SELECT 1 FROM ${table('tf_integrations')} c JOIN ${table('tf_integration_sources')} s ON s.integration_id=c.id WHERE c.id=$1 AND s.id=$2 AND c.enabled AND c.deleted_at IS NULL`,
            [source.integrationId, source.sourceId],
          )
        ).rowCount
      )
        throw new AccessDenied();
      break;
    case 'atlassian-source': {
      if (runId || source.membershipId !== actor.membershipId) throw new AccessDenied();
      await tx.client.query(`SELECT id FROM ${table('tf_atlassian_accounts')} WHERE id=$1 FOR SHARE`, [
        source.accountId,
      ]);
      await tx.client.query(`SELECT id FROM ${table('tf_atlassian_sources')} WHERE id=$1 FOR SHARE`, [source.sourceId]);
      const row = (
        await tx.client.query(
          `SELECT 1 FROM ${table('tf_atlassian_sources')} s JOIN ${table('tf_atlassian_accounts')} a ON a.id=s.account_id WHERE s.id=$1 AND s.account_id=$2 AND s.membership_id=$3 AND s.enabled AND a.state='active' AND a.generation=$4 AND a.grants_version=$5 AND a.expires_at>clock_timestamp() AND s.binding=$6::jsonb AND ((a.ownership='personal' AND a.owner_membership_id=$3) OR (a.ownership='business' AND (EXISTS (SELECT 1 FROM ${table('tf_atlassian_account_member_grants')} g WHERE g.account_id=a.id AND g.membership_id=$3) OR EXISTS (SELECT 1 FROM ${table('tf_atlassian_account_team_grants')} g JOIN ${table('tf_member_teams')} m ON m.team_id=g.team_id WHERE g.account_id=a.id AND m.membership_id=$3))))`,
          [
            source.sourceId,
            source.accountId,
            actor.membershipId,
            source.generation,
            source.grantsVersion,
            source.binding,
          ],
        )
      ).rows[0];
      if (!row) throw new AccessDenied();
      break;
    }
    case 'google-integration': {
      if (runId || source.membershipId !== actor.membershipId) throw new AccessDenied();
      await tx.client.query(`SELECT id FROM ${table('tf_google_integrations')} WHERE id=$1 FOR SHARE`, [
        source.integrationId,
      ]);
      const row = (
        await tx.client.query(
          `SELECT scopes FROM ${table('tf_google_integrations')} WHERE id=$1 AND account_id=$2 AND membership_id=$3 AND user_id=$4 AND generation=$5 AND status='connected'`,
          [source.integrationId, source.accountId, actor.membershipId, actor.userId, source.generation],
        )
      ).rows[0];
      const scopes = z.array(z.string()).optional().parse(row?.scopes);
      if (!scopes || !source.requiredScopes.every(scope => scopes.includes(scope))) throw new AccessDenied();
      break;
    }
    case 'agent-definition': {
      await requireAgentGrant(tx, actor, source.agentId, 'read');
      if (
        !(
          await tx.client.query(
            `SELECT 1 FROM ${table('tf_agent_saved_revisions')} WHERE agent_id=$1 AND (soul_revision=$2 OR definition_revision=$2)`,
            [source.agentId, source.revision],
          )
        ).rowCount
      )
        throw new AccessDenied();
      break;
    }
    case 'workflow-definition':
    case 'workflow-provider':
      if (runId || publicOnly) throw new AccessDenied();
      await requireWorkflowSource(tx, actor, source);
      break;
    case 'workspace-skill':
      await requireSkillGrant(tx, actor, source.skillId, 'read');
      if (
        !(
          await tx.client.query(
            `SELECT 1 FROM ${table('tf_workspace_skills')} s JOIN ${table('tf_workspace_skill_reviews')} r ON r.skill_id=s.id WHERE s.id=$1 AND r.revision=$2 AND s.enabled`,
            [source.skillId, source.revision],
          )
        ).rowCount
      )
        throw new AccessDenied();
      break;
    case 'creation-team':
      if (source.authority === 'agent') {
        await currentMember(tx, actor);
        if (
          !(
            await tx.client.query(`SELECT 1 FROM ${table('tf_member_teams')} WHERE team_id=$1 AND membership_id=$2`, [
              source.teamId,
              actor.membershipId,
            ])
          ).rowCount
        )
          throw new AccessDenied();
      } else if (
        !(await tx.client.query(`SELECT 1 FROM ${table('tf_teams')} WHERE id=$1`, [source.teamId])).rowCount ||
        !(await canAccessTable(tx, actor, source.teamId, 'table.create'))
      )
        throw new AccessDenied();
      break;
    case 'private-conversation':
      if (publicOnly) throw new AccessDenied();
      if (
        !(
          await tx.client.query(
            `SELECT 1 FROM ${table('tf_conversations')} c WHERE c.id=$1 AND c.kind='private' AND c.owner_user_id=$2 AND c.owner_membership_id=$3 AND c.deleted_at IS NULL
        AND (c.project_id IS NULL OR EXISTS (SELECT 1 FROM ${table('tf_projects')} p JOIN ${table('tf_project_members')} pm ON pm.project_id=p.id
          WHERE p.id=c.project_id AND p.archived_at IS NULL AND pm.membership_id=$3 AND pm.removed_at IS NULL))`,
            [source.conversationId, actor.userId, actor.membershipId],
          )
        ).rowCount
      )
        throw new AccessDenied();
      break;
    case 'public-web':
      break;
    // Saved definitions and shared artifacts never carry personal memory; row drafts bind it with requirePersonalMemorySource.
    case 'shared-slack-turn':
    case 'personal-memory':
    case 'unknown':
    case 'unavailable':
      throw new AccessDenied();
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}
