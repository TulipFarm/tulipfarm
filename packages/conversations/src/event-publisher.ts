import type { AuthorizationTransaction } from '@tulipfarm/access';
import {
  conversationEventChannel,
  type ConversationNotification,
  type StreamIdentity,
  type StreamTool,
} from './events.ts';
import type { ConversationRuntime, ReplyFence } from './runtime.ts';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import { avatarSnapshotSchema, type AvatarSnapshot } from './avatar.ts';
import { log } from '@tulipfarm/observability';

type TextNotification = Extract<ConversationNotification, { kind: 'text' }>;
type Address = { workspaceId: string; conversationId: string };

/** PostgreSQL rejects NOTIFY payloads of 8000 bytes or more; this leaves headroom. */
export const notificationPayloadLimit = 7000;
const payloadBytes = (payload: unknown) => Buffer.byteLength(JSON.stringify(payload));

/** Queues a `changed` notification that PostgreSQL delivers only if the surrounding transaction commits. */
export async function notifyConversationChange(
  tx: Pick<AuthorizationTransaction, 'client'>,
  change: Address & { turnId?: string; settled?: boolean; planId?: string },
) {
  const payload: ConversationNotification = { kind: 'changed', ...change };
  await tx.client.query('SELECT pg_notify($1, $2)', [conversationEventChannel, JSON.stringify(payload)]);
}

export async function notifyConversationTool(
  tx: Pick<AuthorizationTransaction, 'client'>,
  update: Address & StreamTool,
) {
  const payload: ConversationNotification = { kind: 'tool', ...update };
  await tx.client.query('SELECT pg_notify($1, $2)', [conversationEventChannel, JSON.stringify(payload)]);
}

/**
 * Notifications that move listeners from `published` to `next`. `published` is null when listeners may hold anything else,
 * which forces a reset. `seq` is the first sequence number to use; each payload takes the next one.
 */
export function streamTextPayloads(
  address: Address,
  identity: StreamIdentity,
  published: string | null,
  next: string,
  seq: number,
): TextNotification[] {
  if (published === next) return [];
  const payload = (seq: number, offset: number, text: string): TextNotification => ({
    kind: 'text',
    ...address,
    ...identity,
    seq,
    offset,
    text,
    reset: offset === 0,
  });
  const whole = payload(seq, 0, next);
  if (payloadBytes(whole) <= notificationPayloadLimit) return [whole];
  const payloads: TextNotification[] = [];
  let offset = published !== null && next.startsWith(published) ? published.length : 0;
  while (offset < next.length) {
    const number = seq + payloads.length;
    // JSON escapes each code point independently, so a chunk's size is the empty payload plus each character's escaped size.
    let room = notificationPayloadLimit - payloadBytes(payload(number, offset, ''));
    let end = offset;
    for (const character of next.slice(offset)) {
      room -= payloadBytes(character) - 2;
      if (room < 0) break;
      end += character.length;
    }
    payloads.push(payload(number, offset, next.slice(offset, end)));
    offset = end;
  }
  return payloads;
}

export type ReplyTextPublisher = {
  update(step: number, text: string): void;
  progress(step: number, round: number): void;
  avatar(step: number, avatar: AvatarSnapshot): void;
  close(): Promise<void>;
};

/**
 * Publishes preview text for one reply attempt. At most one publication is in flight, and publications start at least
 * `interval` milliseconds apart, so bursts of updates coalesce into the latest text. Streaming is a preview: failures are
 * swallowed and never reach the reply.
 */
export function createReplyTextPublisher(
  runtime: ConversationRuntime,
  fence: ReplyFence,
  interval = 200,
  closeTimeout = 2000,
): ReplyTextPublisher {
  const address = { workspaceId: fence.workspaceId, conversationId: fence.conversationId };
  let latest: { step: number; text: string } | null = null;
  let sent: { step: number; text: string | null; seq: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flight: Promise<void> | null = null;
  let startedAt = -Infinity;
  let closed = false;
  let progressed: Promise<void> = Promise.resolve();
  let avatarSeq = 0;

  const pending = () => latest !== null && (latest.step !== sent?.step || latest.text !== sent.text);

  async function publish() {
    if (!latest || !pending()) return;
    const { step, text } = latest;
    const current = sent?.step === step ? sent : { step, text: null, seq: 0 };
    const payloads = streamTextPayloads(
      address,
      { turnId: fence.turnId, generation: fence.generation, epoch: fence.epoch, step },
      current.text,
      text,
      current.seq,
    );
    // An uncertain commit may still have delivered these, so their sequence numbers are spent and the next publication resets.
    sent = { step, text: null, seq: current.seq + payloads.length };
    startedAt = Date.now();
    try {
      await runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
        if (tx.commonVersion >= 1 && text.trim())
          await tx.client.query(
            `UPDATE ${qualified(tx.schema, 'tf_conversation_turns')} SET timing_first_text_at=clock_timestamp()
          WHERE id=$1 AND conversation_id=$2 AND generation=$3 AND attempt_epoch=$4 AND status='processing'
            AND lease_until>clock_timestamp() AND timing_started_at IS NOT NULL AND timing_first_text_at IS NULL`,
            [fence.turnId, fence.conversationId, fence.generation, fence.epoch],
          );
        for (const payload of payloads)
          await tx.client.query('SELECT pg_notify($1, $2)', [conversationEventChannel, JSON.stringify(payload)]);
      });
      sent = { step, text, seq: sent.seq };
    } catch {
      log('warn', 'activity', 'call_failed', { operation: 'chat.text-stream', 'error.type': 'publish-failed' });
    }
  }

  function schedule() {
    if (closed || timer || flight || !pending()) return;
    timer = setTimeout(
      () => {
        timer = null;
        flight = publish().finally(() => {
          flight = null;
          schedule();
        });
      },
      Math.max(0, startedAt + interval - Date.now()),
    );
    timer.unref?.();
  }

  return {
    avatar(step, avatar) {
      if (closed) return;
      const payload: ConversationNotification = {
        kind: 'avatar',
        ...address,
        turnId: fence.turnId,
        generation: fence.generation,
        epoch: fence.epoch,
        step,
        seq: avatarSeq++,
        avatar: avatarSnapshotSchema.parse(avatar),
      };
      progressed = progressed
        .then(() =>
          runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
            await tx.client.query('SELECT pg_notify($1, $2)', [conversationEventChannel, JSON.stringify(payload)]);
          }),
        )
        .catch(() => {
          log('warn', 'activity', 'call_failed', { operation: 'chat.avatar-stream', 'error.type': 'publish-failed' });
        });
    },
    update(step, text) {
      if (closed) return;
      latest = { step, text };
      schedule();
    },
    progress(step, round) {
      if (closed) return;
      const payload: ConversationNotification = {
        kind: 'progress',
        ...address,
        turnId: fence.turnId,
        generation: fence.generation,
        epoch: fence.epoch,
        step,
        round,
      };
      progressed = progressed
        .then(() =>
          runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
            await tx.client.query('SELECT pg_notify($1, $2)', [conversationEventChannel, JSON.stringify(payload)]);
          }),
        )
        .catch(() => {
          /* Progress is a preview; the saved reply is unaffected. */
        });
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      let expire: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>(resolve => {
        expire = setTimeout(resolve, closeTimeout);
      });
      try {
        await Promise.race([
          (async () => {
            await flight;
            await publish();
            await progressed;
          })(),
          deadline,
        ]);
      } catch {
        /* close never fails the reply. */
      } finally {
        clearTimeout(expire);
      }
    },
  };
}
