import { assertRunActive } from "@tulipfarm/run-kernel";
import type { RuntimeBundle } from "@tulipfarm/soul";
import {
  type RoutineToolOutcome,
  BrokerRoutineToolPort as SharedBrokerRoutineToolPort,
  type BrokerRoutineToolPortOptions as SharedBrokerRoutineToolPortOptions,
  type RoutineToolRequest as SharedRoutineToolRequest,
  type ToolAdapter,
} from "@tulipfarm/tool-broker";

export type {
  RoutineMcpAuthorization,
  RoutineMcpPreparation,
  RoutineMcpPreparationPort,
  RoutineToolOutcome,
} from "@tulipfarm/tool-broker";

export type RoutineToolRequest = Omit<SharedRoutineToolRequest, "bundle"> & {
  readonly bundle: RuntimeBundle;
};

export interface RoutineToolPort {
  execute(request: RoutineToolRequest): Promise<RoutineToolOutcome>;
  replaySettled(request: RoutineToolRequest): Promise<RoutineToolOutcome>;
}

export interface BrokerRoutineToolPortOptions
  extends Omit<SharedBrokerRoutineToolPortOptions, "adaptersFor" | "assertActive"> {
  readonly adaptersFor?: (request: RoutineToolRequest) => ReadonlyMap<string, ToolAdapter>;
}

/** Supplies Run cancellation and adapters from the verified execution bundle. */
export class BrokerRoutineToolPort extends SharedBrokerRoutineToolPort {
  constructor(options: BrokerRoutineToolPortOptions) {
    const { adaptersFor, ...shared } = options;
    super({
      ...shared,
      ...(adaptersFor === undefined
        ? {}
        : {
            adaptersFor: (request: SharedRoutineToolRequest) =>
              adaptersFor(request as RoutineToolRequest),
          }),
      assertActive: assertRunActive,
    });
  }
}
