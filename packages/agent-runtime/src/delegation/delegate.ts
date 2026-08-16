import type {
  ChildAuthority,
  ChildLink,
  ChildRunManager,
  RequestedChildAuthority,
} from "@tulipfarm/run-kernel";
import { narrowChildAuthority } from "@tulipfarm/run-kernel";

/** Helpers are child Runs: authority, deadlines, and depth may only narrow. */

export type DelegationMode = "read_only" | "read_write";

/**
 * The delegation deadline travels as a limit so run-kernel's `narrowChildAuthority` enforces its
 * monotonic narrowing, and the ceiling a grandchild is measured against is the immutable link row
 * rather than whatever the delegating turn claims.
 */
export const DELEGATION_DEADLINE_LIMIT_KEY = "delegationDeadlineEpochMs";

export interface RequestedDelegation extends RequestedChildAuthority {
  readonly mode?: DelegationMode;
  readonly deadlineAt?: string;
}

export interface DelegationRequest {
  readonly businessId: string;
  readonly parentRunId: string;
  readonly agentId: string;
  readonly task: string;
  readonly context?: Record<string, unknown>;
  /** Applies only when the parent Run is itself unlinked; a linked parent uses its own row. */
  readonly rootAuthority: ChildAuthority;
  readonly requested: RequestedDelegation;
  readonly now: string;
}

export interface DelegatedHelper {
  readonly childRunId: string;
  readonly conversationId: string;
  readonly authority: ChildAuthority;
  readonly mode: DelegationMode;
  readonly depth: number;
  readonly deadlineAt: string;
  readonly link: ChildLink;
}

export type DelegationErrorCode =
  | "depth_limit_exceeded"
  | "deadline_amplification"
  | "deadline_unbounded";

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

/** Which Tools carry no effect; the broker catalog is the source of truth behind it. */
export interface ReadOnlyToolOracle {
  isReadOnly(toolName: string): boolean;
}

export interface StartChildRunInput {
  readonly businessId: string;
  readonly parentRunId: string;
  readonly agentId: string;
  readonly task: string;
  readonly context?: Record<string, unknown>;
  readonly authority: ChildAuthority;
  readonly deadlineAt: string;
  readonly depth: number;
}

/**
 * Mints the durable child Run. Held privately by `DelegationCoordinator` so depth, deadline, and
 * authority narrowing cannot be bypassed by starting a child Run beside the guard.
 */
export interface ChildRunStarter {
  start(
    input: StartChildRunInput
  ): Promise<{ readonly childRunId: string; readonly conversationId: string }>;
  cancel(businessId: string, childRunId: string, reason: string): Promise<void>;
}

export interface DelegationCoordinatorOptions {
  readonly children: ChildRunManager;
  readonly tools: ReadOnlyToolOracle;
  readonly starter: ChildRunStarter;
  readonly policy: { readonly maxDepth: number };
}

export class DelegationCoordinator {
  constructor(private readonly options: DelegationCoordinatorOptions) {}

  async delegate(request: DelegationRequest): Promise<DelegatedHelper> {
    const { maxDepth } = this.options.policy;
    // One hop past the ceiling is enough to prove the ceiling was passed; walking the whole chain
    // would let a long history decide how much work a refusal costs.
    const chain = await this.options.children.ancestors(
      request.businessId,
      request.parentRunId,
      maxDepth + 1
    );
    const depth = chain.length + 1;
    if (depth > maxDepth) throw new DelegationError("depth_limit_exceeded", "depth");

    const parentAuthority = chain[0]?.authority ?? request.rootAuthority;
    const parentDeadlineMs = parentAuthority.limits[DELEGATION_DEADLINE_LIMIT_KEY];
    if (parentDeadlineMs === undefined) {
      throw new DelegationError("deadline_unbounded", DELEGATION_DEADLINE_LIMIT_KEY);
    }
    const requestedMs =
      request.requested.deadlineAt === undefined
        ? parentDeadlineMs
        : Date.parse(request.requested.deadlineAt);
    if (!Number.isFinite(requestedMs) || requestedMs > parentDeadlineMs) {
      throw new DelegationError("deadline_amplification", "deadlineAt");
    }
    const deadlineAt = new Date(requestedMs).toISOString();

    const mode = request.requested.mode ?? "read_only";
    // A helper that did not ask for effects never gets them, even though the parent holds them.
    const tools =
      mode === "read_only"
        ? (request.requested.tools ?? parentAuthority.tools).filter((tool) =>
            this.options.tools.isReadOnly(tool)
          )
        : request.requested.tools;

    const authority = narrowChildAuthority(parentAuthority, {
      ...(tools === undefined ? {} : { tools }),
      ...(request.requested.classifications === undefined
        ? {}
        : { classifications: request.requested.classifications }),
      limits: { ...request.requested.limits, [DELEGATION_DEADLINE_LIMIT_KEY]: requestedMs },
    });

    const started = await this.options.starter.start({
      businessId: request.businessId,
      parentRunId: request.parentRunId,
      agentId: request.agentId,
      task: request.task,
      ...(request.context === undefined ? {} : { context: request.context }),
      authority,
      deadlineAt,
      depth,
    });

    let link: ChildLink;
    try {
      link = await this.options.children.spawn({
        businessId: request.businessId,
        parentRunId: request.parentRunId,
        childRunId: started.childRunId,
        parentAuthority,
        requestedAuthority: authority,
        now: request.now,
      });
    } catch (error) {
      // An unlinked child would run outside parent cancellation and outside the depth chain, so
      // failing to record the link has to unmake the Run rather than leave it loose.
      await this.options.starter.cancel(
        request.businessId,
        started.childRunId,
        "child_link_failed"
      );
      throw error;
    }

    return {
      childRunId: started.childRunId,
      conversationId: started.conversationId,
      authority: link.authority,
      mode,
      depth,
      deadlineAt,
      link,
    };
  }
}
