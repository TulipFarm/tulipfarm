import {
  type AuthorityLayer,
  compileRoutineAuthority,
  decideEffectivePermission,
} from "@tulipfarm/authz";
import type { ToolContractDefinition } from "@tulipfarm/schema";
import {
  type BundleStore,
  type BundleVerifier,
  type RuntimeBundle,
  verifyExecutionBundle,
} from "@tulipfarm/soul";
import type { PersistedRun, PersistedState, RunBundle, RunStore } from "@tulipfarm/storage";
import type { ToolTargetRef } from "@tulipfarm/tool-broker";
import {
  agentCapabilityDenial,
  type LiveAuthorityLayerResolver,
  principalKindOf,
} from "@tulipfarm/tool-host";
import type { RunAuthority } from "./turn-host";

export interface RoutineMcpClaimEvidence {
  readonly leaseOwner: string;
  readonly leaseGeneration: number;
}

export interface RoutineMcpClaimedRun {
  readonly authority: RunAuthority;
  readonly bundle: RunBundle;
  readonly state: Pick<PersistedState, "key" | "definitionRef" | "status">;
}

export interface RoutineMcpRunAuthority {
  claim(input: {
    readonly businessId: string;
    readonly runId: string;
    readonly stateKey: string;
    readonly claim: RoutineMcpClaimEvidence;
  }): Promise<RoutineMcpClaimedRun | undefined>;
}

export interface RoutineMcpBundleReader {
  load(businessId: string, digest: string): Promise<RuntimeBundle | undefined>;
}

export class VerifiedRoutineMcpBundleReader implements RoutineMcpBundleReader {
  constructor(
    private readonly bundles: Pick<BundleStore, "get">,
    private readonly verifier: BundleVerifier
  ) {}

  async load(businessId: string, digest: string) {
    const record = await this.bundles.get(digest);
    if (record === undefined) return undefined;
    const bundle = verifyExecutionBundle(record, this.verifier);
    return bundle.businessId === businessId && bundle.digest === digest ? bundle : undefined;
  }
}

export class LiveRoutineMcpRunAuthority implements RoutineMcpRunAuthority {
  constructor(
    private readonly host: {
      authority(businessId: string, runId: string): Promise<RunAuthority>;
    },
    private readonly runs: Pick<RunStore, "find" | "findState">,
    private readonly now: () => Date = () => new Date()
  ) {}

  async claim(input: Parameters<RoutineMcpRunAuthority["claim"]>[0]) {
    const initial = await this.runs.find(input.businessId, input.runId);
    if (!this.valid(initial, input.claim)) return undefined;
    const initialState = await this.runs.findState(input.businessId, input.runId, input.stateKey);
    if (initialState?.status !== "running") return undefined;
    const authority = await this.host.authority(input.businessId, input.runId);
    const state = await this.runs.findState(input.businessId, input.runId, input.stateKey);
    const current = await this.runs.find(input.businessId, input.runId);
    if (
      !this.valid(current, input.claim) ||
      state?.status !== "running" ||
      state.definitionRef !== initialState.definitionRef ||
      state.version !== initialState.version ||
      current.source !== initial.source ||
      current.bundle.digest !== initial.bundle.digest ||
      current.bundle.routineId !== initial.bundle.routineId ||
      current.bundle.routineVersion !== initial.bundle.routineVersion ||
      authority.businessId !== current.businessId ||
      authority.runId !== current.id ||
      authority.bundleDigest !== current.bundle.digest
    ) {
      return undefined;
    }
    return { authority, bundle: current.bundle, state };
  }

  private valid(run: PersistedRun | null, claim: RoutineMcpClaimEvidence): run is PersistedRun {
    return (
      run !== null &&
      run.status === "running" &&
      run.leaseOwner === claim.leaseOwner &&
      run.leaseGeneration === claim.leaseGeneration &&
      run.leaseExpiresAt !== null &&
      new Date(run.leaseExpiresAt).getTime() > this.now().getTime()
    );
  }
}

export interface RoutineMcpLiveAuthorizer {
  authorize(input: {
    readonly authority: RunAuthority;
    readonly contract: ToolContractDefinition;
    readonly arguments: unknown;
    readonly targetRefs: readonly ToolTargetRef[];
    readonly destination?: string;
  }): Promise<boolean>;
}

export class LiveRoutineMcpAuthorizer implements RoutineMcpLiveAuthorizer {
  constructor(private readonly layers: Pick<LiveAuthorityLayerResolver, "resolvePrincipalLayer">) {}

  async authorize(input: Parameters<RoutineMcpLiveAuthorizer["authorize"]>[0]) {
    const { authority, contract } = input;
    if (authority.agent?.unresolvedRef !== undefined) return false;
    if (
      authority.agent?.toolAllowlist !== undefined &&
      !authority.agent.toolAllowlist.includes(contract.spec.toolId)
    ) {
      return false;
    }
    if (
      agentCapabilityDenial(
        authority.agent?.capabilityRestrictions,
        { name: contract.spec.toolId, mutating: contract.spec.mutating },
        input.arguments
      ) !== undefined
    ) {
      return false;
    }
    const kind = principalKindOf(authority.subject.kind);
    if (kind === undefined) return false;
    const caller = await this.layers.resolvePrincipalLayer(kind, {
      id: authority.subject.id,
      businessId: authority.businessId,
      kind,
    });
    const layers: AuthorityLayer[] = [
      caller,
      {
        name: `routine:${authority.routineId}`,
        grants: compileRoutineAuthority([contract]),
      },
    ];
    if (authority.agent?.principalId !== undefined) {
      layers.push(
        await this.layers.resolvePrincipalLayer("agent", {
          id: authority.agent.principalId,
          businessId: authority.businessId,
          kind: "agent",
        })
      );
    }
    const actions = contract.spec.requiredActions?.length
      ? contract.spec.requiredActions
      : [contract.spec.action];
    const targets =
      input.targetRefs.length > 0
        ? input.targetRefs
        : (contract.spec.requiredResources ?? ["integration"]).map((type) => ({ type }));
    return actions.every((action) =>
      targets.every(
        (target) =>
          decideEffectivePermission(layers, {
            action,
            resourceType: target.type,
            recordId: "id" in target ? target.id : undefined,
            domain: "domain" in target ? target.domain : undefined,
            dataClass: contract.spec.dataClasses?.[0],
            destination: input.destination,
          }).allowed
      )
    );
  }
}
