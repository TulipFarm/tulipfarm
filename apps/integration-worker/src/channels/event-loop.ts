import type { ConsumerReadiness } from "../consumer-readiness";
import type { InternalApiClient } from "../internal/client";
import type { DrainableLoop } from "../shutdown";
import { defaultWait } from "./delivery-poll-loop";

export interface NativeEventDrainResult {
  readonly claimed: number;
  readonly dispatched: number;
  readonly denied: number;
  readonly retrying: number;
}

export interface NativeEventLoopDeps {
  readonly internalApi: Pick<InternalApiClient, "require">;
  readonly readiness: ConsumerReadiness;
  readonly log: { warn(message: string, error?: unknown): void };
  readonly wait?: typeof defaultWait;
}

export function startNativeEventLoop(
  signal: AbortSignal,
  deps: NativeEventLoopDeps
): DrainableLoop {
  const cycle = deps.readiness.track("native-events", async () => {
    const result = await deps.internalApi.require<NativeEventDrainResult>(
      "POST",
      "/api/v1/internal/channels/events/drain",
      { limit: 20 }
    );
    for (const value of [result.claimed, result.dispatched, result.denied, result.retrying]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 20) {
        throw new Error("native_event_drain_contract_invalid");
      }
    }
    return result;
  });
  return {
    name: "native-channel-events",
    settled: (async () => {
      while (!signal.aborted) {
        try {
          await cycle();
        } catch (error) {
          deps.log.warn("Native channel event dispatch unavailable", error);
        }
        await (deps.wait ?? defaultWait)(1000, signal);
      }
    })(),
  };
}
