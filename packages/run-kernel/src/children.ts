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

export interface ChildLink {
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly authority: ChildAuthority;
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

  async detach(input: DetachChildInput): Promise<boolean> {
    return this.store.detach(input.businessId, input.parentRunId, input.childRunId, input.now);
  }

  async listChildren(businessId: string, parentRunId: string): Promise<readonly ChildLink[]> {
    return this.store.listChildren(businessId, parentRunId);
  }

  async listAttached(businessId: string, parentRunId: string): Promise<readonly ChildLink[]> {
    const links = await this.store.listChildren(businessId, parentRunId);
    return links.filter((link) => link.detachedAt === null);
  }
}
