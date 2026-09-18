import type { EffectRetryParker, EffectRetryWaitReader } from "@tulipfarm/tool-broker";
import type { InternalApiClient } from "../internal/client";
import { HttpRoutineMcpHost } from "../internal/routine-mcp-host";
import { BrokerRoutineToolPort, type BrokerRoutineToolPortOptions } from "./tool-port";

export interface RoutineToolPortFactoryOptions
  extends Omit<BrokerRoutineToolPortOptions, "mcp" | "parkRetry" | "retryWaitStatus"> {
  readonly internalApi: InternalApiClient;
  readonly parkRetry: EffectRetryParker;
  readonly retryWaitStatus: EffectRetryWaitReader;
}

export function createRoutineToolPort(
  options: RoutineToolPortFactoryOptions
): BrokerRoutineToolPort {
  const { internalApi, ...broker } = options;
  return new BrokerRoutineToolPort({
    ...broker,
    mcp: new HttpRoutineMcpHost(internalApi),
  });
}
