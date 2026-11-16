export const busy = Symbol('busy');

/**
 * Runs at most `slots` lookups at once in this process, at most `perKey` of them for one key. A call that finds no
 * slot waits up to `waitMs`. A freed slot goes to the key that has waited longest for a turn, and that key then waits
 * behind every other waiting key, so a key with many waiting calls delays another key by one turn per waiting key.
 */
export function createFairSlots({ slots, perKey, waitMs }: { slots: number; perKey: number; waitMs: number }) {
  type Waiter = { grant: () => boolean };
  let free = slots;
  const held = new Map<string, number>();
  const turns = new Map<string, Waiter[]>();
  const take = (key: string) => {
    free--;
    held.set(key, (held.get(key) ?? 0) + 1);
  };
  const release = (key: string) => {
    free++;
    const left = held.get(key)! - 1;
    if (left) held.set(key, left);
    else held.delete(key);
    for (const [next, waiting] of turns) {
      if ((held.get(next) ?? 0) >= perKey) continue;
      turns.delete(next);
      while (waiting.length) {
        if (!waiting.shift()!.grant()) continue;
        if (waiting.length) turns.set(next, waiting);
        take(next);
        return;
      }
    }
  };
  const queue = (key: string) =>
    new Promise<boolean>(resolve => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        resolve(false);
      }, waitMs);
      const waiter = {
        grant: () => {
          if (settled) return false;
          clearTimeout(timer);
          resolve(true);
          return (settled = true);
        },
      };
      const waiting = turns.get(key);
      if (waiting) waiting.push(waiter);
      else turns.set(key, [waiter]);
    });
  return {
    /** Runs `work` in a slot for `key`, or returns `busy` when no slot frees up within `waitMs`. */
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
