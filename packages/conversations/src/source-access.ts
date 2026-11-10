import {
  AccessDenied,
  SourceAuthorizationUnavailable,
  chatReviewClosure,
  tableSourceReadable,
  canAccessAsset,
  canAccessTable,
  currentMember,
  protectedSourceClosure,
  requireProtectedSource,
  requirePersonalMemorySource,
  requireMcpPrivateConversation,
  requirePersonalGitHubSource,
  requireWorkflowDefinitionSources,
  type AuthorizationTransaction,
  type ConversationSourcePrefetch,
  type HumanActor,
  type SourceDependency,
} from '@tulipfarm/access';
import { requireCitedLibraryFile, requireReadableFile } from '@tulipfarm/files';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { z } from 'zod';
import { sourceDependencySchema } from './results.ts';
import { standaloneTurn, turnRequester } from './turn-requester.ts';
import { chatAccess } from './chat-access.ts';

const sourceDependenciesSchema = z.array(sourceDependencySchema);
const slackRootSchema = z.object({ installation_id: z.uuid() }).optional();
export const followUpSourcesVersion = 54;

/** Legacy model instructions inherit their scheduling step; fixed reaction reminders consume no model context. */
export async function retainedFollowUpSources(tx: AuthorizationTransaction, ids: readonly string[]) {
  const found = new Map<string, SourceDependency[]>();
  if (!ids.length) return found;
  const rows = await tx.client.query(
    `SELECT f.id,COALESCE(NULLIF(to_jsonb(f)->'sources','null'::jsonb),
       CASE WHEN f.origin='slack-reaction' THEN '[]'::jsonb END,s.sources) AS sources
     FROM ${qualified(tx.schema, 'tf_follow_ups')} f
     LEFT JOIN ${qualified(tx.schema, 'tf_conversation_execution_steps')} s
       ON s.turn_id=f.origin_turn_id AND s.call->>'tool'='followups.schedule'
       AND s.output->'result'->'followUp'->>'id'=f.id::text
     WHERE f.id=ANY($1::uuid[])`,
    [ids],
  );
  for (const row of rows.rows) {
    const sources = sourceDependenciesSchema.safeParse(row.sources);
    found.set(row.id, sources.success ? sources.data : [{ kind: 'unknown' }]);
  }
  return found;
}

export async function generatedMessageSources(
  tx: AuthorizationTransaction,
  conversationId: string,
  messageIds: readonly string[],
) {
  const found = new Map<string, SourceDependency[]>();
  if (!messageIds.length || Number((tx as { commonVersion?: number }).commonVersion ?? 0) < 27) return found;
  const rows = await tx.client.query(
    `SELECT m.id,f.id AS follow_up_id FROM ${qualified(tx.schema, 'tf_conversation_messages')} m
     JOIN ${qualified(tx.schema, 'tf_conversation_turns')} t ON t.conversation_id=m.conversation_id
       AND (t.source_message_id=m.id OR t.response_message_id=m.id
         OR t.id=(SELECT r.turn_id FROM ${qualified(tx.schema, 'tf_conversation_results')} r WHERE r.message_id=m.id))
     JOIN ${qualified(tx.schema, 'tf_follow_ups')} f ON
       (f.conversation_id=m.conversation_id AND (f.id=t.source_message_id OR f.fired_message_id=t.source_message_id))
       OR f.fired_event_id IN (
         SELECT event_id FROM ${qualified(tx.schema, 'tf_slack_dm_events')} WHERE turn_id=t.id AND conversation_id=t.conversation_id
         UNION ALL SELECT event_id FROM ${qualified(tx.schema, 'tf_slack_default_turns')} WHERE turn_id=t.id AND conversation_id=t.conversation_id
       )
     WHERE m.conversation_id=$1 AND m.id=ANY($2::uuid[])`,
    [conversationId, messageIds],
  );
  const sources = await retainedFollowUpSources(
    tx,
    rows.rows.map(row => row.follow_up_id),
  );
  for (const row of rows.rows) found.set(row.id, sources.get(row.follow_up_id) ?? [{ kind: 'unknown' }]);
  return found;
}

