import type { InternalApiClient } from "../internal/client";
import type { DrainableLoop } from "../shutdown";
import { defaultWait } from "./delivery-poll-loop";

interface SurfaceInteractionRecoveryDeps {
  readonly internalApi: InternalApiClient;
  readonly log: { warn: (message: string, error?: unknown) => void };
  readonly pollIntervalMs?: number;
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

async function recover(signal: AbortSignal, deps: SurfaceInteractionRecoveryDeps): Promise<void> {
  const wait = deps.wait ?? defaultWait;
  const intervalMs = deps.pollIntervalMs ?? 1_000;
  while (!signal.aborted) {
    try {
      await deps.internalApi.require("POST", "/api/v1/internal/surfaces/interactions/recover");
    } catch (error) {
      deps.log.warn("Surface interaction recovery failed", error);
    }
    await wait(intervalMs, signal);
  }
}

export function startSurfaceInteractionRecoveryLoop(
  signal: AbortSignal,
  deps: SurfaceInteractionRecoveryDeps
): DrainableLoop {
  return {
    name: "slack-surface-interaction-recovery",
    settled: recover(signal, deps),
  };
}
