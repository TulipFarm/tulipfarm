import { randomUUID } from 'node:crypto';
import { createBackgroundJob } from '@tulipfarm/observability';
import { applyStreamAvatar, type StreamAvatar } from '@tulipfarm/conversations/events';
import {
  applyStreamProgress,
  applyStreamText,
  conversationEventChannel,
  conversationNotificationSchema,
  conversationStreamEvents,
  type StreamChange,
  type StreamProgress,
  type StreamText,
  type StreamTextState,
  type StreamTool,
  type StreamSubagents,
} from '@tulipfarm/conversations/events';
import { recommendationEventChannel } from '@tulipfarm/workspace-storage/recommendations';
import { recommendationNotificationSchema, type RecommendationStreamEvent } from '@tulipfarm/recommendations/contracts';

/** The part of a `pg` client the hub uses. A pooled client satisfies it. */
export type ListenClient = {
  query(text: string, values?: unknown[]): Promise<unknown>;
  on(event: 'notification', listener: (message: { channel: string; payload?: string | undefined }) => void): unknown;
  on(event: 'error' | 'end', listener: () => void): unknown;
  release(destroy: boolean): void;
};

export type ConversationStreamEvent =
  | { event: typeof conversationStreamEvents.text; data: StreamText }
  | { event: typeof conversationStreamEvents.changed; data: StreamChange }
  | { event: typeof conversationStreamEvents.progress; data: StreamProgress }
  | { event: typeof conversationStreamEvents.avatar; data: StreamAvatar }
  | { event: typeof conversationStreamEvents.tool; data: StreamTool }
  | { event: typeof conversationStreamEvents.subagents; data: StreamSubagents }
  | { event: typeof conversationStreamEvents.resync; data: Record<string, never> };

export type ConversationEventHub = {
  healthy(): boolean;
  /** Receives every event for one conversation until the returned function runs. */
  subscribe(
    workspaceId: string,
    conversationId: string,
    listener: (event: ConversationStreamEvent) => void,
  ): () => void;
  subscribeRecommendations(
    workspaceId: string,
    membershipId: string,
    listener: (event: RecommendationStreamEvent) => void,
  ): () => void;
  /** Latest progress and complete preview text of each turn still replying, with text as reset updates. */
  snapshot(workspaceId: string, conversationId: string): ConversationStreamEvent[];
  close(): void;
};

export type ConversationEventHubOptions = {
  connect: () => Promise<ListenClient>;
  probeTimeoutMs?: number;
  backoffMs?: { initial: number; maximum: number };
  idleMs?: number;
  maxBuffers?: number;
  log?: (message: string) => void;
};

type Preview = {
  address: string;
  state?: StreamTextState;
  progress?: StreamProgress;
  avatar?: StreamAvatar;
  touched: number;
};
type Status = 'connecting' | 'healthy' | 'closed';

const resync: ConversationStreamEvent = { event: conversationStreamEvents.resync, data: {} };

