import type { DrainableLoop } from "../shutdown";

export interface OimKnowledgeSyncRegistration {
  readonly id: string;
  sync(): Promise<{ readonly failures: readonly { readonly code: string }[] }>;
}

export interface OimKnowledgeSyncLoopDeps {
  readonly registrations: () => Promise<readonly OimKnowledgeSyncRegistration[]>;
  readonly pollIntervalMs?: number;
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly log: { warn: (message: string, error?: unknown) => void };
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;

function waitFor(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function runLoop(signal: AbortSignal, deps: OimKnowledgeSyncLoopDeps): Promise<void> {
  const wait = deps.wait ?? waitFor;
  while (!signal.aborted) {
    let registrations: readonly OimKnowledgeSyncRegistration[];
    try {
      registrations = await deps.registrations();
    } catch (error) {
      deps.log.warn("OIM Knowledge sync registration lookup failed", error);
      await wait(deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, signal);
      continue;
    }
    for (const registration of registrations) {
      if (signal.aborted) break;
      try {
        const result = await registration.sync();
        if (result.failures.length > 0) {
          deps.log.warn(
            `OIM Knowledge sync failed for ${registration.id}: ${result.failures
              .map(({ code }) => code)
              .join(",")}`
          );
        }
      } catch (error) {
        deps.log.warn(`OIM Knowledge sync crashed for ${registration.id}`, error);
      }
    }
    await wait(deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, signal);
  }
}

export function startOimKnowledgeSyncLoop(
  signal: AbortSignal,
  deps: OimKnowledgeSyncLoopDeps
): DrainableLoop {
  return { name: "oim-knowledge-sync", settled: runLoop(signal, deps) };
}
