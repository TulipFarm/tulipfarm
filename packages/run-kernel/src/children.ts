/**
 * Child authority is parent ∩ requested authority; unavailable Tools, classifications, and limits
 * are denied with evidence rather than clipped.
 */
export interface ChildAuthority {
  readonly tools: readonly string[];
  readonly classifications: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
}

export type RequestedChildAuthority = {
  readonly tools?: readonly string[];
  readonly classifications?: readonly string[];
  readonly limits?: Readonly<Record<string, number>>;
};

export interface ChildResumeGrant {
  readonly waitId: string;
  readonly token: string;
}

/**
 * Whether this link *granted* the child its authority, or only records who called whom.
 *
 * `delegated` binds: the child's own Tool loop is intersected with `authority`, which is what a
 * helper Agent needs, because a model invented its task at runtime.
 *
 * `lineage` does not bind: the child is a published definition whose authority was reviewed when
 * it was authored. Depth, cancellation and audit still follow the link; only the narrowing is
 * skipped, so a Routine called as a child behaves exactly as it does alone.
 */
export type ChildAuthorityBinding = "delegated" | "lineage";

export interface ChildLink {
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly authority: ChildAuthority;
  readonly authorityBinding: ChildAuthorityBinding;
  /** How this child's completion resumes its parent; absent when nothing is waiting on it. */
  readonly resume: ChildResumeGrant | null;
  /** The parent Tool call that spawned this child; absent when nothing spawned it from a call. */
  readonly callId: string | null;
  readonly detachedAt: string | null;
  readonly createdAt: string;
}

export type ChildRunErrorCode = "child_authority_amplification" | "child_self_link";

/** Child-Run denial carrying the reason code and offending field only. */
export class ChildRunError extends Error {
  readonly name = "ChildRunError";

  constructor(
    readonly code: ChildRunErrorCode,
    readonly field = ""
  ) {
    super(`${code}${field ? `:${field}` : ""}`);
  }
}

/**
 * Reverse lookup over the parent/child link table. Depth and inherited authority are read from
 * the persisted chain rather than supplied by the caller, so a child cannot restart the count.
 */
export interface ChildLinkAncestry {
  parentLink(businessId: string, childRunId: string): Promise<ChildLink | null>;
  /** The child a parent Tool call already spawned, so a replayed call adopts it (see `spawn`). */
  callLink?(businessId: string, parentRunId: string, callId: string): Promise<ChildLink | null>;
}

export interface ChildLinkStore {
  link(input: {
    businessId: string;
    parentRunId: string;
    childRunId: string;
    authority: ChildAuthority;
    authorityBinding?: ChildAuthorityBinding;
    resume?: ChildResumeGrant;
    callId?: string;
    detachedAt?: string;
    createdAt: string;
  }): Promise<ChildLink>;
  detach(
    businessId: string,
    parentRunId: string,
    childRunId: string,
    detachedAt: string
  ): Promise<boolean>;
  listChildren(businessId: string, parentRunId: string): Promise<readonly ChildLink[]>;
}

export interface SpawnChildInput {
  readonly businessId: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly parentAuthority: ChildAuthority;
  readonly requestedAuthority: RequestedChildAuthority;
  /** Defaults to `delegated`; a caller that does not decide cannot accidentally unbind a child. */
  readonly authorityBinding?: ChildAuthorityBinding;
  /** Set when the parent parks on this child; omitted for a detached spawn. */
  readonly resume?: ChildResumeGrant;
  /** The parent Tool call this child answers; unique per parent, so a replay adopts this child. */
  readonly callId?: string;
  /**
   * Detach the child in the same write that links it, for a child that never resumes its parent.
   *
   * `spawn` then `detach` leaves the row briefly open, so a cancel cascade or a crash in that gap
   * can reach a child the caller was never going to wait on.
   */
  readonly detached?: boolean;
  readonly now: string;
}

export interface DetachChildInput {
  readonly businessId: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly now: string;
}

function narrowGrants(
  parent: readonly string[],
  requested: readonly string[] | undefined,
  field: "tools" | "classifications"
): readonly string[] {
  if (requested === undefined) return [...parent].sort();
  for (const grant of requested) {
    if (!parent.includes(grant)) throw new ChildRunError("child_authority_amplification", field);
  }
  return [...new Set(requested)].sort();
}

function narrowLimits(
  parent: Readonly<Record<string, number>>,
  requested: Readonly<Record<string, number>> | undefined
): Readonly<Record<string, number>> {
  const narrowed: Record<string, number> = { ...parent };
  for (const [key, value] of Object.entries(requested ?? {})) {
    const ceiling = parent[key];
    // An undeclared key is not "unbounded" for a child: it is authority the parent never held.
    if (ceiling === undefined || value > ceiling) {
      throw new ChildRunError("child_authority_amplification", key);
    }
    narrowed[key] = value;
  }
  return narrowed;
}

export function narrowChildAuthority(
  parent: ChildAuthority,
  requested: RequestedChildAuthority
): ChildAuthority {
  return {
    tools: narrowGrants(parent.tools, requested.tools, "tools"),
    classifications: narrowGrants(
      parent.classifications,
      requested.classifications,
      "classifications"
    ),
    limits: narrowLimits(parent.limits, requested.limits),
  };
}

/**
 * Parent/child links persist narrowed authority and are idempotent across retried spawns.
 */
export class ChildRunManager {
  constructor(
    private readonly store: ChildLinkStore,
    private readonly ancestry: ChildLinkAncestry
  ) {}

  /**
   * Links from `runId` upwards, nearest parent first, stopping at `limit` hops. Bounding the walk
   * is what makes an unbounded or cyclic chain a refusal rather than a hang.
   */
  async ancestors(businessId: string, runId: string, limit: number): Promise<readonly ChildLink[]> {
    const chain: ChildLink[] = [];
    const seen = new Set<string>([runId]);
    let current = runId;
    while (chain.length < limit) {
      const link = await this.ancestry.parentLink(businessId, current);
      if (link === null || seen.has(link.parentRunId)) break;
      chain.push(link);
      seen.add(link.parentRunId);
      current = link.parentRunId;
    }
    return chain;
  }

  async spawn(input: SpawnChildInput): Promise<ChildLink> {
    if (input.parentRunId === input.childRunId) {
      throw new ChildRunError("child_self_link", "childRunId");
    }
    const authority = narrowChildAuthority(input.parentAuthority, input.requestedAuthority);
    return this.store.link({
      businessId: input.businessId,
      parentRunId: input.parentRunId,
      childRunId: input.childRunId,
      authority,
      ...(input.authorityBinding === undefined ? {} : { authorityBinding: input.authorityBinding }),
      resume: input.resume,
      callId: input.callId,
      ...(input.detached === true ? { detachedAt: input.now } : {}),
      createdAt: input.now,
    });
  }

  async detach(input: DetachChildInput): Promise<boolean> {
    return this.store.detach(input.businessId, input.parentRunId, input.childRunId, input.now);
  }

  async listChildren(businessId: string, parentRunId: string): Promise<readonly ChildLink[]> {
    return this.store.listChildren(businessId, parentRunId);
  }
}
