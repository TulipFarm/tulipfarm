import { createHash, randomUUID } from 'node:crypto';
import { budCompatibility, clearBudConversation } from './bud-assistant.ts';
import { z } from 'zod';
import { googleToolActivity } from './google-tool-activity.ts';
import { toolPresentation } from './tool-activity.ts';
import { storedToolPresentation, storedToolStatus } from './tool-activity-history.ts';
import { publicWebReceiptForHistory } from './public-web-history.ts';
import { knowledgeActivityForHistory } from './knowledge-activity-history.ts';
import { rowChangeForReceipt, rowViewForReceipt } from './row-view.ts';
import { workflowReferences } from './workflow-receipts.ts';
import { sourceDependenciesSchema } from './results.ts';
import { requireCredits, CreditsExhausted } from '@tulipfarm/workspace-storage/credits';
import { recordFileUse } from '@tulipfarm/files';
import {
  AccessDenied,
  lockAuthorization,
  resolveHuman,
  uuidSchema,
  type HumanActor,
  type AuthorizationTransaction,
} from '@tulipfarm/access';
import {
  qualified,
  StorageUnavailableError,
  commonCompatibility,
  type createWorkspaceRuntime,
} from '@tulipfarm/workspace-storage/runtime';
import { AttachmentError } from './attachments.ts';
import { interruptToolReceipts } from './tool-receipts.ts';
import { notifyConversationChange } from './event-publisher.ts';
import {
  requireConversationMcpSources,
  requireGitHubSources,
  requireGoogleFileSources,
  requireGoogleSources,
  requireKnowledgeSources,
  requireWorkflowSources,
} from './source-access.ts';
import { calendarResultsForHistory } from './calendar-results.ts';
import {
  admitFileReferences,
  admitGoogleFileReferences,
  bindFileSources,
  resolveFileAudience,
} from './file-references.ts';
import { authorizeChat, type ChatAccessRule } from './chat-access.ts';
import { requireProjectAccess } from './project-membership.ts';
import { requireResultSources } from './source-access.ts';
import { readCompaction } from './compaction.ts';
import { recordConversationActivity } from './activity.ts';
import { readMaintenance, resumeMaintenance } from './maintenance.ts';
import { insertSkillPart, type ChatSkills, type InvokedSkill } from './skill-invocations.ts';
import {
  archiveChatSchema,
  chatDestinationSchema,
  chatSchema,
  deleteChatSchema,
  destinationQuerySchema,
  fileAudienceQuerySchema,
  ConversationConflict,
  createChatSchema,
  moveChatSchema,
  historyQuerySchema,
  initialTitle,
  listQuerySchema,
  renameChatSchema,
  sendMessageSchema,
  messageSchema,
  controlTurnSchema,
  controlResultSchema,
  turnStatusSchema,
  toolReceiptSchema,
  timeZoneSchema,
} from './contracts.ts';

export {
  ConversationConflict,
  createChatSchema,
  moveChatSchema,
  sendMessageSchema,
  renameChatSchema,
  archiveChatSchema,
  deleteChatSchema,
} from './contracts.ts';
type Runtime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
const chatColumns = `id, title, title_revision AS "titleRevision", title_manual AS "titleManual", archived_at IS NOT NULL AS archived, COALESCE((to_jsonb(c)->>'is_closed')::boolean,false) AS "isClosed",
  to_char(activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "activityAt",
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"`;
const identitySchema = z.object({ id: uuidSchema });
const sentSchema = z.object({
  messageId: uuidSchema,
  turnId: uuidSchema,
  sequence: z.number().int().positive(),
  timeZone: timeZoneSchema.optional(),
});
const revisionSchema = z.object({ titleRevision: z.number().int().nonnegative() });
const archivedSchema = z.object({ archived: z.boolean() });
const movedSchema = z.object({ projectId: uuidSchema });
const hiddenReply = 'This reply is hidden because it uses information you cannot access.';
export const knowledgeUnavailableReply =
  'This reply is unavailable because a knowledge source it cited changed or your access to it ended. Search knowledge again to make a new request.';
const createdFileOutput = z.object({ result: z.object({ file: z.object({ id: uuidSchema }) }) });
function skillImportOutput(row: { tool: string; status: string; output?: unknown }) {
  if (
    row.status !== 'completed' ||
    !['skills.draft', 'skills.import', 'skills.import.status', 'skills.import.select'].includes(row.tool)
  )
    return {};
  const output = z.object({ result: z.object({ importId: uuidSchema }) }).safeParse(row.output);
  return output.success ? { importId: output.data.result.importId } : {};
}
/** The Files item a completed files.create call published. The card reads it under the viewer's own Files access. */
function createdFile(row: { tool: string; status: string; output?: unknown }) {
  if (row.tool === 'skills.execute' && row.status === 'completed') {
    const output = z
      .object({
        result: z.object({ status: z.literal('completed'), files: z.array(z.object({ id: uuidSchema })).max(64) }),
      })
      .safeParse(row.output);
    return output.success ? { fileIds: output.data.result.files.map(file => file.id) } : {};
  }
  const output =
    row.tool === 'files.create' && row.status === 'completed' ? createdFileOutput.safeParse(row.output) : null;
  return output?.success ? { fileId: output.data.result.file.id } : {};
}
const contextLimitCodes = new Set([
  'context-limit',
  'compaction-failed',
  'compaction-paused',
  'model-context-overflow',
]);
const compactionParts = (
  tx: AuthorizationTransaction,
) => `WHEN 'compact' THEN jsonb_build_object('kind', p.kind, 'prompt', p.text, 'compactionId', to_jsonb(p)->>'compaction_id')
  WHEN 'compaction' THEN (SELECT jsonb_build_object('kind', p.kind, 'compactionId', c.id, 'trigger', c.trigger, 'state', c.state, 'beforeTokens', c.before_tokens, 'afterTokens', c.after_tokens,
    'windowTokens', c.window_tokens, 'errorCode', c.error_code, 'handoffStatus', h.status) FROM ${qualified(tx.schema, 'tf_conversation_compactions')} c
    LEFT JOIN ${qualified(tx.schema, 'tf_conversation_handoffs')} h ON h.compaction_id=c.id WHERE c.id=(to_jsonb(p)->>'compaction_id')::uuid)`;
