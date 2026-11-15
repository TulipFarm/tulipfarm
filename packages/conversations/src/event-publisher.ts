import type { AuthorizationTransaction } from '@tulipfarm/access';
import {
  conversationEventChannel,
  type ConversationNotification,
  type StreamIdentity,
  type StreamLayoutCalls,
  type StreamProgress,
  type StreamTool,
  type SubagentCard,
} from './events.ts';
import type { ConversationRuntime, ReplyFence } from './runtime.ts';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import { log } from '@tulipfarm/observability';
import type { SourceDependency } from '@tulipfarm/access';

type TextNotification = Extract<ConversationNotification, { kind: 'text' | 'layout' }>;
type Address = { workspaceId: string; conversationId: string };

/** First common version whose turns keep the streamed preview, so a stopped reply keeps its partial text. */
export const stoppedReplyVersion = 47;

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

/** Queues the reply's renderer calls; PostgreSQL delivers them only if the transaction that saves the reply commits. */
export async function notifyLayoutCalls(
  tx: Pick<AuthorizationTransaction, 'client'>,
  update: Address & StreamLayoutCalls,
) {
  const payload: ConversationNotification = { kind: 'layout-calls', ...update };
  if (payloadBytes(payload) < notificationPayloadLimit)
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
  kind: TextNotification['kind'] = 'text',
): TextNotification[] {
  if (published === next) return [];
  const payload = (seq: number, offset: number, text: string): TextNotification => ({
    kind,
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

export type ReplyProgress = Pick<StreamProgress, 'step' | 'round' | 'status' | 'tool' | 'toolRounds'>;
export type ReplyTextPublisher = {
  update(step: number, text: string): void;
  progress(update: ReplyProgress): void;
  /** Live sub-agent cards of the `agents.delegate` call `id`. Bursts coalesce into the latest cards. */
  subagents(id: string, cards: readonly SubagentCard[]): void;
  /** The `reply.render` arguments streamed so far in `step`, as JSON text that may be incomplete. */
  layout(step: number, json: string): void;
  close(): Promise<void>;
};

/**
 * Publishes preview text for one reply attempt. At most one publication is in flight, and publications start at least
 * `interval` milliseconds apart, so bursts of updates coalesce into the latest text. Streaming is a preview: failures are
 * swallowed and never reach the reply. Each publication also saves the text on the turn with `sources`, the sources the
 * model could read, so stopping the reply keeps exactly the text members saw.
 */
export function createReplyTextPublisher(
  runtime: ConversationRuntime,
  fence: ReplyFence,
  interval = 200,
  closeTimeout = 2000,
  sources: () => readonly SourceDependency[] = () => [],
  layoutInterval = 100,
): ReplyTextPublisher {
  const address = { workspaceId: fence.workspaceId, conversationId: fence.conversationId };
  let latest: { step: number; text: string } | null = null;
  let sent: { step: number; text: string | null; seq: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flight: Promise<void> | null = null;
  let startedAt = -Infinity;
  let closed = false;
  let progressed: Promise<void> = Promise.resolve();
  let progressSeq = 0;
  const subagentCards = new Map<string, { seq: number; cards: readonly SubagentCard[] | null }>();
  let subagentTimer: ReturnType<typeof setTimeout> | null = null;

  function flushSubagents() {
    subagentTimer = null;
    const payloads: ConversationNotification[] = [];
    for (const [id, entry] of subagentCards) {
      if (!entry.cards) continue;
      payloads.push({
        kind: 'subagents',
        ...address,
        turnId: fence.turnId,
        generation: fence.generation,
        epoch: fence.epoch,
        id,
        seq: entry.seq++,
        agents: [...entry.cards],
      });
      entry.cards = null;
    }
    const fitting = payloads.filter(payload => payloadBytes(payload) < notificationPayloadLimit);
    if (!fitting.length) return;
    progressed = progressed
      .then(() =>
        runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
          for (const payload of fitting)
            await tx.client.query('SELECT pg_notify($1, $2)', [conversationEventChannel, JSON.stringify(payload)]);
        }),
      )
      .catch(() => {
        /* Sub-agent cards are a preview; the saved result is unaffected. */
      });
  }

  const pending = () => latest !== null && (latest.step !== sent?.step || latest.text !== sent.text);

  let layoutLatest: { step: number; json: string } | null = null;
  let layoutSent: { step: number; json: string | null; seq: number } | null = null;
  let layoutTimer: ReturnType<typeof setTimeout> | null = null;
  let layoutFlight: Promise<void> | null = null;
  let layoutStartedAt = -Infinity;
  const layoutPending = () =>
    layoutLatest !== null && (layoutLatest.step !== layoutSent?.step || layoutLatest.json !== layoutSent.json);

  async function publishLayout() {
    if (!layoutLatest || !layoutPending()) return;
    const { step, json } = layoutLatest;
    const current = layoutSent?.step === step ? layoutSent : { step, json: null, seq: 0 };
    const payloads = streamTextPayloads(
      address,
      { turnId: fence.turnId, generation: fence.generation, epoch: fence.epoch, step },
      current.json,
      json,
      current.seq,
      'layout',
    );
    layoutSent = { step, json: null, seq: current.seq + payloads.length };
    layoutStartedAt = Date.now();
    try {
      await runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
        // Readers check a preview against the sources saved with the turn's streamed text, so a layout keeps them current.
        if (tx.commonVersion < stoppedReplyVersion) return;
        await tx.client.query(
          `UPDATE ${qualified(tx.schema, 'tf_conversation_turns')} SET streamed=CASE
            WHEN (streamed->>'generation')::integer=$3 AND (streamed->>'epoch')::integer=$4 THEN jsonb_set(streamed,'{sources}',$5::jsonb)
            ELSE jsonb_build_object('generation',$3::integer,'epoch',$4::integer,'text','','sources',$5::jsonb) END
          WHERE id=$1 AND conversation_id=$2 AND generation=$3 AND attempt_epoch=$4 AND status='processing'`,
          [fence.turnId, fence.conversationId, fence.generation, fence.epoch, JSON.stringify(sources())],
        );
        for (const payload of payloads)
          await tx.client.query('SELECT pg_notify($1, $2)', [conversationEventChannel, JSON.stringify(payload)]);
      });
      layoutSent = { step, json, seq: layoutSent.seq };
    } catch {
      log('warn', 'activity', 'call_failed', { operation: 'chat.layout-stream', 'error.type': 'publish-failed' });
    }
  }

  function scheduleLayout() {
    if (closed || layoutTimer || layoutFlight || !layoutPending()) return;
    layoutTimer = setTimeout(
      () => {
        layoutTimer = null;
        layoutFlight = publishLayout().finally(() => {
          layoutFlight = null;
          scheduleLayout();
        });
      },
      Math.max(0, layoutStartedAt + layoutInterval - Date.now()),
    );
    layoutTimer.unref?.();
  }

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
        if (tx.commonVersion >= stoppedReplyVersion)
          await tx.client.query(
            `UPDATE ${qualified(tx.schema, 'tf_conversation_turns')} SET streamed=jsonb_build_object('generation',$3::integer,'epoch',$4::integer,'text',$5::text,'sources',$6::jsonb)
          WHERE id=$1 AND conversation_id=$2 AND generation=$3 AND attempt_epoch=$4 AND status='processing'`,
            [fence.turnId, fence.conversationId, fence.generation, fence.epoch, text, JSON.stringify(sources())],
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
    layout(step, json) {
      if (closed) return;
      layoutLatest = { step, json };
      scheduleLayout();
    },
    subagents(id, cards) {
      if (closed) return;
      const entry = subagentCards.get(id) ?? { seq: 0, cards: null };
      entry.cards = cards;
      subagentCards.set(id, entry);
      if (subagentTimer) return;
      subagentTimer = setTimeout(flushSubagents, interval);
      subagentTimer.unref?.();
    },
    update(step, text) {
      if (closed) return;
      latest = { step, text };
      schedule();
    },
    progress({ step, round, status, tool, toolRounds }) {
      if (closed) return;
      const payload: ConversationNotification = {
        kind: 'progress',
        ...address,
        turnId: fence.turnId,
        generation: fence.generation,
        epoch: fence.epoch,
        step,
        round,
        ...(status ? { status, toolRounds: toolRounds ?? 0, seq: progressSeq++ } : {}),
        ...(status === 'tool' && tool ? { tool: tool.slice(0, 64) } : {}),
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
      if (layoutTimer) clearTimeout(layoutTimer);
      layoutTimer = null;
      if (subagentTimer) {
        clearTimeout(subagentTimer);
        flushSubagents();
      }
      let expire: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>(resolve => {
        expire = setTimeout(resolve, closeTimeout);
      });
      try {
        await Promise.race([
          (async () => {
            await flight;
            await publish();
            await layoutFlight;
            await publishLayout();
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
