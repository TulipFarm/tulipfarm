import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ConversationHistory } from './conversation-api';
import type { ConversationStreamSnapshot } from './conversation-stream';
import { reconcileLiveTools } from './live-tools.ts';

type ReplyCheck = { key: string | null; revision: string; recovery: boolean };
const recoveryDelays = [1000, 2000, 5000];

/** Recovery reads have one budget per saved attempt, not a new budget for every text chunk or reconnect. */
export function createReplyResync(refresh: () => Promise<void>) {
  let input: ReplyCheck = { key: null, revision: '', recovery: false };
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
      if (next.key === input.key && next.revision === input.revision && next.recovery === input.recovery) return;
      if (next.key !== input.key) {
        checks = 0;
        publish(false);
      }
      input = next;
      clear();
      if (!input.key || !input.recovery) publish(false);
      schedule();
    },
    setVisible(next: boolean) {
      visible = next;
      clear();
      schedule();
    },
    setOnline(next: boolean) {
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
      input = { key: null, revision: '', recovery: false };
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
  const revision = JSON.stringify([
    turn?.status,
    preview?.identity,
    preview?.seq,
    progress,
    message?.tools.map(tool => [tool.id, tool.status, tool.activityStatus]),
  ]);
  const needsRecovery = stream.status !== 'open' || (!!preview?.text && !running && progress?.status !== 'done');
  useEffect(() => {
    const sync = () => {
      recovery.setVisible(document.visibilityState !== 'hidden');
      recovery.setOnline(navigator.onLine);
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
    recovery.update({ key, revision, recovery: needsRecovery });
  }, [recovery, key, revision, needsRecovery]);
  const uncertain = useSyncExternalStore(recovery.subscribe, recovery.snapshot, recovery.snapshot);
  return { uncertain, retryStatus: recovery.retry };
}