const skillReference = `jsonb_build_object('kind', p.kind, 'skillId', to_jsonb(p)->>'skill_id', 'revision', to_jsonb(p)->>'skill_revision', 'name', to_jsonb(p)->>'skill_name')`;

export function createConversations(runtime: Runtime, skills?: ChatSkills) {
  async function allowance(tx: AuthorizationTransaction) {
    try {
      await requireCredits(tx);
    } catch (error) {
      if (error instanceof CreditsExhausted) throw new ConversationConflict('credits-exhausted');
      throw error;
    }
  }
  async function human<T>(
    workspaceId: string,
    userId: string,
    operation: (tx: AuthorizationTransaction & { commonVersion: number }, actor: HumanActor) => Promise<T>,
    lock: 'read' | 'write' = 'read',
  ) {
    return runtime.transaction(workspaceId, commonCompatibility, async tx => {
      await lockAuthorization(tx, lock);
      return operation(bindFileSources(tx), await resolveHuman(tx, userId));
    });
  }

  async function owned(
    tx: AuthorizationTransaction,
    actor: HumanActor,
    chatId: string,
    write = false,
    rule: ChatAccessRule = 'read',
  ) {
    if (
      (await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_slack_default_turns')} WHERE conversation_id=$1`, [chatId]))
        .rowCount
    )
      throw new AccessDenied();
    const row = (
      await tx.client.query(
        `SELECT ${chatColumns}, project_id AS "projectId", next_message_sequence AS "nextSequence",
      (owner_user_id = $2 AND owner_membership_id = $3) AS owner
      FROM ${table(tx, 'tf_conversations')} c WHERE id = $1 AND kind = 'private' AND deleted_at IS NULL ${write ? 'FOR UPDATE' : ''}`,
        [chatId, actor.userId, actor.membershipId],
      )
    ).rows[0];
    if (!row) throw new AccessDenied();
    const chat = chatSchema
      .extend({ nextSequence: z.number().int(), titleManual: z.boolean(), owner: z.boolean() })
      .parse(row);
    await authorizeChat(tx, actor, chat, rule);
    return chat;
  }
  async function activeProject(tx: AuthorizationTransaction, actor: HumanActor, projectId: string) {
    if ((await requireProjectAccess(tx, actor, projectId)).archived) throw new ConversationConflict('project-archived');
  }

  async function command<T>(
    tx: AuthorizationTransaction,
    actor: HumanActor,
    chatId: string,
    commandId: string,
    operation: string,
    input: unknown,
    resultSchema: z.ZodType<T>,
    execute: () => Promise<T>,
    creating = false,
    allowDeletedReplay = false,
  ): Promise<T> {
    await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 184735))', [
      `${tx.schema}:${actor.membershipId}:${commandId}`,
    ]);
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const prior = z
      .object({ operation: z.string(), conversation_id: uuidSchema, input_digest: z.string(), outcome: z.unknown() })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT operation, conversation_id, input_digest, outcome FROM ${table(tx, 'tf_conversation_commands')} WHERE membership_id = $1 AND command_id = $2`,
            [actor.membershipId, commandId],
          )
        ).rows[0],
      );
    if (prior) {
      if (prior.operation !== operation || prior.conversation_id !== chatId || prior.input_digest !== digest)
        throw new ConversationConflict('command-conflict');
      if (creating || !allowDeletedReplay) await owned(tx, actor, chatId);
      else if (
        !(
          await tx.client.query(
            `SELECT 1 FROM ${table(tx, 'tf_conversations')} WHERE id = $1 AND owner_user_id = $2 AND owner_membership_id = $3`,
            [chatId, actor.userId, actor.membershipId],
          )
        ).rowCount
      )
        throw new AccessDenied();
      return resultSchema.parse(prior.outcome);
    }
    if (!creating) await owned(tx, actor, chatId, true);
    const outcome = await execute();
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_conversation_commands')} (membership_id, command_id, operation, conversation_id, input_digest, outcome) VALUES ($1,$2,$3,$4,$5,$6)`,
      [actor.membershipId, commandId, operation, chatId, digest, outcome],
    );
    return outcome;
  }

  async function create(workspaceId: string, userId: string, value: unknown) {
    const input = createChatSchema.parse(value);
    return human(workspaceId, userId, (tx, actor) =>
      command(
        tx,
        actor,
        input.chatId,
        input.commandId,
        'create',
        input,
        identitySchema,
        async () => {
          if (input.projectId) await activeProject(tx, actor, input.projectId);
          const inserted = input.projectId
            ? await tx.client.query(
                `INSERT INTO ${table(tx, 'tf_conversations')} (id, owner_user_id, owner_membership_id, project_id) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING id`,
                [input.chatId, actor.userId, actor.membershipId, input.projectId],
              )
            : await tx.client.query(
                `INSERT INTO ${table(tx, 'tf_conversations')} (id, owner_user_id, owner_membership_id) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING RETURNING id`,
                [input.chatId, actor.userId, actor.membershipId],
              );
          if (!inserted.rowCount) {
            await owned(tx, actor, input.chatId);
            throw new ConversationConflict('identity-conflict');
          }
          await allowance(tx);
          await notifyConversationChange(tx, { workspaceId, conversationId: input.chatId });
          return { id: input.chatId };
        },
        true,
      ),
    );
  }

  /** `recorded` runs only in the call that records the send, never in a replay of its command. */
  async function send(workspaceId: string, userId: string, chatIdInput: string, value: unknown, recorded?: () => void) {
    return human(
      workspaceId,
      userId,
      (tx, actor) => sendInTransaction(tx, actor, workspaceId, chatIdInput, value, recorded),
      'write',
    );
  }

  async function sendInTransaction(
    tx: AuthorizationTransaction & { commonVersion: number },
    actor: HumanActor,
    workspaceId: string,
    chatIdInput: string,
    value: unknown,
    recorded?: () => void,
  ) {
    const chatId = uuidSchema.parse(chatIdInput);
    const input = sendMessageSchema.parse(value);
    if (input.mode === 'plan' && tx.commonVersion < 1) throw new StorageUnavailableError('incompatible_version');
    return command(tx, actor, chatId, input.commandId, 'send', input, sentSchema, async () => {
      await allowance(tx);
      const chat = await owned(tx, actor, chatId, true, 'turn');
      const attachments = input.parts.flatMap(part => (part.kind === 'attachment' ? [part.attachmentId] : [])).sort();
      if (attachments.length) {
        for (const id of attachments) {
          const row = (
            await tx.client.query(
              `SELECT id FROM ${table(tx, 'tf_conversation_attachments')} WHERE id = $1 AND conversation_id = $2 AND membership_id = $3 AND state = 'ready' AND expires_at > clock_timestamp() FOR UPDATE`,
              [id, chatId, actor.membershipId],
            )
          ).rows[0];
          if (!row) throw new AttachmentError('attachment-conflict');
        }
      }
      const files = input.parts.flatMap(part => (part.kind === 'file' ? [part.fileId] : []));
      if (files.length) {
        await admitFileReferences(tx, actor, chat.projectId, files);
        for (const fileId of files) await recordFileUse(tx, actor, fileId);
      }
      const google = input.parts.flatMap(part => (part.kind === 'google-file' ? [part] : []));
      if (google.length) {
        await admitGoogleFileReferences(
          tx,
          actor,
          chat.projectId,
          google.map(part => part.expectedIntegration),
        );
      }
      const invocation = input.parts.find(part => part.kind === 'skill');
      let skill: InvokedSkill | null = null;
      if (invocation) {
        if (!skills) throw new StorageUnavailableError('incompatible_version');
        skill = chat.projectId ? null : await skills.resolve(tx, actor, invocation);
        if (!skill) throw new ConversationConflict('skill-unavailable');
      }
      const compact = input.parts.find(part => part.kind === 'compact');
      if (compact) {
        if (
          compact.compactionId &&
          !(
            await tx.client.query(
              `SELECT 1 FROM ${table(tx, 'tf_conversation_compactions')} WHERE conversation_id=$1 AND id=$2`,
              [chatId, compact.compactionId],
            )
          ).rowCount
        )
          throw new ConversationConflict('compaction-not-found');
      }
      const inserted = await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_conversation_messages')} (id, conversation_id, sequence, author_kind, membership_id) VALUES ($1,$2,$3,'human',$4) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [input.messageId, chatId, chat.nextSequence, actor.membershipId],
      );
      if (!inserted.rowCount) throw new ConversationConflict('identity-conflict');
      for (const [ordinal, part] of input.parts.entries()) {
        if (part.kind === 'text') {
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_conversation_parts')} (conversation_id, message_id, ordinal, kind, text, rich_content) VALUES ($1,$2,$3,'text',$4,$5)`,
            [chatId, input.messageId, ordinal, part.text, part.content ? JSON.stringify(part.content) : null],
          );
        } else if (part.kind === 'file')
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_conversation_parts')} (conversation_id, message_id, ordinal, kind, file_id) VALUES ($1,$2,$3,'file',$4)`,
            [chatId, input.messageId, ordinal, part.fileId],
          );
        else if (part.kind === 'compact')
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_conversation_parts')} (conversation_id, message_id, ordinal, kind, text, compaction_id) VALUES ($1,$2,$3,'compact',$4,$5)`,
            [chatId, input.messageId, ordinal, part.prompt ?? null, part.compactionId ?? null],
          );
        else if (part.kind === 'google-file')
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_conversation_parts')} (conversation_id, message_id, ordinal, kind, google_file) VALUES ($1,$2,$3,'google-file',$4)`,
            [
              chatId,
              input.messageId,
              ordinal,
              JSON.stringify({
                fileId: part.fileId,
                ...part.expectedIntegration,
                name: part.name,
                mimeType: part.mimeType,
              }),
            ],
          );
        else if (part.kind === 'attachment') {
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_conversation_parts')} (conversation_id, message_id, ordinal, kind, attachment_id) VALUES ($1,$2,$3,'attachment',$4)`,
            [chatId, input.messageId, ordinal, part.attachmentId],
          );
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_conversation_attachments')} SET state = 'bound', message_id = $2 WHERE id = $1`,
            [part.attachmentId, input.messageId],
          );
        } else if (skill) await insertSkillPart(tx, chatId, input.messageId, ordinal, 'skill', skill);
      }
      const responder = input.model;
      const turnId = randomUUID();
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_conversation_turns')} (id, conversation_id, source_message_id, accepted_sequence, responder${input.mode === 'plan' ? ', planning_mode' : ''}) VALUES ($1,$2,$3,$4,$5${input.mode === 'plan' ? ', true' : ''})`,
        [turnId, chatId, input.messageId, chat.nextSequence, responder],
      );
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_conversation_outbox')} (turn_id, conversation_id, generation) VALUES ($1,$2,0)`,
        [turnId, chatId],
      );
      if (tx.commonVersion >= 1) {
        await tx.client.query(
          `WITH interrupted AS (
          UPDATE ${table(tx, 'tf_conversation_turns')} SET status='queued',generation=generation+1,error_code=NULL,retry_at=NULL
          WHERE conversation_id=$1 AND status='waiting' AND error_code='plan-worker-waiting'
          RETURNING id,conversation_id,generation)
          INSERT INTO ${table(tx, 'tf_conversation_outbox')} (turn_id,conversation_id,generation)
          SELECT id,conversation_id,generation FROM interrupted`,
          [chatId],
        );
      }
      const title = chat.nextSequence === 1 && !chat.titleManual ? initialTitle(input.parts, skill?.name) : null;
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_conversations')} SET next_message_sequence = next_message_sequence + 1, activity_at = clock_timestamp(), title = COALESCE($2, title), title_revision = title_revision + CASE WHEN $2::text IS NULL THEN 0 ELSE 1 END WHERE id = $1`,
        [chatId, title],
      );
      await recordConversationActivity(tx, chatId);
      if (tx.commonVersion >= budCompatibility.minimum) {
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_bud_nudges')} SET status='answered'
          WHERE membership_id=$1 AND status='opened' AND fingerprint=(SELECT active_nudge FROM ${table(tx, 'tf_bud_state')} WHERE membership_id=$1 AND conversation_id=$2)`,
          [actor.membershipId, chatId],
        );
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_bud_state')} SET active_nudge=NULL WHERE membership_id=$1 AND conversation_id=$2`,
          [actor.membershipId, chatId],
        );
      }
      await notifyConversationChange(tx, { workspaceId, conversationId: chatId, turnId });
      recorded?.();
      return {
        messageId: input.messageId,
        turnId,
        sequence: chat.nextSequence,
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      };
    });
  }

  async function read(workspaceId: string, userId: string, chatId: string) {
    chatId = uuidSchema.parse(chatId);
    return human(workspaceId, userId, async (tx, actor) => {
      const chat = await owned(tx, actor, chatId);
      await requireConversationMcpSources(tx, actor, chatId);
      return chatSchema.parse(chat);
    });
  }

  async function compaction(workspaceId: string, userId: string, chatIdInput: string, compactionIdInput: string) {
    const chatId = uuidSchema.parse(chatIdInput);
    const compactionId = uuidSchema.parse(compactionIdInput);
    return human(workspaceId, userId, async (tx, actor) => {
      await owned(tx, actor, chatId);
      await requireConversationMcpSources(tx, actor, chatId);
      const detail = await readCompaction(tx, actor, chatId, compactionId);
      if (!detail) throw new AccessDenied();
      return detail;
    });
  }

  async function maintenance(workspaceId: string, userId: string, chatId: string) {
    return human(workspaceId, userId, async (tx, actor) => {
      await owned(tx, actor, uuidSchema.parse(chatId));
      if (tx.commonVersion < 1) return { maintenance: null };
      return readMaintenance(tx, chatId);
    });
  }

  async function resume(workspaceId: string, userId: string, chatId: string, value: unknown) {
    const input = z.strictObject({ commandId: uuidSchema }).parse(value);
    return human(workspaceId, userId, async (tx, actor) => {
      await owned(tx, actor, uuidSchema.parse(chatId), true, 'turn');
      if (tx.commonVersion < 1) throw new StorageUnavailableError('incompatible_version');
      await resumeMaintenance(tx, actor, chatId, input.commandId);
      await notifyConversationChange(tx, { workspaceId, conversationId: chatId });
      return readMaintenance(tx, chatId);
    });
  }

  async function history(workspaceId: string, userId: string, chatIdInput: string, value: unknown = {}) {
    const chatId = uuidSchema.parse(chatIdInput);
    const input = historyQuerySchema.parse(value);
    return human(workspaceId, userId, async (tx, actor) => {
      const chat = await owned(tx, actor, chatId);
      await requireConversationMcpSources(tx, actor, chatId);
      const rows = z.array(messageSchema.extend({ createdAt: z.date() })).parse(
        (
          await tx.client.query(
            `SELECT m.id, m.sequence, m.author_kind AS author, m.created_at AS "createdAt",
        (SELECT jsonb_agg(CASE p.kind WHEN 'text' THEN jsonb_strip_nulls(jsonb_build_object('kind', p.kind, 'text', p.text, 'content', p.rich_content)) WHEN 'attachment' THEN jsonb_build_object('kind', p.kind, 'attachmentId', to_jsonb(p)->>'attachment_id') WHEN 'file' THEN jsonb_build_object('kind', p.kind, 'fileId', to_jsonb(p)->>'file_id') WHEN 'google-file' THEN jsonb_build_object('kind', p.kind, 'fileId', to_jsonb(p)->'google_file'->>'fileId', 'name', to_jsonb(p)->'google_file'->>'name', 'mimeType', to_jsonb(p)->'google_file'->>'mimeType') WHEN 'request' THEN jsonb_build_object('kind', p.kind, 'requestId', to_jsonb(p)->>'request_id') WHEN 'response' THEN jsonb_build_object('kind', p.kind, 'responseId', to_jsonb(p)->>'response_id') WHEN 'skill' THEN ${skillReference} WHEN 'skill-use' THEN ${skillReference} ${compactionParts(tx)} ELSE jsonb_build_object('kind', p.kind, 'approvalId', to_jsonb(p)->>'approval_id') END ORDER BY p.ordinal) FROM ${table(tx, 'tf_conversation_parts')} p WHERE p.message_id = m.id) AS parts,
        CASE WHEN t.id IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object('id', t.id, 'status', t.status, 'generation', t.generation, 'epoch', t.attempt_epoch, 'errorCode', t.error_code, 'mode', CASE WHEN (to_jsonb(t)->>'planning_mode')::boolean THEN 'plan' END)) END AS turn
        FROM ${table(tx, 'tf_conversation_messages')} m LEFT JOIN ${table(tx, 'tf_conversation_turns')} t ON t.source_message_id = m.id
        WHERE m.conversation_id = $1 AND ($2::integer IS NULL OR m.sequence < $2) ORDER BY m.sequence DESC LIMIT 51`,
            [chatId, input.before ?? null],
          )
        ).rows,
      );
      const messages = rows
        .slice(0, 50)
        .reverse()
        .map(row => ({ ...row, createdAt: row.createdAt.toISOString() }));
      const calendar = await calendarResultsForHistory(
        tx,
        actor,
        chatId,
        messages.map(message => message.id),
      );
      for (const message of messages) message.calendarResults = calendar.get(message.id) ?? [];
      for (const message of messages) {
        const result = (
          await tx.client.query(`SELECT sources FROM ${table(tx, 'tf_conversation_results')} WHERE message_id=$1`, [
            message.id,
          ])
        ).rows[0];
        if (!result) continue;
        try {
          await requireGoogleSources(tx, actor, result.sources);
          await requireGoogleFileSources(tx, actor, result.sources);
        } catch (error) {
          if (!(error instanceof AccessDenied)) throw error;
          message.parts = [
            {
              kind: 'text',
              text: 'This reply is unavailable because its Google account or access changed. Reconnect Google and make a new request.',
            },
          ];
        }
      }
      for (const message of messages) {
        const result = (
          await tx.client.query(`SELECT sources FROM ${table(tx, 'tf_conversation_results')} WHERE message_id=$1`, [
            message.id,
          ])
        ).rows[0];
        if (!result) continue;
        try {
          await requireKnowledgeSources(tx, actor, result.sources);
        } catch (error) {
          if (!(error instanceof AccessDenied)) throw error;
          message.parts = [{ kind: 'text', text: knowledgeUnavailableReply }];
        }
      }
      for (const message of messages) {
        const result = (
          await tx.client.query(`SELECT sources FROM ${table(tx, 'tf_conversation_results')} WHERE message_id=$1`, [
            message.id,
          ])
        ).rows[0];
        if (!result) continue;
        try {
          await requireGitHubSources(tx, actor, result.sources);
        } catch (error) {
          if (!(error instanceof AccessDenied)) throw error;
          message.parts = [
            {
              kind: 'text',
              text: 'This reply is unavailable because its selected GitHub account or access changed. Select an active account to start fresh context.',
            },
          ];
        }
      }
      const hidden = new Set<string>();
      for (const message of messages) {
        const result = (
          await tx.client.query(`SELECT sources FROM ${table(tx, 'tf_conversation_results')} WHERE message_id=$1`, [
            message.id,
          ])
        ).rows[0];
        if (!result) continue;
        try {
          await requireWorkflowSources(tx, actor, result.sources);
        } catch (error) {
          if (!(error instanceof AccessDenied)) throw error;
          hidden.add(message.id);
          message.parts = [{ kind: 'text', text: hiddenReply }];
        }
      }
      if (chat.projectId) {
        for (const message of messages) {
          const result = (
            await tx.client.query(`SELECT sources FROM ${table(tx, 'tf_conversation_results')} WHERE message_id=$1`, [
              message.id,
            ])
          ).rows[0];
          if (!result) continue;
          try {
            await requireResultSources(tx, actor, chatId, result.sources);
          } catch (error) {
            if (!(error instanceof AccessDenied)) throw error;
            hidden.add(message.id);
            message.parts = [{ kind: 'text', text: hiddenReply }];
          }
        }
      }
      let hasGitHubProposals = false;
      hasGitHubProposals = !!(
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'tf_conversation_tool_calls')} c JOIN ${table(tx, 'tf_conversation_turns')} t ON t.id = c.turn_id WHERE t.conversation_id = $1 AND c.tool = 'github.personal.propose' LIMIT 1`,
          [chatId],
        )
      ).rowCount;
      for (const message of messages)
        if (message.turn) {
          const googleSafeActivity = `, CASE WHEN EXISTS (
          SELECT 1 FROM ${table(tx, 'tf_conversation_tool_calls')} c JOIN ${table(tx, 'tf_conversation_turns')} t ON t.id=c.turn_id
          WHERE t.conversation_id=$2 AND c.tool='google.read' AND t.accepted_sequence<=(SELECT accepted_sequence FROM ${table(tx, 'tf_conversation_turns')} WHERE id=$1)
         ) THEN NULL ELSE c.activity END AS activity, c.activity AS stored_activity`;
          const rows = (
            await tx.client.query(
              `SELECT c.id, c.tool, c.status${googleSafeActivity}, s.call, s.output, s.sources, g.id AS google_proposal_id, d.id AS row_draft_id FROM ${table(tx, 'tf_conversation_tool_calls')} c LEFT JOIN ${table(tx, 'tf_conversation_execution_steps')} s ON s.call_id=c.id AND s.turn_id=c.turn_id
          LEFT JOIN ${table(tx, 'tf_google_proposals')} g ON c.tool='google.propose' AND c.status='completed' AND g.command_id=c.id AND g.membership_id=$3 AND g.user_id=$4
          LEFT JOIN ${table(tx, 'tf_chat_authoring_drafts')} d ON c.tool IN ('rows.create','rows.update','rows.delete') AND c.status='completed' AND d.id=c.id AND d.proposal->>'kind'='row' AND d.membership_id=$3 AND d.user_id=$4
          WHERE c.turn_id = $1 AND c.conversation_id=$2 ORDER BY c.created_at, c.sequence, c.id`,
              [message.turn.id, chatId, actor.membershipId, actor.userId],
            )
          ).rows;
          message.tools = [];
          for (const row of rows) {
            let rowView = hidden.size ? undefined : rowViewForReceipt(row);
            if (rowView) {
              try {
                const outputSources = z.object({ sources: sourceDependenciesSchema }).parse(row.output).sources;
                await requireResultSources(tx, actor, chatId, [
                  ...(row.sources ?? []),
                  ...outputSources,
                  { kind: 'table-rows', tableId: rowView.tableId, revision: rowView.revision },
                ]);
              } catch (error) {
                if (!(error instanceof AccessDenied)) throw error;
                rowView = undefined;
              }
            }
            let rowChange = hidden.size ? undefined : rowChangeForReceipt(row);
            if (rowChange) {
              try {
                await requireResultSources(tx, actor, chatId, [
                  ...(row.sources ?? []),
                  { kind: 'table-rows', tableId: rowChange.tableId, revision: rowChange.revision },
                ]);
              } catch (error) {
                if (!(error instanceof AccessDenied)) throw error;
                rowChange = undefined;
              }
            }
            const workflows = hidden.size ? undefined : await workflowReferences(tx, actor, row);
            message.tools.push(
              toolReceiptSchema.parse({
                ...row,
                rowView,
                rowChange,
                workflows,
                activityStatus: await storedToolStatus(tx, row),
                presentation: hidden.size
                  ? toolPresentation(row.tool)
                  : await storedToolPresentation(tx, actor, row.tool, row.call, row.stored_activity, row.id),
                activity:
                  hidden.size || row.tool.startsWith('web.')
                    ? null
                    : (googleToolActivity(row.tool, row.call, row.stored_activity) ?? row.activity),
                web: await publicWebReceiptForHistory(tx, actor, {
                  tool: row.tool,
                  status: row.status,
                  call: row.call,
                  output: row.output,
                  sources: row.sources,
                }),
                knowledge: await knowledgeActivityForHistory(tx, actor, {
                  tool: row.tool,
                  status: row.status,
                  call: row.call,
                  output: row.output,
                  sources: row.sources,
                }),
                ...(hidden.size ? {} : { ...createdFile(row), ...skillImportOutput(row) }),
                ...(!hidden.size && row.google_proposal_id ? { googleProposalId: row.google_proposal_id } : {}),
                ...(!hidden.size && row.row_draft_id ? { rowDraftId: row.row_draft_id } : {}),
              }),
            );
          }
        }
      return { messages, nextBefore: rows.length > 50 ? (messages[0]?.sequence ?? null) : null, hasGitHubProposals };
    });
  }

  async function list(workspaceId: string, userId: string, value: unknown = {}) {
    const input = listQuerySchema.parse(value);
    return human(workspaceId, userId, async (tx, actor) => {
      if (input.projectId) await requireProjectAccess(tx, actor, input.projectId);
      const rows = z.array(chatSchema).parse(
        (
          await tx.client.query(
            `SELECT ${chatColumns}, project_id AS "projectId" FROM ${table(tx, 'tf_conversations')} c
        WHERE kind = 'private' AND deleted_at IS NULL AND (archived_at IS NOT NULL) = $3
        AND project_id IS NOT DISTINCT FROM $7::uuid AND ($7::uuid IS NOT NULL OR (owner_user_id = $1 AND owner_membership_id = $2))
        AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_slack_default_turns')} s WHERE s.conversation_id = c.id)
        AND position(lower($4) in lower(title)) > 0
        AND ($5::timestamptz IS NULL OR (activity_at, id) < ($5::timestamptz, $6::uuid))
        ORDER BY activity_at DESC, id DESC LIMIT 51`,
            [
              actor.userId,
              actor.membershipId,
              input.archived,
              input.query,
              input.cursor?.activityAt ?? null,
              input.cursor?.id ?? null,
              input.projectId ?? null,
            ],
          )
        ).rows,
      );
      const chats = [];
      for (const chat of rows.slice(0, 50)) {
        try {
          await requireConversationMcpSources(tx, actor, chat.id);
          chats.push(chat);
        } catch (error) {
          if (!(error instanceof AccessDenied)) throw error;
        }
      }
      const last = rows.slice(0, 50).at(-1);
      return { chats, nextCursor: rows.length > 50 && last ? { activityAt: last.activityAt, id: last.id } : null };
    });
  }

  /** Unarchived chats the requester can post in: their own private chats and chats of active projects they can open. */
  async function destinations(workspaceId: string, userId: string, value: unknown = {}) {
    const { query } = destinationQuerySchema.parse(value);
    return human(workspaceId, userId, async (tx, actor) => {
      const chats: z.infer<typeof chatDestinationSchema>[] = [];
      // The MCP-source check runs per chat after the query, so scan pages until 20 pass, bounded to keep the picker fast.
      let after: { activityAt: string; id: string } | null = null;
      for (let page = 0; page < 10 && chats.length < 20; page++) {
        const rows = z.array(chatDestinationSchema).parse(
          (
            await tx.client.query(
              `SELECT c.id, c.title, to_char(c.activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "activityAt",
            c.project_id AS "projectId", p.name AS "projectName"
          FROM ${table(tx, 'tf_conversations')} c LEFT JOIN ${table(tx, 'tf_projects')} p ON p.id = c.project_id
          WHERE c.kind = 'private' AND c.deleted_at IS NULL AND c.archived_at IS NULL
            AND ((c.project_id IS NULL AND c.owner_user_id = $1 AND c.owner_membership_id = $2)
              OR (c.project_id IS NOT NULL AND p.archived_at IS NULL AND EXISTS (SELECT 1 FROM ${table(tx, 'tf_project_members')} pm WHERE pm.project_id = p.id AND pm.membership_id = $2 AND pm.removed_at IS NULL)))
            AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_slack_default_turns')} s WHERE s.conversation_id = c.id)
            AND position(lower($3) in lower(c.title)) > 0
            AND ($4::timestamptz IS NULL OR (c.activity_at, c.id) < ($4::timestamptz, $5::uuid))
          ORDER BY c.activity_at DESC, c.id DESC LIMIT 20`,
              [actor.userId, actor.membershipId, query, after?.activityAt ?? null, after?.id ?? null],
            )
          ).rows,
        );
        for (const chat of rows) {
          if (chats.length === 20) break;
          try {
            await requireConversationMcpSources(tx, actor, chat.id);
            chats.push(chat);
          } catch (error) {
            if (!(error instanceof AccessDenied)) throw error;
          }
        }
        const last = rows.at(-1);
        if (rows.length < 20 || !last) break;
        after = { activityAt: last.activityAt, id: last.id };
      }
      return { chats };
    });
  }

  /** Before references enter a draft: can everyone who reads this chat open each file? Submission checks again. */
  async function fileAudience(workspaceId: string, userId: string, chatIdInput: string, value: unknown) {
    const chatId = uuidSchema.parse(chatIdInput);
    const { fileIds } = fileAudienceQuerySchema.parse(value);
    return human(workspaceId, userId, async (tx, actor) => {
      const chat = await owned(tx, actor, chatId, false, 'turn');
      return { projectId: chat.projectId, files: await resolveFileAudience(tx, actor, chat.projectId, fileIds) };
    });
  }

  async function rename(workspaceId: string, userId: string, chatIdInput: string, value: unknown) {
    const chatId = uuidSchema.parse(chatIdInput);
    const input = renameChatSchema.parse(value);
    return human(workspaceId, userId, (tx, actor) =>
      command(tx, actor, chatId, input.commandId, 'rename', input, revisionSchema, async () => {
        await owned(tx, actor, chatId, true, 'manage');
        const result = await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversations')} SET title = $2, title_revision = title_revision + 1, title_manual = true WHERE id = $1 AND title_revision = $3 RETURNING title_revision AS "titleRevision"`,
          [chatId, input.title, input.expectedRevision],
        );
        if (!result.rowCount) throw new ConversationConflict('title-conflict');
        return revisionSchema.parse(result.rows[0]);
      }),
    );
  }

  async function archive(workspaceId: string, userId: string, chatIdInput: string, value: unknown) {
    const chatId = uuidSchema.parse(chatIdInput);
    const input = archiveChatSchema.parse(value);
    return human(workspaceId, userId, (tx, actor) =>
      command(tx, actor, chatId, input.commandId, 'archive', input, archivedSchema, async () => {
        await owned(tx, actor, chatId, true, 'manage');
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversations')} SET archived_at = CASE WHEN $2 THEN COALESCE(archived_at, clock_timestamp()) ELSE NULL END WHERE id = $1`,
          [chatId, input.archived],
        );
        return { archived: input.archived };
      }),
    );
  }

  async function remove(workspaceId: string, userId: string, chatIdInput: string, value: unknown) {
    const chatId = uuidSchema.parse(chatIdInput);
    const input = deleteChatSchema.parse(value);
    return human(workspaceId, userId, (tx, actor) =>
      command(
        tx,
        actor,
        chatId,
        input.commandId,
        'delete',
        input,
        z.object({ deleted: z.literal(true) }),
        async () => {
          const chat = await owned(tx, actor, chatId, true, 'manage');
          if (!chat.owner) throw new AccessDenied();
          const turns = z.array(z.object({ id: uuidSchema })).parse(
            (
              await tx.client.query(
                `UPDATE ${table(tx, 'tf_conversation_turns')}
        SET status = 'cancelled', generation = generation + 1, attempt_epoch = attempt_epoch + 1, lease_until = NULL, retry_at = NULL, error_code = 'conversation-deleted'
        WHERE conversation_id = $1 AND status IN ('queued', 'processing', 'waiting', 'reconciling') RETURNING id`,
                [chatId],
              )
            ).rows,
          );
          for (const turn of turns) await interruptToolReceipts(tx, turn.id, 'failed');
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_conversations')} SET deleted_at = clock_timestamp() WHERE id = $1`,
            [chatId],
          );
          await clearBudConversation(tx, chatId, workspaceId);
          return { deleted: true as const };
        },
        false,
        true,
      ),
    );
  }

  async function control(
    workspaceId: string,
    userId: string,
    chatIdInput: string,
    turnIdInput: string,
    operation: 'retry' | 'cancel',
    value: unknown,
  ) {
    const chatId = uuidSchema.parse(chatIdInput);
    const turnId = uuidSchema.parse(turnIdInput);
    const input = controlTurnSchema.parse(value);
    return human(workspaceId, userId, (tx, actor) =>
      command(tx, actor, chatId, input.commandId, operation, { turnId, ...input }, controlResultSchema, async () => {
        await owned(tx, actor, chatId, true, 'turn');
        const turn = z
          .object({ status: turnStatusSchema, generation: z.number().int(), error_code: z.string().nullable() })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT status, generation, error_code FROM ${table(tx, 'tf_conversation_turns')} WHERE id = $1 AND conversation_id = $2 FOR UPDATE`,
                [turnId, chatId],
              )
            ).rows[0],
          );
        if (!turn) throw new AccessDenied();
        if (
          turn.generation !== input.expectedGeneration ||
          (operation === 'retry' ? turn.status !== 'failed' : !['queued', 'processing', 'failed'].includes(turn.status))
        )
          throw new ConversationConflict('turn-conflict');
        const status = operation === 'retry' ? 'queued' : 'cancelled';
        if (operation === 'retry') await allowance(tx);
        if (operation === 'retry') {
          await recordConversationActivity(tx, chatId, false);
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_conversation_working_summaries')} SET active=false
          WHERE conversation_id=$1 AND active AND covered_through >= (SELECT accepted_sequence FROM ${table(tx, 'tf_conversation_turns')} WHERE id=$2)`,
            [chatId, turnId],
          );
        }
        const generation = turn.generation + 1;
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversation_turns')} SET status = $2, generation = $3, attempt_epoch = attempt_epoch + 1, attempts = CASE WHEN $2 = 'queued' THEN 0 ELSE attempts END, lease_until = NULL, retry_at = NULL, error_code = NULL WHERE id = $1`,
          [turnId, status, generation],
        );
        await interruptToolReceipts(tx, turnId, 'failed');
        // Retrying a turn that stopped at the context limit asks the executor to compact first, even when automatic compaction is off or paused.
        if (operation === 'retry' && contextLimitCodes.has(turn.error_code ?? ''))
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_conversation_turns')} SET compaction_requested=true WHERE id=$1`,
            [turnId],
          );
        if (operation === 'retry')
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_conversation_outbox')} (turn_id, conversation_id, generation) VALUES ($1,$2,$3)`,
            [turnId, chatId, generation],
          );
        else
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_conversation_outbox')} SET next_attempt_at = clock_timestamp(), dispatched_at = NULL WHERE conversation_id = $1 AND turn_id = (SELECT id FROM ${table(tx, 'tf_conversation_turns')} WHERE conversation_id = $1 AND status NOT IN ('completed', 'cancelled', 'blocked') ORDER BY accepted_sequence LIMIT 1)`,
            [chatId],
          );
        await notifyConversationChange(tx, {
          workspaceId,
          conversationId: chatId,
          turnId,
          settled: status === 'cancelled',
        });
        return { turnId, status, generation };
      }),
    );
  }

  async function move(workspaceId: string, userId: string, chatIdInput: string, value: unknown) {
    const chatId = uuidSchema.parse(chatIdInput);
    const input = moveChatSchema.parse(value);
    return human(workspaceId, userId, (tx, actor) =>
      command(tx, actor, chatId, input.commandId, 'move', input, movedSchema, async () => {
        const chat = await owned(tx, actor, chatId, true, 'manage');
        if (!chat.owner || chat.projectId) throw new ConversationConflict('move-conflict');
        if (
          tx.commonVersion >= budCompatibility.minimum &&
          (await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_bud_state')} WHERE conversation_id=$1`, [chatId]))
            .rowCount
        )
          throw new ConversationConflict('move-conflict');
        if (tx.commonVersion >= budCompatibility.minimum)
          await tx.client.query(`DELETE FROM ${table(tx, 'tf_bud_preferences')} WHERE conversation_id=$1`, [chatId]);
        await activeProject(tx, actor, input.projectId);
        await tx.client.query(`UPDATE ${table(tx, 'tf_conversations')} SET project_id = $2 WHERE id = $1`, [
          chatId,
          input.projectId,
        ]);
        return { projectId: input.projectId };
      }),
    );
  }

  return {
    create,
    send,
    sendInTransaction,
    read,
    compaction,
    maintenance,
    resumeMaintenance: resume,
    history,
    list,
    destinations,
    fileAudience,
    rename,
    archive,
    remove,
    move,
    retry: (workspaceId: string, userId: string, chatId: string, turnId: string, value: unknown) =>
      control(workspaceId, userId, chatId, turnId, 'retry', value),
    cancel: (workspaceId: string, userId: string, chatId: string, turnId: string, value: unknown) =>
      control(workspaceId, userId, chatId, turnId, 'cancel', value),
  };
}
