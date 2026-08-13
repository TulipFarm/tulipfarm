/**
 * AccessGrant shape and matching per SPEC §12: a grant scopes an action to Resource
 * type/domain/Record selector, field selector, data class, destination, conditions, and expiry,
 * with an explicit allow/deny effect. Matching fails closed: a scoped grant never matches a request
 * that omits the scoped dimension, for allow and deny alike, so scoping is deterministic and a
 * grant cannot silently widen (SPEC §12 non-amplification, §24 fail-closed defaults).
 */

export type GrantEffect = "allow" | "deny";

export interface AccessGrant {
  /** Action identifier (e.g. "record.read") or "*" for any action. */
  readonly action: string;
  /** Resource type name or "*" for any type. */
  readonly resourceType: string;
  /**
   * Business-authored domain. Absent is conservative: it covers only domainless requests, not every
   * domain. Use "*" deliberately to cover every named domain.
   */
  readonly domain?: string;
  /** Specific Record id; absent or "*" covers every Record of the type. */
  readonly recordSelector?: string;
  /** Fields covered; absent covers every field. Present, it only matches field-level requests. */
  readonly fieldSelector?: readonly string[];
  /** Data classification the grant is scoped to; absent covers any classification. */
  readonly dataClass?: string;
  /** Destination/audience the grant is scoped to; absent covers any destination. */
  readonly destination?: string;
  /** Context conditions; every entry must equal the request's context value to match. */
  readonly conditions?: Readonly<Record<string, string>>;
  readonly effect: GrantEffect;
  /** The grant stops matching at this instant; absent means no expiry. */
  readonly expiresAt?: Date;
}

/** The concrete access being decided; absent optional dimensions mean "not narrowed here". */
export interface AccessRequest {
  readonly action: string;
  readonly resourceType: string;
  readonly domain?: string;
  readonly recordId?: string;
  readonly field?: string;
  readonly dataClass?: string;
  readonly destination?: string;
  readonly conditions?: Readonly<Record<string, string>>;
}

/**
 * True when `grant` covers `request` at `now`. Expired grants never match. Each scoped
 * dimension on the grant requires an equal value on the request — a request that omits a
 * scoped dimension does not match (fail closed).
 */
export function grantMatches(grant: AccessGrant, request: AccessRequest, now: Date): boolean {
  if (grant.expiresAt && grant.expiresAt <= now) return false;
  if (request.action === "*" || request.resourceType === "*" || request.domain === "*") {
    return false;
  }
  if (grant.action !== "*" && grant.action !== request.action) return false;
  if (grant.resourceType !== "*" && grant.resourceType !== request.resourceType) return false;
  if (grant.domain === undefined) {
    if (request.domain !== undefined) return false;
  } else if (grant.domain === "*") {
    if (request.domain === undefined) return false;
  } else if (grant.domain !== request.domain) {
    return false;
  }
  if (
    grant.recordSelector !== undefined &&
    grant.recordSelector !== "*" &&
    grant.recordSelector !== request.recordId
  ) {
    return false;
  }
  if (
    grant.fieldSelector !== undefined &&
    (request.field === undefined || !grant.fieldSelector.includes(request.field))
  ) {
    return false;
  }
  if (grant.dataClass !== undefined && grant.dataClass !== request.dataClass) return false;
  if (grant.destination !== undefined && grant.destination !== request.destination) return false;
  if (grant.conditions) {
    for (const [key, value] of Object.entries(grant.conditions)) {
      if (request.conditions?.[key] !== value) return false;
    }
  }
  return true;
}