export function createConversationEventHub(options: ConversationEventHubOptions): ConversationEventHub {
  const probeTimeoutMs = options.probeTimeoutMs ?? 5_000;
  const backoff = options.backoffMs ?? { initial: 1_000, maximum: 30_000 };
  const idleMs = options.idleMs ?? 300_000;
  const maxBuffers = options.maxBuffers ?? 5_000;
  const subscribers = new Map<string, Set<(event: ConversationStreamEvent) => void>>();
  const recommendationSubscribers = new Map<string, Set<(event: RecommendationStreamEvent) => void>>();
  // Keyed by address and turn so one tenant's turn id can never surface in another conversation. Map order is least recently touched first.
  const previews = new Map<string, Preview>();
  let status: Status = 'connecting';
  let current: ListenClient | undefined;
  let wake: (() => void) | undefined;

  const closed = () => status === 'closed';
  const address = (workspaceId: string, conversationId: string) => `${workspaceId}:${conversationId}`;
  function broadcast(event: ConversationStreamEvent, target?: string) {
    const groups = target ? [subscribers.get(target)] : [...subscribers.values()];
    for (const listener of groups.flatMap(group => (group ? [...group] : []))) listener(event);
  }
  function touch(key: string, preview: Preview) {
    previews.delete(key);
    previews.set(key, preview);
    if (previews.size > maxBuffers) previews.delete(previews.keys().next().value!);
  }
  function resyncRecommendations() {
    for (const group of recommendationSubscribers.values()) for (const listener of group) listener({ kind: 'resync' });
  }
  function receiveRecommendation(payload: string | undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload ?? '');
    } catch {
      return;
    }
    const result = recommendationNotificationSchema.safeParse(parsed);
    if (!result.success) return;
    const group = recommendationSubscribers.get(address(result.data.workspaceId, result.data.membershipId));
    if (group) for (const listener of group) listener(result.data);
  }
  function receive(payload: string | undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload ?? '');
    } catch {
      return;
    }
    const result = conversationNotificationSchema.safeParse(parsed);
    if (!result.success) return;
    // Stop requests are for the worker running the sub-agents, not for browsers.
    if (result.data.kind === 'subagent-stop') return;
    const target = address(result.data.workspaceId, result.data.conversationId);
    if (result.data.kind === 'subagents') {
      const { kind: _kind, workspaceId: _workspaceId, conversationId: _conversationId, ...update } = result.data;
      broadcast({ event: conversationStreamEvents.subagents, data: update }, target);
      return;
    }
    if (result.data.kind === 'tool') {
      const { kind: _kind, workspaceId: _workspaceId, conversationId: _conversationId, ...update } = result.data;
      broadcast({ event: conversationStreamEvents.tool, data: update }, target);
      return;
    }
    if (result.data.kind === 'avatar') {
      const { kind: _kind, workspaceId: _workspaceId, conversationId: _conversationId, ...update } = result.data;
      const key = `${target}:${update.turnId}`;
      const previous = previews.get(key);
      touch(key, {
        ...previous,
        address: target,
        avatar: applyStreamAvatar(previous?.avatar, update),
        touched: Date.now(),
      });
      broadcast({ event: conversationStreamEvents.avatar, data: update }, target);
      return;
    }
    if (result.data.kind === 'text') {
      const { kind: _kind, workspaceId: _workspaceId, conversationId: _conversationId, ...update } = result.data;
      const key = `${target}:${update.turnId}`;
      const previous = previews.get(key);
      touch(key, {
        ...previous,
        address: target,
        state: applyStreamText(previous?.state, update),
        touched: Date.now(),
      });
      broadcast({ event: conversationStreamEvents.text, data: update }, target);
      return;
    }
    if (result.data.kind === 'progress') {
      const { kind: _kind, workspaceId: _workspaceId, conversationId: _conversationId, ...update } = result.data;
      const key = `${target}:${update.turnId}`;
      const previous = previews.get(key);
      touch(key, {
        ...previous,
        address: target,
        progress: applyStreamProgress(previous?.progress, update),
        touched: Date.now(),
      });
      broadcast({ event: conversationStreamEvents.progress, data: update }, target);
      return;
    }
    const { kind: _kind, workspaceId: _workspaceId, conversationId: _conversationId, ...change } = result.data;
    if (change.settled && change.turnId) previews.delete(`${target}:${change.turnId}`);
    broadcast({ event: conversationStreamEvents.changed, data: change }, target);
  }

  async function listen(client: ListenClient) {
    const probe = `probe:${randomUUID()}`;
    let probed!: () => void;
    const received = new Promise<'ready'>(resolve => {
      probed = () => resolve('ready');
    });
    const lost = new Promise<'lost'>(resolve => {
      const drop = () => {
        resolve('lost');
        if (status !== 'healthy' || current !== client) return;
        status = 'connecting';
        // Missed notifications make every preview suspect, so clients reread history and later updates start clean.
        previews.clear();
        broadcast(resync);
        resyncRecommendations();
      };
      client.on('error', drop);
      client.on('end', drop);
    });
    client.on('notification', message => {
      if (message.channel === recommendationEventChannel) {
        receiveRecommendation(message.payload);
        return;
      }
      if (message.channel !== conversationEventChannel) return;
      if (message.payload === probe) probed();
      else receive(message.payload);
    });
    await client.query(`LISTEN ${conversationEventChannel}`);
    await client.query(`LISTEN ${recommendationEventChannel}`);
    await client.query('SELECT pg_notify($1, $2)', [conversationEventChannel, probe]);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), probeTimeoutMs);
    });
    const outcome = await Promise.race([received, lost, timeout]);
    clearTimeout(timer);
    if (outcome !== 'ready') throw new Error(`conversation event probe ${outcome}`);
    if (closed()) return;
    status = 'healthy';
    broadcast(resync);
    resyncRecommendations();
    await lost;
  }

  async function run() {
    for (let failures = 0; !closed(); failures++) {
      try {
        current = await options.connect();
        if (closed()) break;
        await listen(current);
        failures = 0;
      } catch (error) {
        options.log?.(`Conversation event listener failed: ${error instanceof Error ? error.message : 'unknown'}`);
      } finally {
        current?.release(true);
        current = undefined;
      }
      if (closed()) break;
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Math.min(backoff.maximum, backoff.initial * 2 ** failures));
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  }

  const previewJob = createBackgroundJob('conversation-stream-expiry', Math.min(idleMs, 60_000) / 1000);
  const sweep = setInterval(
    () =>
      previewJob.runSync(() => {
        const cutoff = Date.now() - idleMs;
        for (const [key, preview] of previews) {
          if (preview.touched >= cutoff) break;
          previews.delete(key);
        }
      }),
    Math.min(idleMs, 60_000),
  );
  sweep.unref();
  void run();

  return {
    healthy: () => status === 'healthy',
    subscribe(workspaceId, conversationId, listener) {
      const target = address(workspaceId, conversationId);
      const group = subscribers.get(target) ?? new Set();
      subscribers.set(target, group.add(listener));
      return () => {
        group.delete(listener);
        if (!group.size && subscribers.get(target) === group) subscribers.delete(target);
      };
    },
    subscribeRecommendations(workspaceId, membershipId, listener) {
      const target = address(workspaceId, membershipId);
      const group = recommendationSubscribers.get(target) ?? new Set();
      recommendationSubscribers.set(target, group.add(listener));
      return () => {
        group.delete(listener);
        if (!group.size && recommendationSubscribers.get(target) === group) recommendationSubscribers.delete(target);
      };
    },
    snapshot(workspaceId, conversationId) {
      const target = address(workspaceId, conversationId);
      return [...previews.values()]
        .filter(preview => preview.address === target)
        .flatMap(({ state, progress, avatar }): ConversationStreamEvent[] => [
          ...(progress ? [{ event: conversationStreamEvents.progress, data: progress }] : []),
          ...(avatar ? [{ event: conversationStreamEvents.avatar, data: avatar }] : []),
          ...(state?.complete
            ? [
                {
                  event: conversationStreamEvents.text,
                  data: { ...state.identity, seq: state.seq, offset: 0, text: state.text, reset: true },
                },
              ]
            : []),
        ]);
    },
    close() {
      status = 'closed';
      clearInterval(sweep);
      previewJob.close();
      wake?.();
      current?.release(true);
      current = undefined;
    },
  };
}
