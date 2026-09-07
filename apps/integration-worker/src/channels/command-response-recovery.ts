import type { InternalApiClient } from "../internal/client";
import type { DrainableLoop } from "../shutdown";
import { defaultWait } from "./delivery-poll-loop";

interface CommandResponseRecoveryDeps {
  readonly internalApi: InternalApiClient;
  readonly log: { warn: (message: string, error?: unknown) => void };
  readonly pollIntervalMs?: number;
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

async function recover(signal: AbortSignal, deps: CommandResponseRecoveryDeps): Promise<void> {
  const wait = deps.wait ?? defaultWait;
  const intervalMs = deps.pollIntervalMs ?? 1_000;
  while (!signal.aborted) {
    try {
      await deps.internalApi.require(
        "POST",
        "/api/v1/internal/channels/slack/command-responses/process"
      );
    } catch (error) {
      deps.log.warn("Slack command response recovery failed", error);
    }
    await wait(intervalMs, signal);
  }
}

export function startCommandResponseRecoveryLoop(
  signal: AbortSignal,
  deps: CommandResponseRecoveryDeps
): DrainableLoop {
  return {
    name: "slack-command-response-recovery",
    settled: recover(signal, deps),
  };
}
