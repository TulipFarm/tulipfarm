import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ConversationHistory } from './conversation-api';
import type { ConversationStreamSnapshot } from './conversation-stream';
import { reconcileLiveTools } from './live-tools.ts';

type ReplyCheck = { key: string | null; progress: ReadonlyMap<string, number>; recovery: boolean };
const recoveryDelays = [1000, 2000, 5000];
const statusPosition = { thinking: 0, tool: 1, finishing: 2, done: 3 };

/** A silent period has a bounded budget. Only new work, not replayed state, renews it. */
export function createReplyResync(refresh: () => Promise<void>) {
  let input: ReplyCheck = { key: null, progress: new Map(), recovery: false };
  const observed = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checks = 0;
  let checking = false;
  let visible = true;
  let online = true;
  let uncertain = false;
  const listeners = new Set<() => void>();
  const publish = (next: boolean) => {
    if (uncertain === next) return;
    uncertain = next;
    for (const listener of listeners) listener();
  };
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    if (timer !== undefined || checking || !visible || !input.key) return;
    if (!online) {
      publish(true);
      return;
    }
    if (input.recovery && checks >= recoveryDelays.length) {
      publish(true);
      return;
    }
    timer = setTimeout(
      () => {
        timer = undefined;
        void check();
      },
      input.recovery ? recoveryDelays[checks] : 15_000,
    );
  };
  async function check() {
    if (checking || !visible || !input.key) return;
    if (!online) {
      publish(true);
      return;
    }
    checking = true;
    if (input.recovery) checks++;
    try {
      await refresh();
    } catch {
      // The history reader owns request errors; this budget also bounds unsuccessful recovery.
    } finally {
      checking = false;
      schedule();
    }
  }
  return {
    snapshot: () => uncertain,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(next: ReplyCheck) {
      const newAttempt = next.key !== input.key;
      if (newAttempt) observed.clear();
      let advanced = false;
      for (const [signal, position] of next.progress) {
        if (position <= (observed.get(signal) ?? -1)) continue;
        observed.set(signal, position);
        advanced = true;
      }
      if (!newAttempt && !advanced && next.recovery === input.recovery) return;
      if (newAttempt || advanced) {
        checks = 0;
        publish(false);
      }
      input = next;
      clear();
      if (!input.key || !input.recovery) publish(false);
      schedule();
    },
    setVisible(next: boolean) {
      if (next === visible) return;
      const returning = !visible && next;
      visible = next;
      clear();
      if (returning) void check();
      else schedule();
    },
    setOnline(next: boolean) {
      if (next === online) return;
      online = next;
      clear();
      schedule();
    },
    retry() {
      checks = 0;
      clear();
      publish(false);
      void check();
    },
    stop() {
      input = { key: null, progress: new Map(), recovery: false };
      clear();
    },
  };
}

export function useReplyResync(
  history: ConversationHistory | undefined,
  stream: ConversationStreamSnapshot,
  refresh: () => Promise<void>,
) {
  const recovery = useMemo(() => createReplyResync(refresh), [refresh]);
  const messages = reconcileLiveTools(history?.messages ?? [], stream.tools);
  const message = messages.find(
    message => message.turn && ['queued', 'processing', 'reconciling'].includes(message.turn.status),
  );
  const turn = message?.turn;
  const text = turn && stream.previews.get(turn.id);
  const preview = text?.identity.generation === turn?.generation ? text : undefined;
  const update = turn && stream.progress.get(turn.id);
  const progress = update?.generation === turn?.generation ? update : undefined;
  const running = message?.tools.some(tool => (tool.activityStatus ?? tool.status) === 'running');
  const key = turn ? `${turn.id}:${turn.generation}` : null;
  const activity = useMemo(() => {
    // Transport epochs and replayed prefixes are not new work.
    const activity = new Map<string, number>();
    if (preview?.text) activity.set(`text:${preview.identity.step}`, preview.text.length);
    if (progress) {
      activity.set('step', progress.step);
      activity.set(`round:${progress.step}`, progress.round);
      if (progress.status) activity.set(`status:${progress.step}:${progress.round}`, statusPosition[progress.status]);
      activity.set(`tools:${progress.step}`, progress.toolRounds ?? 0);
    }
    for (const tool of stream.tools?.values() ?? []) {
      if (tool.turnId === turn?.id && tool.generation === turn.generation)
        activity.set(`tool:${tool.id}`, tool.status === 'running' ? 1 : 2);
    }
    return activity;
  }, [preview, progress, stream.tools, turn?.id, turn?.generation]);
  const needsRecovery = stream.status !== 'open' || (!!preview?.text && !running && progress?.status !== 'done');
  useEffect(() => {
    const sync = () => {
      recovery.setOnline(navigator.onLine);
      recovery.setVisible(document.visibilityState !== 'hidden');
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
      recovery.stop();
    };
  }, [recovery]);
  useEffect(() => {
    recovery.update({ key, progress: activity, recovery: needsRecovery });
  }, [recovery, key, activity, needsRecovery]);
  const uncertain = useSyncExternalStore(recovery.subscribe, recovery.snapshot, recovery.snapshot);
  return { uncertain, retryStatus: recovery.retry };
}
