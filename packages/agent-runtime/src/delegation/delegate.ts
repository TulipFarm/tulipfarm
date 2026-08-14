import type {
  ChildAuthority,
  ChildLink,
  ChildRunManager,
  RequestedChildAuthority,
} from "@tulipfarm/run-kernel";
import { ajv, canonicalHash } from "@tulipfarm/schema";

/** Helpers are child Runs: authority, deadlines, and depth may only narrow. */

export type DelegationMode = "read_only" | "read_write";

export interface DelegationParentContext {
  readonly authority: ChildAuthority;
  readonly depth: number;
  readonly deadlineAt: string;
}

export interface RequestedDelegation extends RequestedChildAuthority {
  readonly mode?: DelegationMode;
  readonly deadlineAt?: string;
}

export interface DelegationRequest {
  readonly businessId: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly parent: DelegationParentContext;
  readonly requested: RequestedDelegation;
  readonly now: string;
}

export interface DelegatedHelper {
  readonly childRunId: string;
  readonly authority: ChildAuthority;
  readonly mode: DelegationMode;
  readonly depth: number;
  readonly deadlineAt: string;
  readonly link: ChildLink;
}

export type DelegationErrorCode = "depth_limit_exceeded" | "deadline_amplification";

/** Delegation denial carrying the reason code and offending field only. */
export class DelegationError extends Error {
  readonly name = "DelegationError";

  constructor(
    readonly code: DelegationErrorCode,
    readonly field = ""
  ) {
    super(`${code}${field ? `:${field}` : ""}`);
  }
}

export interface HelperArtifact {
  readonly childRunId: string;
  readonly schemaRef: string;
  readonly value: unknown;
  readonly digest: string;
}

export type ArtifactAcceptance =
  | { readonly outcome: "accepted"; readonly artifact: HelperArtifact }
  | { readonly outcome: "rejected"; readonly reason: "artifact_schema_mismatch" };

/** Which Tools carry no effect; the broker catalog is the source of truth behind it. */
export interface ReadOnlyToolOracle {
  isReadOnly(toolName: string): boolean;
}

export interface DelegationCoordinatorOptions {
  readonly children: ChildRunManager;
  readonly tools: ReadOnlyToolOracle;
  readonly policy: { readonly maxDepth: number };
}

export class DelegationCoordinator {
  constructor(private readonly options: DelegationCoordinatorOptions) {}

  async delegate(request: DelegationRequest): Promise<DelegatedHelper> {
    const depth = request.parent.depth + 1;
    if (depth > this.options.policy.maxDepth) {
      throw new DelegationError("depth_limit_exceeded", "depth");
    }

    const deadlineAt = request.requested.deadlineAt ?? request.parent.deadlineAt;
    if (Date.parse(deadlineAt) > Date.parse(request.parent.deadlineAt)) {
      throw new DelegationError("deadline_amplification", "deadlineAt");
    }

    const mode = request.requested.mode ?? "read_only";
    // A helper that did not ask for effects never gets them, even though the parent holds them.
    const tools =
      mode === "read_only"
        ? (request.requested.tools ?? request.parent.authority.tools).filter((tool) =>
            this.options.tools.isReadOnly(tool)
          )
        : request.requested.tools;

    const link = await this.options.children.spawn({
      businessId: request.businessId,
      parentRunId: request.parentRunId,
      childRunId: request.childRunId,
      parentAuthority: request.parent.authority,
      requestedAuthority: {
        ...(tools === undefined ? {} : { tools }),
        ...(request.requested.classifications === undefined
          ? {}
          : { classifications: request.requested.classifications }),
        ...(request.requested.limits === undefined ? {} : { limits: request.requested.limits }),
      },
      now: request.now,
    });

    return {
      childRunId: request.childRunId,
      authority: link.authority,
      mode,
      depth,
      deadlineAt,
      link,
    };
  }

  /** Explicit detach: the helper outlives parent cancellation from this point on. */
  async detach(input: {
    businessId: string;
    parentRunId: string;
    childRunId: string;
    now: string;
  }): Promise<boolean> {
    return this.options.children.detach(input);
  }

  async cancellationTargets(businessId: string, parentRunId: string): Promise<readonly string[]> {
    const attached = await this.options.children.listAttached(businessId, parentRunId);
    return attached.map((link) => link.childRunId);
  }

  acceptArtifact(input: {
    childRunId: string;
    schemaRef: string;
    schema: Readonly<Record<string, unknown>>;
    value: unknown;
  }): ArtifactAcceptance {
    const validate = ajv.compile(input.schema);
    if (!validate(input.value)) {
      return { outcome: "rejected", reason: "artifact_schema_mismatch" };
    }
    return {
      outcome: "accepted",
      artifact: {
        childRunId: input.childRunId,
        schemaRef: input.schemaRef,
        value: input.value,
        digest: canonicalHash({ schemaRef: input.schemaRef, value: input.value }),
      },
    };
  }
}
