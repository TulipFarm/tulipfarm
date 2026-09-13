import type { EffectRetryParker, EffectRetryWaitReader } from "@tulipfarm/tool-broker";
import type { InternalApiClient } from "../internal/client";
import { HttpRoutineOimHost } from "../internal/routine-oim-host";
import { BrokerRoutineToolPort, type BrokerRoutineToolPortOptions } from "./tool-port";

export interface RoutineToolPortFactoryOptions
  extends Omit<BrokerRoutineToolPortOptions, "oim" | "parkRetry" | "retryWaitStatus"> {
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
    oim: new HttpRoutineOimHost(internalApi),
  });
}
