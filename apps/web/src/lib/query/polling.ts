import { type QueryClient, type QueryKey, hashKey } from '@tanstack/react-query';

/** A fixed delay, or a delay chosen from the number of checks the entry has made since its last reset. */
export type PollInterval = number | ((checks: number) => number);
type Poll = {
  pending: () => boolean;
  enabled?: () => boolean;
  interval: PollInterval;
  maxChecks: number;
  maxDuration?: number;
};

/** Fast at first, then slower, never stopping: 500 ms for 20 checks, 2 s until 60 checks, then 5 s. */
export const replyBackoff = (checks: number) => (checks < 20 ? 500 : checks < 60 ? 2000 : 5000);
const delay = (poll: Poll, checks: number) =>
  typeof poll.interval === 'number' ? poll.interval : poll.interval(checks);
type Entry = {
  key: QueryKey;
  readers: Set<Poll>;
  checks: number;
  startedAt?: number | undefined;
  checking?: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
};

/** One timer and budget per cache key, regardless of the number of React observers. */
export function createPolling(client: QueryClient, visible: () => boolean, online: () => boolean) {
  const entries = new Map<string, Entry>();
  const revalidations = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const policy = (entry: Entry) =>
    [...entry.readers]
      .filter(reader => reader.enabled?.() !== false && (revalidations.has(hashKey(entry.key)) || reader.pending()))
      .sort((a, b) => delay(a, entry.checks) - delay(b, entry.checks))[0];
  const clear = (entry: Entry) => {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  };
  const remaining = (entry: Entry, poll: Poll) =>
    poll.maxDuration === undefined || entry.startedAt === undefined
      ? Infinity
      : poll.maxDuration - (Date.now() - entry.startedAt);
  const exhausted = (entry: Entry, poll: Poll) => entry.checks >= poll.maxChecks || remaining(entry, poll) <= 0;
  const schedule = (entry: Entry) => {
    const query = client.getQueryCache().find({ queryKey: entry.key, exact: true });
    const poll = policy(entry);
    const revalidate = revalidations.has(hashKey(entry.key));
    if (
      !visible() ||
      !online() ||
      !query?.isActive() ||
      query.state.fetchStatus !== 'idle' ||
      query.state.error ||
      !poll ||
      (!revalidate && exhausted(entry, poll))
    ) {
      clear(entry);
      return;
    }
    if (!revalidate && poll.maxDuration !== undefined) entry.startedAt ??= Date.now();
    if (entry.timer !== undefined) return;
    entry.timer = setTimeout(
      () => {
        entry.timer = undefined;
        const current = policy(entry);
        if (!visible() || !online() || !current) return;
        const revalidate = revalidations.has(hashKey(entry.key));
        if (!revalidate && exhausted(entry, current)) {
          notify();
          return;
        }
        entry.checking = !revalidate;
        if (!revalidate) entry.checks++;
        notify();
        void client
          .refetchQueries({ queryKey: entry.key, exact: true, type: 'active' }, { cancelRefetch: false })
          .finally(() => {
            entry.checking = false;
            schedule(entry);
          });
      },
      revalidate ? delay(poll, entry.checks) : Math.min(delay(poll, entry.checks), remaining(entry, poll)),
    );
  };
  return {
    revalidate(key: QueryKey) {
      revalidations.add(hashKey(key));
      const entry = entries.get(hashKey(key));
      if (entry) {
        clear(entry);
        schedule(entry);
      }
    },
    settled(key: QueryKey) {
      revalidations.delete(hashKey(key));
    },
    register(key: QueryKey, poll: Poll) {
      const hash = hashKey(key);
      let entry = entries.get(hash);
      if (!entry) {
        entry = { key, readers: new Set(), checks: 0, timer: undefined };
        entries.set(hash, entry);
      }
      entry.readers.add(poll);
      schedule(entry);
      return () => {
        entry.readers.delete(poll);
        schedule(entry);
      };
    },
    sync: () => {
      for (const entry of entries.values()) schedule(entry);
      notify();
    },
    pause: () => {
      for (const entry of entries.values()) clear(entry);
    },
    reset(key: QueryKey) {
      const entry = entries.get(hashKey(key));
      if (entry) {
        entry.checks = 0;
        entry.startedAt = undefined;
        entry.checking = false;
        clear(entry);
        schedule(entry);
        notify();
      }
    },
    checking(key: QueryKey) {
      return entries.get(hashKey(key))?.checking === true;
    },
    delayed(key: QueryKey) {
      const entry = entries.get(hashKey(key));
      const poll = entry && policy(entry);
      return !!entry && !!poll && exhausted(entry, poll);
    },
    remove(key: QueryKey) {
      const hash = hashKey(key);
      const entry = entries.get(hash);
      if (entry) clear(entry);
      entries.delete(hash);
      revalidations.delete(hash);
      notify();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear() {
      for (const entry of entries.values()) clear(entry);
      entries.clear();
      revalidations.clear();
      notify();
    },
  };
}
