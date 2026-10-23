import {
  applyStreamProgress,
  applyStreamText,
  conversationStreamEvents,
  streamChangeSchema,
  streamProgressSchema,
  streamTextSchema,
  type StreamProgress,
  type StreamTextState,
} from '@tulipfarm/conversations/events';
import { applyStreamAvatar, streamAvatarSchema, type StreamAvatar } from '@tulipfarm/conversations/events';
import { applyStreamTool, streamToolSchema, type StreamTool } from '@tulipfarm/conversations/events';
import { applyStreamSubagents, streamSubagentsSchema, type StreamSubagents } from '@tulipfarm/conversations/events';
import { flushSync } from 'react-dom';

export type LiveSubagents = StreamSubagents & { receivedAt: number };
export type ConversationStreamStatus = 'connecting' | 'open' | 'unavailable';
/** What a burst of changes asks the owner to read again. A change naming only a plan leaves history alone. */
export type ConversationStreamChange = { history: boolean; plans: boolean };
export type ConversationStreamSnapshot = {
  status: ConversationStreamStatus;
  previews: ReadonlyMap<string, StreamTextState>;
  progress: ReadonlyMap<string, StreamProgress>;
  avatars?: ReadonlyMap<string, StreamAvatar>;
  tools?: ReadonlyMap<string, StreamTool>;
  /** Live sub-agent cards, keyed by the `agents.delegate` call id. `receivedAt` lets the page advance run times. */
  subagents?: ReadonlyMap<string, LiveSubagents>;
};

type Source = {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
};
type Timer = ReturnType<typeof setTimeout>;
export type ConversationStreamEnvironment = {
  connect: (url: string) => Source;
  setTimeout: (callback: () => void, ms: number) => Timer;
  clearTimeout: (timer: Timer | undefined) => void;
  commit?: (publish: () => void) => void;
};

const closed = 2;
export const streamTiming = { coalesce: 100, reconnect: 2000, unavailableRetry: 60_000, failureLimit: 3 };

export const browserStreamEnvironment: ConversationStreamEnvironment = {
  connect: url => new EventSource(url, { withCredentials: true }),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: timer => clearTimeout(timer),
  commit: flushSync,
};

/**
 * Owns one chat's event stream. `changed` asks the owner to read history or plans again, coalesced per burst.
 * Three consecutive errors with no successful open between them mark the stream unavailable until
 * `retry`, `start`, or a one-minute timer reconnects. An error right after an open is a server close, not a failure.
 */
