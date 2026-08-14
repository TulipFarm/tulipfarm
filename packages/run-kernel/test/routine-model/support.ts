/** Reference-model tests use seeded random cases, and failures print reproducible seeds. */

export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function intBetween(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

export function pick<T>(random: () => number, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) throw new Error("empty choice set");
  return value;
}

/** Run `body` over `count` seeded cases; the seed travels into the assertion message. */
export function forEachCase(
  count: number,
  body: (random: () => number, seed: number) => void
): void {
  for (let seed = 1; seed <= count; seed += 1) {
    try {
      body(seeded(seed * 2_654_435_761), seed);
    } catch (error) {
      throw new Error(`case seed=${seed}: ${error instanceof Error ? error.message : error}`);
    }
  }
}
