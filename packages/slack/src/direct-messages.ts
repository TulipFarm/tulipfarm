import { randomUUID } from 'node:crypto';
import { slackCredentialsReady } from './recovery.ts';
import { z } from 'zod';
import { AccessDenied, currentMember, lockAuthorization, type HumanActor } from '@tulipfarm/access';
import { requireSlackInstallationUse } from './installation-access.ts';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createConversations, ConversationConflict } from '@tulipfarm/conversations';
import { CreditsExhausted, requireCredits } from '@tulipfarm/workspace-storage/credits';
import { textPartSchema } from '@tulipfarm/conversations/contracts';
import { requireResultSources, requireSlackTurn } from '@tulipfarm/conversations/source-access';
import { messageSchema, slackId } from './contracts.ts';
import { slackPromptWorkSchema, type SlackPromptWork } from './link-prompts.ts';
import type { SlackRuntime } from './installations.ts';
import type { slackCredentialCipher } from './credentials.ts';
import { postBotMessage, type BotMessageOutcome } from './bot-message.ts';
import { currentSlackMessage } from './message-source.ts';
import { slackMessageText, slackMessageTextWithFiles } from './message-content.ts';
import { createAttachments } from '@tulipfarm/conversations/attachments';
import {
  discardSlackFiles,
  stageSlackFiles,
  unreadSlackFileLine,
  type SlackFileReading,
  type SlackFileShare,
} from './shared-files.ts';

type Transaction = Parameters<Parameters<SlackRuntime['transaction']>[2]>[0];
const compatibility = commonCompatibility;
/** A message that cannot be admitted yet: its sender is not allowed now, or the workspace is out of credits. */
const held = (error: unknown) =>
  error instanceof AccessDenied ||
  error instanceof CreditsExhausted ||
  (error instanceof ConversationConflict && error.code === 'credits-exhausted');
const bindingSchema = z.object({
  conversation_id: z.uuid(),
  turn_id: z.uuid(),
  identity_id: z.uuid(),
  user_id: z.string(),
  membership_id: z.uuid(),
  installation_id: z.uuid(),
  generation: z.number().int(),
  channel: slackId,
  root_ts: z.string(),
  bot_credential: z.unknown(),
  state: z.enum(['pending', 'sending', 'retry', 'sent', 'unknown', 'blocked']),
  attempt_id: z.uuid().nullable(),
  due: z.boolean(),
  status: z.string(),
  sources: z.unknown(),
  text: z.string().nullable(),
});