export function createConversationStream(
  url: string,
  changed: (change: ConversationStreamChange) => void,
  environment: ConversationStreamEnvironment = browserStreamEnvironment,
) {
  let snapshot: ConversationStreamSnapshot = {
    status: 'connecting',
    previews: new Map(),
    progress: new Map(),
    avatars: new Map(),
  };
  const listeners = new Set<() => void>();
  let source: Source | undefined;
  let failures = 0;
  let opened = false;
  let reconnect: Timer | undefined;
  let refetch: Timer | undefined;
  let pending: ConversationStreamChange = { history: false, plans: false };

  const publish = (next: Partial<ConversationStreamSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };
  const invalidate = (change: ConversationStreamChange = { history: true, plans: true }) => {
    pending = { history: pending.history || change.history, plans: pending.plans || change.plans };
    if (refetch !== undefined) return;
    refetch = environment.setTimeout(() => {
      refetch = undefined;
      const next = pending;
      pending = { history: false, plans: false };
      changed(next);
    }, streamTiming.coalesce);
  };
  const close = () => {
    environment.clearTimeout(reconnect);
    reconnect = undefined;
    source?.close();
    source = undefined;
  };
  const connect = () => {
    close();
    opened = false;
    if (snapshot.status !== 'connecting') publish({ status: 'connecting' });
    const current = environment.connect(url);
    source = current;
    current.addEventListener('open', () => {
      if (source !== current) return;
      failures = 0;
      opened = true;
      publish({ status: 'open', tools: new Map(), subagents: new Map() });
      invalidate();
    });
    current.addEventListener('error', () => {
      if (source !== current) return;
      const failed = !opened;
      opened = false;
      if (failed) failures++;
      if (failures >= streamTiming.failureLimit) {
        close();
        publish({ status: 'unavailable' });
        reconnect = environment.setTimeout(restart, streamTiming.unavailableRetry);
        return;
      }
      if (failed && snapshot.status !== 'connecting') publish({ status: 'connecting' });
      // EventSource reconnects by itself unless the response was not a stream (for example 401, 404, or 503).
      if (current.readyState === closed) {
        current.close();
        source = undefined;
        reconnect = environment.setTimeout(connect, streamTiming.reconnect);
      }
    });
    current.addEventListener(conversationStreamEvents.changed, event => {
      if (source !== current) return;
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        data = null;
      }
      const change = streamChangeSchema.safeParse(data);
      invalidate(
        change.success && change.data.planId && !change.data.turnId
          ? { history: false, plans: true }
          : { history: true, plans: !change.success || !!change.data.planId },
      );
    });
    current.addEventListener(conversationStreamEvents.resync, () => {
      if (source === current) {
        publish({ tools: new Map(), subagents: new Map() });
        invalidate();
      }
    });
    current.addEventListener(conversationStreamEvents.tool, event => {
      if (source !== current) return;
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      const update = streamToolSchema.safeParse(data);
      if (!update.success) return;
      const previous = snapshot.tools?.get(update.data.id);
      const next = applyStreamTool(previous, update.data);
      if (next === previous) return;
      const tools = new Map(snapshot.tools).set(update.data.id, next);
      if (environment.commit) environment.commit(() => publish({ tools }));
      else publish({ tools });
      invalidate({ history: true, plans: false });
    });
    current.addEventListener(conversationStreamEvents.subagents, event => {
      if (source !== current) return;
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      const update = streamSubagentsSchema.safeParse(data);
      if (!update.success) return;
      const previous = snapshot.subagents?.get(update.data.id);
      if (applyStreamSubagents(previous, update.data) === previous) return;
      publish({
        subagents: new Map(snapshot.subagents).set(update.data.id, { ...update.data, receivedAt: Date.now() }),
      });
    });
    current.addEventListener(conversationStreamEvents.avatar, event => {
      if (source !== current) return;
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        console.error('Invalid avatar stream JSON');
        return;
      }
      const update = streamAvatarSchema.safeParse(data);
      if (!update.success) {
        console.error('Invalid avatar stream state');
        return;
      }
      const previous = snapshot.avatars?.get(update.data.turnId);
      const next = applyStreamAvatar(previous, update.data);
      if (next === previous) return;
      publish({ avatars: new Map(snapshot.avatars).set(update.data.turnId, next) });
    });
    current.addEventListener(conversationStreamEvents.text, event => {
      if (source !== current) return;
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      const update = streamTextSchema.safeParse(data);
      if (!update.success) return;
      const previous = snapshot.previews.get(update.data.turnId);
      const next = applyStreamText(previous, update.data);
      if (next === previous) return;
      publish({ previews: new Map(snapshot.previews).set(update.data.turnId, next) });
    });
    current.addEventListener(conversationStreamEvents.progress, event => {
      if (source !== current) return;
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      const update = streamProgressSchema.safeParse(data);
      if (!update.success) return;
      const previous = snapshot.progress.get(update.data.turnId);
      const next = applyStreamProgress(previous, update.data);
      if (next === previous) return;
      publish({ progress: new Map(snapshot.progress).set(update.data.turnId, next) });
    });
  };
  function restart() {
    failures = 0;
    connect();
  }

  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Connects unless a stream is already open or reconnecting. */
    start() {
      if (snapshot.status === 'unavailable' || (!source && reconnect === undefined)) restart();
    },
    /** Reconnects now when the stream gave up. */
    retry() {
      if (snapshot.status === 'unavailable') restart();
    },
    stop() {
      close();
      environment.clearTimeout(refetch);
      refetch = undefined;
      pending = { history: false, plans: false };
      if (snapshot.status === 'open') publish({ status: 'connecting' });
    },
  };
}

export type ConversationStream = ReturnType<typeof createConversationStream>;
