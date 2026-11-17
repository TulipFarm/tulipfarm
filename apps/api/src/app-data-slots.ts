export const busy = Symbol('busy');

/**
 * Runs at most `slots` lookups at once in this process, at most `perKey` of them for one key. A call that finds no
 * slot waits up to `waitMs`. A freed slot goes to the key that has waited longest for a turn, and that key then waits
 * behind every other waiting key, so a key with many waiting calls delays another key by one turn per waiting key.
 *
 * At most `queue` calls wait at once. When the queue is full, a call from the key with the most waiting calls is
 * refused at once, and a call from any other key takes the place of that key's newest waiting call, so a key that
 * fills the queue cannot keep another key out of it.
 */
export function createFairSlots({
  slots,
  perKey,
  waitMs,
  queue: most,
}: {
  slots: number;
  perKey: number;
  waitMs: number;
  queue: number;
}) {
  type Waiter = { grant: () => void; refuse: () => void };
  let free = slots;
  let queued = 0;
  const held = new Map<string, number>();
  const turns = new Map<string, Waiter[]>();
  const take = (key: string) => {
    free--;
    held.set(key, (held.get(key) ?? 0) + 1);
  };
  const leave = (key: string, waiter: Waiter) => {
    const waiting = turns.get(key)!;
    waiting.splice(waiting.indexOf(waiter), 1);
    if (!waiting.length) turns.delete(key);
    queued--;
  };
  const release = (key: string) => {
    free++;
    const left = held.get(key)! - 1;
    if (left) held.set(key, left);
    else held.delete(key);
    for (const [next, waiting] of turns) {
      if ((held.get(next) ?? 0) >= perKey) continue;
      const waiter = waiting[0]!;
      leave(next, waiter);
      if (turns.delete(next)) turns.set(next, waiting);
      take(next);
      waiter.grant();
      return;
    }
  };
  const longest = () => {
    let found: Waiter[] = [];
    for (const waiting of turns.values()) if (waiting.length > found.length) found = waiting;
    return found;
  };
  const queue = (key: string) =>
    new Promise<boolean>(resolve => {
      if (queued >= most) {
        const crowded = longest();
        if ((turns.get(key)?.length ?? 0) >= crowded.length) return resolve(false);
        crowded.at(-1)!.refuse();
      }
      const timer = setTimeout(() => waiter.refuse(), waitMs);
      const waiter: Waiter = {
        grant: () => {
          clearTimeout(timer);
          resolve(true);
        },
        refuse: () => {
          clearTimeout(timer);
          leave(key, waiter);
          resolve(false);
        },
      };
      const waiting = turns.get(key);
      if (waiting) waiting.push(waiter);
      else turns.set(key, [waiter]);
      queued++;
    });
  return {
    /** Runs `work` in a slot for `key`, or returns `busy` when no slot frees up within `waitMs` or the queue is full. */
    async run<T>(key: string, work: () => Promise<T>): Promise<T | typeof busy> {
      if (free > 0 && (held.get(key) ?? 0) < perKey) take(key);
      else if (!(await queue(key))) return busy;
      try {
        return await work();
      } finally {
        release(key);
      }
    },
  };
}