export function createSlackDirectMessages(options: {
  runtime: SlackRuntime;
  appId: string;
  cipher: ReturnType<typeof slackCredentialCipher>;
  fetcher?: typeof fetch;
  modelFamilyId?: string;
  /** Reads shared files as attachments while the `images` flag is on; without it files are named, not read. */
  files?: SlackFileReading;
}) {
  const { runtime, cipher, files: reading } = options;
  const shared = reading && createAttachments(runtime, reading.bytes);
  const appId = slackId.parse(options.appId);
  async function transaction<T>(workspaceId: string, operation: (tx: Transaction) => Promise<T>) {
    return runtime.transaction(z.uuid().parse(workspaceId), compatibility, async tx => {
      await lockAuthorization(tx, 'write');
      return operation(tx);
    });
  }
  /**
   * Admits one held message as a chat turn. With `files` set to 'defer', a message that shares files is checked but
   * not admitted, returning 'files' so its files are downloaded outside the dispatch pass. With 'failed', every
   * shared file is named as not read. `adopted` collects the object keys of staged files that became attachments.
   */
  async function admit(
    workspaceId: string,
    eventId: string,
    files: SlackFileShare | 'defer' | 'failed' | null,
    adopted = new Set<string>(),
  ) {
    return transaction(workspaceId, async (tx): Promise<boolean | 'files'> => {
      const table = (name: string) => qualified(tx.schema, name);
      await tx.client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,93572))`, [`${tx.schema}:${eventId}`]);
      const event = z
        .object({ installation_id: z.uuid(), generation: z.number().int(), payload: z.unknown() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT e.* FROM ${table('tf_slack_events')} e WHERE e.id=$1 AND e.disposition='held'`,
              [eventId],
            )
          ).rows[0],
        );
      if (!event) return false;
      const parsed = messageSchema.safeParse(event.payload);
      const reject = (reason: 'invalid-message' | 'root-owner-mismatch') =>
        tx.client.query(
          `INSERT INTO ${table('tf_slack_dm_rejections')} (event_id,reason) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [eventId, reason],
        );
      if (!parsed.success) {
        await reject('invalid-message');
        return false;
      }
      let message = parsed.data;
      try {
        message = await currentSlackMessage(tx, eventId);
      } catch (error) {
        if (!(error instanceof AccessDenied)) throw error;
        await reject('invalid-message');
        return false;
      }
      if (
        message.thread_ts &&
        (
          await tx.client.query(
            `SELECT 1 FROM ${table('tf_slack_agent_branches')} WHERE dm_channel=$1 AND dm_root=$2`,
            [message.channel, message.thread_ts],
          )
        ).rowCount
      )
        return false;
      const share =
        files === 'failed'
          ? {
              staged: [],
              unread: (message.shared_files ?? []).map(file => ({ file, reason: unreadSlackFileLine(file, 'failed') })),
            }
          : files === 'defer'
            ? null
            : files;
      // Files that are read leave the text as attachments; files that are not keep a line naming why.
      const unread = (share?.unread ?? []).map(({ file, reason }) => ({ line: file.line, replacement: reason }));
      const read = (share?.staged ?? []).map(({ file }) => ({ line: file.line, replacement: '' }));
      let text = share ? slackMessageTextWithFiles(message, [...unread, ...read]) : slackMessageText(message);
      if (
        message.type !== 'message' ||
        message.bot_id ||
        (message.subtype && message.subtype !== 'file_share') ||
        !message.channel.startsWith('D') ||
        (!text.trim() && !share?.staged.length) ||
        (text.trim() && !textPartSchema.safeParse({ kind: 'text', text }).success)
      ) {
        await reject('invalid-message');
        return false;
      }
      const installation = await tx.client.query(
        `SELECT 1 FROM ${table('tf_slack_installations')} WHERE id=$1 AND generation=$2 AND app_id=$3 AND state='active' AND 'chat:write'=ANY(scopes) AND bot_user_id<>$4 FOR UPDATE`,
        [event.installation_id, event.generation, appId, message.user],
      );
      if (!installation.rowCount) return false;
      const identity = z
        .object({ id: z.uuid(), user_id: z.string(), membership_id: z.uuid() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT * FROM ${table('tf_slack_identities')} i WHERE installation_id=$1 AND generation=$2 AND slack_user_id=$3 AND state='authorized' AND credential IS NOT NULL AND 'im:history'=ANY(scopes)
        AND NOT EXISTS (SELECT 1 FROM ${table('tf_slack_user_revocations')} v WHERE v.installation_id=i.installation_id AND v.generation=i.generation AND v.slack_user_id=i.slack_user_id)`,
              [event.installation_id, event.generation, message.user],
            )
          ).rows[0],
        );
      if (!identity) return false;
      await currentMember(tx, { kind: 'human', userId: identity.user_id, membershipId: identity.membership_id });
      await requireSlackInstallationUse(
        tx,
        { kind: 'human', userId: identity.user_id, membershipId: identity.membership_id },
        event.installation_id,
      );
      if ((await tx.client.query(`SELECT 1 FROM ${table('tf_slack_dm_events')} WHERE event_id=$1`, [eventId])).rowCount)
        return false;
      const rootTs = message.thread_ts ?? message.ts;
      await tx.client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,93571))`, [
        `${tx.schema}:${event.installation_id}:${event.generation}:${message.channel}:${rootTs}`,
      ]);
      const prior = z
        .object({ conversation_id: z.uuid(), identity_id: z.uuid() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT * FROM ${table('tf_slack_dm_roots')} WHERE installation_id=$1 AND generation=$2 AND channel=$3 AND root_ts=$4`,
              [event.installation_id, event.generation, message.channel, rootTs],
            )
          ).rows[0],
        );
      if (prior && prior.identity_id !== identity.id) {
        await reject('root-owner-mismatch');
        return false;
      }
      if (files === 'defer' && message.shared_files?.length) {
        await requireCredits(tx);
        return 'files';
      }
      const bound: SlackRuntime = {
        transaction: async (workspace, range, action) => {
          if (workspace !== workspaceId || tx.commonVersion < range.minimum || tx.commonVersion > range.maximum)
            throw new AccessDenied();
          return action(tx);
        },
      };
      const conversations = createConversations(bound);
      const conversationId = prior?.conversation_id ?? randomUUID();
      if (!prior) {
        await conversations.create(workspaceId, identity.user_id, { chatId: conversationId, commandId: randomUUID() });
        await tx.client.query(
          `INSERT INTO ${table('tf_slack_dm_roots')} (conversation_id,identity_id,installation_id,generation,channel,root_ts) VALUES ($1,$2,$3,$4,$5,$6)`,
          [conversationId, identity.id, event.installation_id, event.generation, message.channel, rootTs],
        );
      }
      const attachmentIds: string[] = [];
      if (reading && share?.staged.length) {
        const attachments = createAttachments(bound, reading.bytes);
        const full: string[] = [];
        for (const { file, staged } of share.staged) {
          const id = randomUUID();
          if (await attachments.adoptShared(workspaceId, identity.user_id, conversationId, id, staged)) {
            attachmentIds.push(id);
            adopted.add(staged.objectKey);
          } else full.push(unreadSlackFileLine(file, 'storage-full'));
        }
        text = [text, ...full].filter(Boolean).join('\n');
      }
      const sent = await conversations.send(workspaceId, identity.user_id, conversationId, {
        commandId: eventId,
        messageId: eventId,
        ...(options.modelFamilyId ? { model: options.modelFamilyId } : {}),
        parts: [
          ...(text.trim() ? [{ kind: 'text' as const, text }] : []),
          ...attachmentIds.map(attachmentId => ({ kind: 'attachment' as const, attachmentId })),
        ],
      });
      await tx.client.query(
        `INSERT INTO ${table('tf_slack_dm_events')} (event_id,conversation_id,turn_id) VALUES ($1,$2,$3)`,
        [eventId, conversationId, sent.turnId],
      );
      await tx.client.query(
        `INSERT INTO ${table('tf_slack_continuations')} (event_id,identity_id,state) VALUES ($1,$2,'dispatch-held') ON CONFLICT DO NOTHING`,
        [eventId, identity.id],
      );
      return true;
    });
  }
  /**
   * Admits held messages without downloading anything. A message that shares files while reading them is on is
   * returned instead, for `admitFiles` to download and admit in its own activity; later messages in its thread wait
   * for it. One message's failure is reported without holding up messages in other threads.
   */
  async function admitPending(workspaceId: string) {
    const candidates = await transaction(workspaceId, async tx =>
      z.array(z.object({ id: z.uuid(), root: z.string().nullable() })).parse(
        (
          await tx.client.query(
            `SELECT e.id,(e.payload->>'channel')||':'||COALESCE(e.payload->>'thread_ts',e.payload->>'ts') AS root FROM ${qualified(tx.schema, 'tf_slack_events')} e
      JOIN ${qualified(tx.schema, 'tf_slack_identities')} i ON i.installation_id=e.installation_id AND i.generation=e.generation AND i.slack_user_id=e.payload->>'user'
      JOIN ${qualified(tx.schema, 'tf_slack_installations')} s ON s.id=e.installation_id AND s.generation=e.generation
      JOIN ${qualified(tx.schema, 'tf_memberships')} m ON m.id=i.membership_id AND m.user_id=i.user_id AND m.removed_at IS NULL
      WHERE e.disposition='held' AND e.payload->>'channel' LIKE 'D%' AND e.payload->>'type'='message' AND i.state='authorized' AND s.state='active' AND s.app_id=$1
      AND 'im:history'=ANY(i.scopes) AND 'chat:write'=ANY(s.scopes)
      AND NOT EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_slack_user_revocations')} v WHERE v.installation_id=i.installation_id AND v.generation=i.generation AND v.slack_user_id=i.slack_user_id)
      AND NOT EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_slack_dm_events')} d WHERE d.event_id=e.id)
      AND NOT EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_slack_dm_rejections')} r WHERE r.event_id=e.id)
      ORDER BY e.created_at,e.id LIMIT 50`,
            [appId],
          )
        ).rows,
      ),
    );
    const reads = Boolean(reading && (await reading.enabled(workspaceId)));
    const files: SlackPromptWork[] = [];
    const failures: unknown[] = [];
    const waiting = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.root && waiting.has(candidate.root)) continue;
      try {
        if ((await admit(workspaceId, candidate.id, reads ? 'defer' : null)) !== 'files') continue;
        files.push({ workspaceId, eventId: candidate.id });
      } catch (error) {
        if (held(error)) continue;
        failures.push(error);
      }
      if (candidate.root) waiting.add(candidate.root);
    }
    return { files, failures };
  }
  /**
   * Downloads the files shared in one held message, stores them, and admits the message with them as attachments.
   * Bytes that did not become an attachment are removed, whatever the outcome.
   */
  async function admitFiles(value: unknown) {
    const work = slackPromptWorkSchema.parse(value);
    const share =
      reading && shared && (await reading.enabled(work.workspaceId))
        ? await stageSlackFiles({
            runtime,
            cipher,
            attachments: shared,
            fetcher: options.fetcher ?? fetch,
            workspaceId: work.workspaceId,
            eventId: work.eventId,
          })
        : null;
    const adopted = new Set<string>();
    try {
      return (await admit(work.workspaceId, work.eventId, share, adopted)) === true;
    } catch (error) {
      if (held(error)) return false;
      throw error;
    } finally {
      if (shared && share) await discardSlackFiles(shared, work.workspaceId, share, adopted);
    }
  }
  /**
   * Admits a held message whose files could not be read on any attempt, with each file named as not read, so the
   * sender gets a reply and later messages in its thread are no longer held behind it.
   */
  async function admitUnreadFiles(value: unknown) {
    const work = slackPromptWorkSchema.parse(value);
    try {
      return (await admit(work.workspaceId, work.eventId, 'failed')) === true;
    } catch (error) {
      if (held(error)) return false;
      throw error;
    }
  }
  async function due(workspaceId: string): Promise<SlackPromptWork[]> {
    return transaction(workspaceId, async tx => {
      const rows = z
        .array(z.object({ event_id: z.uuid() }))
        .parse(
          (
            await tx.client.query(
              `SELECT d.event_id FROM ${qualified(tx.schema, 'tf_slack_dm_events')} d JOIN ${qualified(tx.schema, 'tf_conversation_turns')} t ON t.id=d.turn_id WHERE d.state IN ('pending','sending','retry') AND d.next_attempt_at<=clock_timestamp() AND t.status IN ('completed','blocked','failed','cancelled') ORDER BY d.next_attempt_at,d.event_id LIMIT 50`,
            )
          ).rows,
        );
      return rows.map(row => ({ workspaceId, eventId: row.event_id }));
    });
  }
  async function discover(workspaceId: string): Promise<SlackPromptWork[]> {
    const { failures } = await admitPending(workspaceId);
    if (failures.length) throw new AggregateError(failures, 'slack-dm-admission-incomplete');
    return due(workspaceId);
  }
  async function load(tx: Transaction, eventId: string) {
    const table = (name: string) => qualified(tx.schema, name);
    return bindingSchema.optional().parse(
      (
        await tx.client.query(
          `SELECT d.*,r.identity_id,r.installation_id,r.generation,r.channel,r.root_ts,i.user_id,i.membership_id,s.bot_credential,t.status,v.sources,
      d.next_attempt_at<=clock_timestamp() AS due,
      (SELECT string_agg(p.text,'' ORDER BY p.ordinal) FROM ${table('tf_conversation_parts')} p WHERE p.message_id=t.response_message_id AND p.kind IN ('text','layout')) AS text
      FROM ${table('tf_slack_dm_events')} d JOIN ${table('tf_slack_dm_roots')} r ON r.conversation_id=d.conversation_id
      JOIN ${table('tf_slack_identities')} i ON i.id=r.identity_id JOIN ${table('tf_slack_installations')} s ON s.id=r.installation_id
      JOIN ${table('tf_conversation_turns')} t ON t.id=d.turn_id LEFT JOIN ${table('tf_conversation_results')} v ON v.turn_id=t.id AND v.message_id=t.response_message_id
      WHERE d.event_id=$1 AND s.app_id=$2 FOR UPDATE OF d`,
          [eventId, appId],
        )
      ).rows[0],
    );
  }
  async function process(value: unknown): Promise<'idle' | 'sent' | 'retry' | 'unknown' | 'blocked'> {
    const work = slackPromptWorkSchema.parse(value),
      attemptId = randomUUID();
    if (!(await slackCredentialsReady(runtime, work))) return 'idle';
    const claim = await transaction(work.workspaceId, async tx => {
      const row = await load(tx, work.eventId);
      if (!row || !row.due || !['pending', 'sending', 'retry'].includes(row.state)) return false;
      if (row.state === 'sending') {
        await tx.client.query(
          `UPDATE ${qualified(tx.schema, 'tf_slack_dm_events')} SET state='unknown' WHERE event_id=$1`,
          [work.eventId],
        );
        return false;
      }
      if (!['completed', 'blocked', 'failed', 'cancelled'].includes(row.status)) return false;
      await tx.client.query(
        `UPDATE ${qualified(tx.schema, 'tf_slack_dm_events')} SET state='sending',attempt_id=$2,next_attempt_at=clock_timestamp()+interval '30 seconds' WHERE event_id=$1`,
        [work.eventId, attemptId],
      );
      return true;
    });
    if (!claim) return 'idle';
    return transaction(work.workspaceId, async tx => {
      const row = await load(tx, work.eventId);
      if (!row || row.state !== 'sending' || row.attempt_id !== attemptId) return 'idle';
      let outcome: BotMessageOutcome = { kind: 'blocked' };
      const actor: HumanActor = { kind: 'human', userId: row.user_id, membershipId: row.membership_id };
      try {
        await currentMember(tx, actor);
        await requireSlackInstallationUse(tx, actor, row.installation_id);
        await requireSlackTurn(tx, actor, row.conversation_id, row.turn_id);
        if (row.status === 'completed' && row.text)
          await requireResultSources(tx, actor, row.conversation_id, row.sources);
        const text =
          row.status === 'completed'
            ? row.text
            : 'I could not finish this request safely. It has not been automatically repeated. Review the request in TulipFarm before trying again.';
        if (text)
          outcome = await postBotMessage({
            token: cipher.decrypt(
              {
                workspaceId: work.workspaceId,
                installationId: row.installation_id,
                generation: row.generation,
                kind: 'bot',
              },
              row.bot_credential,
            ),
            channel: row.channel,
            rootTs: row.root_ts,
            text,
            fetcher: options.fetcher ?? fetch,
          });
      } catch (error) {
        if (!(error instanceof AccessDenied)) throw error;
      }
      await tx.client.query(
        `UPDATE ${qualified(tx.schema, 'tf_slack_dm_events')} SET state=$2,next_attempt_at=clock_timestamp()+$3*interval '1 second',delivered_ts=$4 WHERE event_id=$1`,
        [
          work.eventId,
          outcome.kind,
          outcome.kind === 'retry' ? outcome.seconds : 0,
          outcome.kind === 'sent' ? outcome.ts : null,
        ],
      );
      return outcome.kind;
    });
  }
  return { discover, admitPending, admitFiles, admitUnreadFiles, due, process };
}
