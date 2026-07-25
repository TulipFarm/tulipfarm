/**
 * Authority a Run may exercise. A child Run's authority is always the intersection of its parent's
 * authority with what the child asked for (SPEC §7.3): Tools and classifications the parent does
 * not hold, and limits above the parent's ceilings, are denied rather than clipped, so an
 * amplification attempt leaves evidence instead of quietly succeeding.
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

export interface ChildLink {
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly authority: ChildAuthority;
  /** Set once the child was explicitly detached; a detached child stops taking propagation. */
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

/** Narrow surface the manager needs; `@tulipfarm/storage`'s `ChildLinkStore` satisfies it. */
export interface ChildLinkStore {
  link(input: {
    businessId: string;
    parentRunId: string;
    childRunId: string;
    authority: ChildAuthority;
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

/** Intersects a requested child authority with its parent's. Never broadens. */
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
 * Persisted parent/child Run links (SPEC §7.3). The link records the *narrowed* authority the
 * child actually runs under, so cancellation propagation and audit read the same durable fact.
 * Linking is idempotent: a retried spawn after a crash re-reads the original link rather than
 * re-deriving — and possibly re-widening — authority.
 */
export class ChildRunManager {
  constructor(private readonly store: ChildLinkStore) {}

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
      createdAt: input.now,
    });
  }

  /** Explicitly detaches a child so it outlives parent cancellation. Returns false if already detached. */
  async detach(input: DetachChildInput): Promise<boolean> {
    return this.store.detach(input.businessId, input.parentRunId, input.childRunId, input.now);
  }

  async listChildren(businessId: string, parentRunId: string): Promise<readonly ChildLink[]> {
    return this.store.listChildren(businessId, parentRunId);
  }

  /** Children still taking propagation from the parent. */
  async listAttached(businessId: string, parentRunId: string): Promise<readonly ChildLink[]> {
    const links = await this.store.listChildren(businessId, parentRunId);
    return links.filter((link) => link.detachedAt === null);
  }
}
