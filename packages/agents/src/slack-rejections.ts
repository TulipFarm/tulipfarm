import { z } from 'zod';
import { AccessDenied, type AuthorizationTransaction } from '@tulipfarm/access';
import { log } from '@tulipfarm/observability';
import { messageSchema, postBotMessage, type slackCredentialCipher } from '@tulipfarm/slack';
import { qualified } from '@tulipfarm/workspace-storage/runtime';

export const slackAdmissionReasons = [
  'request-changed',
  'request-not-in-thread',
  'thread-changed',
  'message-edited',
  'private-context-missing',
  'publication-unverified',
  'prior-answer-sources',
  'access-denied',
] as const;
export type SlackAdmissionReason = (typeof slackAdmissionReasons)[number];

/** An admission denial that names the check that failed. The reason is a fixed code and never carries Slack content. */
export class SlackAdmissionDenied extends AccessDenied {
  readonly reason: SlackAdmissionReason;
  constructor(reason: SlackAdmissionReason) {
    super();
    this.reason = reason;
  }
}

export function slackAdmissionReason(error: unknown): SlackAdmissionReason {
  return error instanceof SlackAdmissionDenied ? error.reason : 'access-denied';
}

// The notice is posted where the requester asked, so it states only which kind of check failed, never what it protected.
const notices: Record<SlackAdmissionReason, string> = {
  'request-changed': 'your message changed or was deleted before I could check it',
  'request-not-in-thread': 'I could not find your message in this thread with your Slack access',
  'thread-changed': 'a message in this thread changed or was deleted after I last read it',
  'message-edited': 'a message in this thread changed or was deleted after I last read it',
  'private-context-missing': 'I could not verify this conversation with your Slack access',
  'publication-unverified': 'I could not verify one of my earlier replies in this thread',
  'prior-answer-sources': 'an earlier reply in this thread used sources you cannot currently access',
  'access-denied': 'I could not confirm you can access everything this thread depends on',
};

export function slackRejectionNotice(reason: SlackAdmissionReason) {
  return `I can't answer this in this thread because ${notices[reason]}. Mention me in a new thread and I'll start fresh. (reason: ${reason})`;
}

type NoticeTarget = {
  channel: string;
  threadTs: string;
  installationId: string;
  generation: number;
  credential: unknown;
};

/**
 * Records a permanent admission rejection. When the rejected message explicitly mentions the bot and this is the first
 * rejection for the event, it returns where to post a visible notice so the requester is never silently ignored.
 */
export async function recordSlackRejection(
  tx: AuthorizationTransaction,
  eventId: string,
): Promise<NoticeTarget | undefined> {
  const inserted = await tx.client.query(
    `INSERT INTO ${qualified(tx.schema, 'tf_slack_agent_rejections')} (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id`,
    [eventId],
  );
  if (!inserted.rowCount) return undefined;
  return mentionTarget(tx, eventId);
}

/** Returns where to post a notice in the requester's thread, only when the event explicitly mentioned the bot. */
export async function mentionTarget(tx: AuthorizationTransaction, eventId: string): Promise<NoticeTarget | undefined> {
  const row = z
    .object({
      payload: messageSchema,
      installation_id: z.uuid(),
      generation: z.number().int(),
      bot_user_id: z.string(),
      bot_credential: z.unknown(),
    })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT e.payload,e.installation_id,e.generation,s.bot_user_id,s.bot_credential FROM ${qualified(tx.schema, 'tf_slack_events')} e JOIN ${qualified(tx.schema, 'tf_slack_installations')} s ON s.id=e.installation_id AND s.generation=e.generation AND s.state='active' WHERE e.id=$1`,
          [eventId],
        )
      ).rows[0],
    );
  if (!row) return undefined;
  const mentioned = row.payload.type === 'app_mention' || row.payload.text.includes(`<@${row.bot_user_id}>`);
  if (!mentioned) return undefined;
  return {
    channel: row.payload.channel,
    threadTs: row.payload.thread_ts ?? row.payload.ts,
    installationId: row.installation_id,
    generation: row.generation,
    credential: row.bot_credential,
  };
}

async function postNotice(input: {
  workspaceId: string;
  target: NoticeTarget;
  text: string;
  cipher: ReturnType<typeof slackCredentialCipher>;
  fetcher?: typeof fetch | undefined;
}) {
  const { target } = input;
  try {
    const result = await postBotMessage({
      token: input.cipher.decrypt(
        {
          workspaceId: input.workspaceId,
          installationId: target.installationId,
          generation: target.generation,
          kind: 'bot',
        },
        target.credential,
      ),
      channel: target.channel,
      rootTs: target.threadTs,
      text: input.text,
      ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    });
    return result.kind === 'sent';
  } catch {
    // The caller already recorded the outcome; a failed notice is reported in its log line.
    return false;
  }
}

/** Logs the rejection with its event id and reason code, and posts the notice when the bot was mentioned. */
export async function announceSlackRejection(input: {
  surface: 'default' | 'channel';
  workspaceId: string;
  eventId: string;
  reason: SlackAdmissionReason;
  target: NoticeTarget | undefined;
  cipher: ReturnType<typeof slackCredentialCipher>;
  fetcher?: typeof fetch | undefined;
}) {
  let outcome: 'rejected' | 'rejected_notified' | 'rejected_notice_failed' = 'rejected';
  if (input.target)
    outcome = (await postNotice({ ...input, target: input.target, text: slackRejectionNotice(input.reason) }))
      ? 'rejected_notified'
      : 'rejected_notice_failed';
  log(outcome === 'rejected_notice_failed' ? 'error' : 'warn', 'activity', 'call_failed', {
    operation: `slack.${input.surface}.admission`,
    outcome,
    'error.type': input.reason,
    'slack.event_id': input.eventId,
  });
  return outcome;
}

// The notice states only that the reply failed, never why the model or tools failed or what they read.
export const slackReplyFailureNotice =
  "I couldn't finish an answer to this. Mention me again to retry. (reason: reply-failed)";

/**
 * Logs a blocked default reply with its real reason. When the reply failed after admission and the request mentioned the
 * bot, it also posts a short notice in the requester's thread, so a failed answer is never silent.
 */
export async function announceSlackReplyFailure(input: {
  workspaceId: string;
  eventId: string;
  reason: string;
  target: NoticeTarget | undefined;
  cipher: ReturnType<typeof slackCredentialCipher>;
  fetcher?: typeof fetch | undefined;
}) {
  let outcome: 'blocked' | 'blocked_notified' | 'blocked_notice_failed' = 'blocked';
  if (input.target)
    outcome = (await postNotice({ ...input, target: input.target, text: slackReplyFailureNotice }))
      ? 'blocked_notified'
      : 'blocked_notice_failed';
  log(outcome === 'blocked_notice_failed' ? 'error' : 'warn', 'activity', 'call_failed', {
    operation: 'slack.default.reply',
    outcome,
    'error.type': input.reason,
    'slack.event_id': input.eventId,
  });
  return outcome;
}
