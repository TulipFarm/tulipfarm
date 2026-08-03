export interface DrainableLoop {
  readonly name: string;
  /** Resolves when the loop's in-flight tick has settled and the loop has exited. */
  readonly settled: Promise<void>;
}

export type DrainOutcome =
  | { readonly status: "drained" }
  | { readonly status: "timed_out"; readonly pending: readonly string[] };

export interface DrainOptions {
  readonly loops: readonly DrainableLoop[];
  readonly abort: () => void;
  readonly timeoutMs: number;
  /** Injected in tests so the timeout is asserted without real time passing. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Stops accepting new work and waits for what is already claimed to finish.
 *
 * Empty today: no consumer loop is registered yet, so `drain` always resolves `"drained"`
 * immediately. Kept in place so the first real loop (Slack socket, delivery retry) only has to
 * push onto `loops` in the composition root, not rewrite this file.
 */
export async function drain(options: DrainOptions): Promise<DrainOutcome> {
  const sleep = options.sleep ?? delay;
  const pending = new Set(options.loops.map((loop) => loop.name));

  options.abort();

  const settled = Promise.all(
    options.loops.map(async (loop) => {
      await loop.settled;
      pending.delete(loop.name);
    })
  ).then(() => "drained" as const);

  const outcome = await Promise.race([
    settled,
    sleep(options.timeoutMs).then(() => "timed_out" as const),
  ]);

  if (outcome === "drained") return { status: "drained" };
  return { status: "timed_out", pending: [...pending] };
}