export async function requireResultSources(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  conversationId: string,
  sources: unknown,
) {
  await currentMember(tx, actor);
  for (const source of sourceDependenciesSchema.parse(sources)) {
    switch (source.kind) {
      case 'private-conversation':
        if (source.conversationId !== conversationId) throw new AccessDenied();
        break;
      case 'table':
      case 'table-rows':
      case 'table-schema':
        if (
          source.kind !== 'table' &&
          !(
            await tx.client.query(
              `SELECT 1 FROM ${qualified(tx.schema, 'tf_table_catalog')} WHERE id=$1 AND ${source.kind === 'table-schema' ? 'target_revision' : 'applied_revision'}=$2 FOR SHARE`,
              [source.tableId, source.revision],
            )
          ).rowCount
        )
          throw new AccessDenied();
        if (!(await canAccessTable(tx, actor, source.tableId, 'table.row.read'))) throw new AccessDenied();
        break;
      case 'integration-source':
        if (
          !(
            await tx.client.query(
              `SELECT 1 FROM ${qualified(tx.schema, 'tf_integrations')} c JOIN ${qualified(tx.schema, 'tf_integration_sources')} s ON s.integration_id=c.id WHERE c.id=$1 AND s.id=$2 AND c.enabled AND c.deleted_at IS NULL`,
              [source.integrationId, source.sourceId],
            )
          ).rowCount ||
          !(await canAccessAsset(tx, actor, source.integrationId, 'integration.use')) ||
          !(await canAccessAsset(tx, actor, source.sourceId, 'github.issue.read'))
        )
          throw new AccessDenied();
        break;
      case 'public-web':
        break;
      // Each reader must be eligible for the cited knowledge revision, not only the requester.
      case 'knowledge-document':
        await requireProtectedSource(tx, actor, source);
        break;
      case 'tulipfarm-file':
        await requireReadableFile(tx, actor, source.fileId);
        break;
      case 'library-file':
        await requireCitedLibraryFile(tx, actor, source.fileId, source.read !== null);
        break;
      case 'workflow-definition':
      case 'workflow-provider':
      case 'google-file':
      case 'private-task':
      case 'mcp-integration':
      case 'github-personal':
      case 'github-source':
      case 'atlassian-source':
      case 'google-integration':
      case 'agent-definition':
      case 'workspace-skill':
      case 'project':
      case 'creation-team':
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
}

export async function requireSlackTurn(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  conversationId: string,
  turnId: string,
) {
  const table = (name: string) => qualified(tx.schema, name);
  const root = slackRootSchema.parse(
    (
      await tx.client.query(`SELECT installation_id FROM ${table('tf_slack_dm_roots')} WHERE conversation_id=$1`, [
        conversationId,
      ])
    ).rows[0],
  );
  if (!root) return false;
  await tx.client.query(`SELECT id FROM ${table('tf_slack_installations')} WHERE id=$1 FOR UPDATE`, [
    root.installation_id,
  ]);
  const allowed = await tx.client.query(
    `SELECT s.id FROM ${table('tf_slack_dm_roots')} r
    JOIN ${table('tf_slack_dm_events')} d ON d.conversation_id=r.conversation_id
    JOIN ${table('tf_slack_events')} e ON e.id=d.event_id AND e.installation_id=r.installation_id AND e.generation=r.generation
    JOIN ${table('tf_slack_identities')} i ON i.id=r.identity_id AND i.installation_id=r.installation_id AND i.generation=r.generation
    JOIN ${table('tf_slack_installations')} s ON s.id=r.installation_id AND s.generation=r.generation
    WHERE r.conversation_id=$1 AND d.turn_id=$2 AND i.user_id=$3 AND i.membership_id=$4
    AND i.state='authorized' AND i.credential IS NOT NULL AND 'im:history'=ANY(i.scopes)
    AND s.state='active' AND 'chat:write'=ANY(s.scopes) AND s.bot_credential IS NOT NULL
    AND e.disposition='held' AND e.payload->>'type'='message' AND e.payload->>'user'=i.slack_user_id
    AND e.payload->>'channel'=r.channel AND COALESCE(e.payload->>'thread_ts',e.payload->>'ts')=r.root_ts
    AND NOT EXISTS (SELECT 1 FROM ${table('tf_slack_user_revocations')} v WHERE v.installation_id=r.installation_id AND v.generation=r.generation AND v.slack_user_id=i.slack_user_id)
    `,
    [conversationId, turnId, actor.userId, actor.membershipId],
  );
  if (!allowed.rowCount) throw new AccessDenied();
  const stale = await tx.client.query(
    `SELECT 1 FROM ${table('tf_slack_dm_events')} d JOIN ${table('tf_slack_events')} e ON e.id=d.event_id
    JOIN ${table('tf_conversation_turns')} t ON t.id=d.turn_id
    JOIN ${table('tf_slack_message_changes')} c ON c.installation_id=e.installation_id AND c.generation=e.generation AND c.channel=e.payload->>'channel' AND c.message_ts=e.payload->>'ts'
    WHERE d.conversation_id=$1 AND (d.turn_id=$2 OR t.accepted_sequence<(SELECT accepted_sequence FROM ${table('tf_conversation_turns')} WHERE id=$2))
    AND (c.message IS NULL OR c.message->>'user'<>e.payload->>'user' OR COALESCE(c.message->>'thread_ts',c.message->>'ts')<>COALESCE(e.payload->>'thread_ts',e.payload->>'ts')
      OR COALESCE(c.message->>'content',c.message->>'text') IS DISTINCT FROM (SELECT string_agg(p.text,'' ORDER BY p.ordinal) FROM ${table('tf_conversation_parts')} p WHERE p.message_id=t.source_message_id AND p.kind='text'))`,
    [conversationId, turnId],
  );
  if (stale.rowCount) throw new AccessDenied();
  return true;
}

export async function requireGitHubSources(tx: AuthorizationTransaction, actor: HumanActor, sources: unknown) {
  for (const source of sourceDependenciesSchema.parse(sources)) {
    if (source.kind === 'github-personal') await requirePersonalGitHubSource(tx, actor, source);
    if (source.kind === 'github-source' && source.investigation) await requireProtectedSource(tx, actor, source);
  }
}

export async function requireGoogleSources(tx: AuthorizationTransaction, actor: HumanActor, sources: unknown) {
  for (const source of sourceDependenciesSchema.parse(sources))
    if (source.kind === 'google-integration') await requireProtectedSource(tx, actor, source);
}

export class KnowledgeSourceRemoved extends AccessDenied {}

export async function requireKnowledgeSources(tx: AuthorizationTransaction, actor: HumanActor, sources: unknown) {
  for (const source of sourceDependenciesSchema.parse(sources))
    if (source.kind === 'knowledge-document')
      try {
        await requireProtectedSource(tx, actor, source);
      } catch (error) {
        if (error instanceof SourceAuthorizationUnavailable || !(error instanceof AccessDenied)) throw error;
        const removed = await tx.client.query(
          `SELECT 1 FROM ${qualified(tx.schema, 'tf_knowledge_documents')} d
           JOIN ${qualified(tx.schema, 'tf_knowledge_sources')} s ON s.id=d.source_id
           WHERE d.id=$1 AND s.id=$2 AND s.provider IN ('note','file') AND s.owner_membership_id=$3
             AND (d.tombstoned_at IS NOT NULL OR d.observed_revision_id<>$4)`,
          [source.documentId, source.sourceId, actor.membershipId, source.revisionId],
        );
        if (removed.rowCount) throw new KnowledgeSourceRemoved();
        throw error;
      }
}

export async function requireWorkflowSources(tx: AuthorizationTransaction, actor: HumanActor, sources: unknown) {
  const workflows = z
    .array(sourceDependencySchema)
    .parse(sources)
    .filter(source => source.kind === 'workflow-definition' || source.kind === 'workflow-provider');
  if (!workflows.length) return;
  await requireWorkflowDefinitionSources(tx, actor, workflows);
}

/**
 * A tool receipt retains the whole reply context it ran in, not only the tool's own sources. Every concrete retained source must
 * stay readable. Provenance markers are not revocable sources, so they never change the receipt's outcome; the viewer's own
 * personal memory is readable, and opaque provenance only conceals the receipt's details. Returns whether to conceal them.
 */
export async function requireRetainedToolSources(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  sources: unknown,
  projectChatId?: string,
) {
  let opaque = false;
  for (const source of sourceDependenciesSchema.parse(sources))
    if (source.kind === 'personal-memory') opaque ||= source.membershipId !== actor.membershipId;
    else if (source.kind === 'unknown' || source.kind === 'unavailable' || source.kind === 'shared-slack-turn')
      opaque = true;
    else if (source.kind === 'private-conversation' && !source.snapshot && source.conversationId === projectChatId) {
      const chat = await chatAccess(tx, actor, source.conversationId);
      if (!chat.projectId) await requireProtectedSource(tx, actor, source);
    } else await requireProtectedSource(tx, actor, source);
  return opaque;
}

export async function canReadToolDetails(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  sources: unknown,
  output: unknown = null,
  projectChatId?: string,
) {
  const retained = sourceDependenciesSchema.safeParse(sources);
  const result =
    output == null
      ? { success: true as const, data: { sources: [] } }
      : z
          .object({
            sources: sourceDependenciesSchema,
          })
          .safeParse(output);
  if (!retained.success || !result.success) return false;
  try {
    const dependencies = [...retained.data, ...result.data.sources];
    if (await requireRetainedToolSources(tx, actor, dependencies, projectChatId)) return false;
    if (projectChatId) await requireResultSources(tx, actor, projectChatId, dependencies);
    return true;
  } catch (error) {
    if (error instanceof SourceAuthorizationUnavailable) throw error;
    if (!(error instanceof AccessDenied)) throw error;
    return false;
  }
}

/** Slack row drafts check their thread's audience when proposed, read and decided, not through the generic source reader. */
export async function requireChatReviewSources(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  sources: readonly SourceDependency[],
  rowDraft = false,
  readOnly = false,
) {
  await currentMember(tx, actor);
  for (const source of await chatReviewClosure(tx, actor, sources))
    if (source.kind === 'personal-memory') await requirePersonalMemorySource(tx, actor, source);
    else if (rowDraft && source.kind === 'shared-slack-turn') continue;
    else await requireProtectedSource(tx, actor, source, undefined, false, readOnly);
}

/** Files read for a turn stay readable by its requester through delivery. */
export async function requireFileSources(tx: AuthorizationTransaction, actor: HumanActor, sources: unknown) {
  for (const source of sourceDependenciesSchema.parse(sources))
    if (source.kind === 'tulipfarm-file' || source.kind === 'library-file' || source.kind === 'google-file')
      await requireProtectedSource(tx, actor, source);
}

/** Whether the requester can still read every table in `sources`, at whatever revision it has now. */
export async function canReadTableSources(tx: AuthorizationTransaction, actor: HumanActor, sources: unknown) {
  for (const source of sourceDependenciesSchema.parse(sources))
    if (!(await tableSourceReadable(tx, actor, source))) return false;
  return true;
}

/** An answer that used a Google Drive file stays usable only while the sender's integration is the one that read it. */
export async function requireGoogleFileSources(tx: AuthorizationTransaction, actor: HumanActor, sources: unknown) {
  for (const source of sourceDependenciesSchema.parse(sources))
    if (source.kind === 'google-file') await requireProtectedSource(tx, actor, source);
}

export async function requireMcpSources(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  conversationId: string,
  sources: unknown,
  prefetch?: ConversationSourcePrefetch,
  readOnly = false,
) {
  await requireWorkflowSources(tx, actor, sources);
  const retained = await protectedSourceClosure(tx, sources, prefetch);
  if (!retained.some(source => source.kind === 'mcp-integration')) return;
  await currentMember(tx, actor);
  await requireMcpPrivateConversation(tx, actor, conversationId);
  for (const source of retained) await requireProtectedSource(tx, actor, source, undefined, false, readOnly);
}

const integrationKinds = new Set(['google-integration', 'google-file', 'github-personal', 'mcp-integration']);

/**
 * Checks a reply's sources like `requireMcpSources`, but skips an integration source the requester can no longer read
 * when it is reached only through the chat's own earlier turns. The reply's context leaves out each earlier answer
 * whose own sources are unreadable, so their data never reaches the model.
 */
export async function requireReplyMcpSources(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  conversationId: string,
  sources: unknown,
) {
  await requireWorkflowSources(tx, actor, sources);
  const retained = await protectedSourceClosure(tx, sources);
  if (!retained.some(source => source.kind === 'mcp-integration')) return;
  await currentMember(tx, actor);
  const direct = new Set(
    (
      await protectedSourceClosure(
        tx,
        sourceDependenciesSchema
          .parse(sources)
          .filter(source => source.kind !== 'private-conversation' || source.conversationId !== conversationId),
      )
    ).map(source => JSON.stringify(source)),
  );
  const kept = [];
  for (const source of retained) {
    if (integrationKinds.has(source.kind) && !direct.has(JSON.stringify(source)))
      try {
        await requireProtectedSource(tx, actor, source);
      } catch (error) {
        if (error instanceof AccessDenied) continue;
        throw error;
      }
    kept.push(source);
  }
  if (!kept.some(source => source.kind === 'mcp-integration')) return;
  await requireMcpPrivateConversation(tx, actor, conversationId);
  for (const source of kept) await requireProtectedSource(tx, actor, source);
}

export async function requireConversationMcpSources(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  conversationId: string,
  prefetch?: ConversationSourcePrefetch,
  readOnly = false,
) {
  await requireMcpSources(
    tx,
    actor,
    conversationId,
    [{ kind: 'private-conversation', conversationId }],
    prefetch,
    readOnly,
  );
}

/**
 * Checks that the turn's requester may still use its chat. Earlier answers are not rechecked here: a reply's context
 * leaves out each one whose sources the requester can no longer read, and the sources it keeps are rechecked before
 * every model call. A Slack turn's earlier results stay readable by its audience.
 */
export async function requireCurrentConversationSources(
  tx: AuthorizationTransaction,
  conversationId: string,
  turnId: string,
) {
  const actor = await turnRequester(tx, conversationId, turnId);
  await currentMember(tx, actor);
  // A standalone follow-up holds no earlier turn of its chat, so only that turn's own sources apply.
  const standalone = await standaloneTurn(tx, conversationId, turnId);
  if (await requireSlackTurn(tx, actor, conversationId, turnId)) {
    const rows = await tx.client.query(
      `SELECT r.sources FROM ${qualified(tx.schema, 'tf_conversation_results')} r JOIN ${qualified(tx.schema, 'tf_conversation_turns')} t ON t.id=r.turn_id WHERE r.conversation_id=$1 AND t.accepted_sequence<(SELECT accepted_sequence FROM ${qualified(tx.schema, 'tf_conversation_turns')} WHERE id=$2)`,
      [conversationId, turnId],
    );
    if (!standalone) for (const row of rows.rows) await requireResultSources(tx, actor, conversationId, row.sources);
    return actor;
  }
  return null;
}
