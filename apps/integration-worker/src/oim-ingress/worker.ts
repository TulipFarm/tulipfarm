import type { DrainableLoop } from "../shutdown";

export interface OimIngressWorkerCycle {
  readonly drainInbox: () => Promise<unknown>;
  readonly pollConnections: () => Promise<unknown>;
  readonly recoverRegistrations: () => Promise<unknown>;
}

export interface OimIngressWorkerLogger {
  info(detail: Record<string, unknown>, message: string): void;
  error(detail: Record<string, unknown>, message: string): void;
}

export interface OimIngressWorkerOptions {
  readonly cycle: OimIngressWorkerCycle;
  readonly log: OimIngressWorkerLogger;
  readonly intervalMs?: number;
}

export interface OimIngressCycleResult {
  readonly inbox: unknown;
  readonly polling: unknown;
  readonly registrations: unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForNextCycle(signal: AbortSignal, intervalMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, intervalMs);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class OimIngressWorker {
  private readonly intervalMs: number;

  constructor(private readonly options: OimIngressWorkerOptions) {
    this.intervalMs = options.intervalMs ?? 5_000;
  }

  async runOnce(): Promise<OimIngressCycleResult> {
    const registrations = await this.options.cycle.recoverRegistrations();
    const polling = await this.options.cycle.pollConnections();
    const inbox = await this.options.cycle.drainInbox();
    return { inbox, polling, registrations };
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const result = await this.runOnce();
        this.options.log.info({ result }, "OIM ingress cycle completed");
      } catch (error) {
        this.options.log.error(
          { error: errorMessage(error) },
          "OIM ingress cycle failed and will retry"
        );
      }
      await waitForNextCycle(signal, this.intervalMs);
    }
  }
}

async function runTaskLoop(
  signal: AbortSignal,
  name: string,
  task: () => Promise<unknown>,
  log: OimIngressWorkerLogger,
  intervalMs: number
): Promise<void> {
  while (!signal.aborted) {
    try {
      const result = await task();
      log.info({ result }, `${name} completed`);
    } catch (error) {
      log.error({ error: errorMessage(error) }, `${name} failed and will retry`);
    }
    await waitForNextCycle(signal, intervalMs);
  }
}

export function startOimIngressLoops(
  signal: AbortSignal,
  options: OimIngressWorkerOptions
): DrainableLoop[] {
  const intervalMs = options.intervalMs ?? 5_000;
  return [
    {
      name: "oim-registration-recovery",
      settled: runTaskLoop(
        signal,
        "OIM registration recovery",
        options.cycle.recoverRegistrations,
        options.log,
        intervalMs
      ),
    },
    {
      name: "oim-polling-ingress",
      settled: runTaskLoop(
        signal,
        "OIM polling ingress",
        options.cycle.pollConnections,
        options.log,
        intervalMs
      ),
    },
    {
      name: "oim-delivery",
      settled: runTaskLoop(
        signal,
        "OIM delivery",
        options.cycle.drainInbox,
        options.log,
        intervalMs
      ),
    },
  ];
}
