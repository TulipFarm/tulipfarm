import { assertRunActive } from "@tulipfarm/run-kernel";
import type { RuntimeBundle } from "@tulipfarm/soul";
import {
  type RoutineToolOutcome,
  BrokerRoutineToolPort as SharedBrokerRoutineToolPort,
  type BrokerRoutineToolPortOptions as SharedBrokerRoutineToolPortOptions,
  type RoutineToolRequest as SharedRoutineToolRequest,
  type ToolAdapter,
} from "@tulipfarm/tool-broker";
import { GITHUB_INSTALLATION_SECRET_REF, githubInstallationSecretRef } from "./github-credentials";

export type {
  RoutineOimPreparation,
  RoutineOimPreparationPort,
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
  extends Omit<
    SharedBrokerRoutineToolPortOptions,
    "adaptersFor" | "assertActive" | "credentialRefFor"
  > {
  readonly adaptersFor?: (request: RoutineToolRequest) => ReadonlyMap<string, ToolAdapter>;
}

function scopedCredentialRef(request: RoutineToolRequest): string | undefined {
  const ref = request.plan.credentialRef;
  if (ref !== GITHUB_INSTALLATION_SECRET_REF) return ref;
  const args = request.plan.arguments;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return ref;
  const source = args as Record<string, unknown>;
  const repository = source.repository;
  if (typeof repository === "string" && repository.length > 0) {
    return githubInstallationSecretRef({ kind: "repository", repository });
  }
  const owner = source.owner;
  if (typeof owner === "string" && owner.length > 0) {
    return githubInstallationSecretRef({ kind: "account", owner });
  }
  return ref;
}

/** Worker compatibility wrapper that supplies Run cancellation and legacy GitHub scoping. */
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
      credentialRefFor: (request) => scopedCredentialRef(request as RoutineToolRequest),
    });
  }
}
