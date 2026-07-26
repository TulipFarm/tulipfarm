export const REQUIRED_CUTOVER_SURFACES = [
  "chat",
  "manual_trigger",
  "webhook",
  "schedule",
  "channel",
  "integration",
] as const;

export type CutoverSurface = (typeof REQUIRED_CUTOVER_SURFACES)[number];

export interface CutoverPlan {
  readonly id: string;
  readonly targetDigest: string;
  readonly routes: Readonly<
    Record<
      CutoverSurface,
      {
        readonly createsRun: boolean;
        readonly externalMutations: "tool_broker" | "direct";
      }
    >
  >;
  readonly components: {
    readonly api: string;
    readonly worker: string;
    readonly integrationWorker: string;
  };
}

export interface ConvertedSoul {
  readonly files: readonly {
    readonly operation: "upsert" | "delete";
    readonly path: string;
    readonly content?: string;
  }[];
  readonly warnings: readonly unknown[];
}

export interface CutoverDependencies {
  readonly backup: {
    verify(): Promise<{ readonly archiveId: string; readonly verifiedAt: string }>;
  };
  readonly conversion: {
    convert(input: unknown): ConvertedSoul;
  };
  readonly proposals: {
    submit(input: {
      readonly source: "migration";
      readonly approvedBy: string;
      readonly files: ConvertedSoul["files"];
    }): Promise<{ readonly proposalId: string }>;
    approve(proposalId: string, approvedBy: string): Promise<void>;
  };
  readonly routing: {
    preview(plan: CutoverPlan): Promise<void>;
    verifyRollback(plan: CutoverPlan): Promise<void>;
    activate(plan: CutoverPlan): Promise<void>;
    rollback(plan: CutoverPlan): Promise<void>;
  };
  readonly smoke: {
    run(plan: CutoverPlan): Promise<{
      readonly surfaces: readonly CutoverSurface[];
      readonly deniedAccess: boolean;
      readonly allMutationsHaveEffects: boolean;
    }>;
  };
  readonly audit: {
    record(evidence: {
      readonly action: "cutover.activated";
      readonly actorId: string;
      readonly backupId: string;
      readonly planId: string;
      readonly proposalId: string;
      readonly targetDigest: string;
    }): Promise<void>;
  };
}

export type CutoverErrorCode = "unsafe_route_plan" | "conversion_warning" | "smoke_failed";

export class CutoverError extends Error {
  constructor(
    readonly code: CutoverErrorCode,
    readonly reference: string
  ) {
    super(`${code}:${reference}`);
    this.name = "CutoverError";
  }
}

function assertPlan(plan: CutoverPlan): void {
  for (const surface of REQUIRED_CUTOVER_SURFACES) {
    const route = plan.routes[surface];
    if (!route?.createsRun || route.externalMutations !== "tool_broker") {
      throw new CutoverError("unsafe_route_plan", surface);
    }
  }
}

function smokePassed(smoke: Awaited<ReturnType<CutoverDependencies["smoke"]["run"]>>): boolean {
  const surfaces = new Set(smoke.surfaces);
  return (
    smoke.deniedAccess &&
    smoke.allMutationsHaveEffects &&
    REQUIRED_CUTOVER_SURFACES.every((surface) => surfaces.has(surface))
  );
}

export class CutoverCoordinator {
  constructor(private readonly dependencies: CutoverDependencies) {}

  async execute(input: {
    readonly plan: CutoverPlan;
    readonly legacySoul: unknown;
    readonly approvedBy: string;
  }): Promise<{
    readonly status: "active";
    readonly backupId: string;
    readonly proposalId: string;
    readonly planId: string;
  }> {
    assertPlan(input.plan);
    const backup = await this.dependencies.backup.verify();
    const converted = this.dependencies.conversion.convert(input.legacySoul);
    if (converted.warnings.length > 0) {
      throw new CutoverError("conversion_warning", input.plan.id);
    }
    const proposal = await this.dependencies.proposals.submit({
      source: "migration",
      approvedBy: input.approvedBy,
      files: converted.files,
    });
    await this.dependencies.proposals.approve(proposal.proposalId, input.approvedBy);
    await this.dependencies.routing.preview(input.plan);
    await this.dependencies.routing.verifyRollback(input.plan);
    await this.dependencies.routing.activate(input.plan);

    const smoke = await this.dependencies.smoke.run(input.plan);
    if (!smokePassed(smoke)) {
      await this.dependencies.routing.rollback(input.plan);
      throw new CutoverError("smoke_failed", input.plan.id);
    }

    await this.dependencies.audit.record({
      action: "cutover.activated",
      actorId: input.approvedBy,
      backupId: backup.archiveId,
      planId: input.plan.id,
      proposalId: proposal.proposalId,
      targetDigest: input.plan.targetDigest,
    });
    return {
      status: "active",
      backupId: backup.archiveId,
      proposalId: proposal.proposalId,
      planId: input.plan.id,
    };
  }
}
