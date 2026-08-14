import type { ToolTargetRef } from "./intent";

/** L5 checks provider-side human entitlement for shared bot credentials. */

export interface EntitlementQuery {
  readonly businessId: string;
  readonly principal: { readonly kind: string; readonly id: string };
  /** Integration slug the Tool declared, e.g. `github`. */
  readonly provider: string;
  readonly action: string;
  /** What the call reaches, as derived by the Tool's own `targets(args)`. */
  readonly targetRefs: readonly ToolTargetRef[];
}

export interface EntitlementVerdict {
  readonly allowed: boolean;
  /** Written for the model and the person reading the turn; never a raw provider error. */
  readonly reason?: string;
}

/** No provider-side question applies; distinct from confirmed allow or failed determination. */
export const NOT_APPLICABLE = "not_applicable" as const;
export type EntitlementNotApplicable = typeof NOT_APPLICABLE;

export type EntitlementAnswer = EntitlementVerdict | EntitlementNotApplicable | undefined;

export interface ToolEntitlementPort {
  /** The integration slug this port speaks for. One port answers for exactly one provider. */
  readonly provider: string;
  check(query: EntitlementQuery): Promise<EntitlementAnswer>;
}

/** `covers` reports missing provider ports as known gaps, not failed entitlement checks. */
export class CompositeToolEntitlement {
  private readonly ports: Map<string, ToolEntitlementPort>;

  constructor(ports: readonly ToolEntitlementPort[]) {
    this.ports = new Map(ports.map((port) => [port.provider, port]));
  }

  /** Providers with a per-principal entitlement model. Everything else is an unguarded gap. */
  coveredProviders(): string[] {
    return [...this.ports.keys()].sort();
  }

  covers(provider: string): boolean {
    return this.ports.has(provider);
  }

  async check(query: EntitlementQuery): Promise<EntitlementAnswer> {
    const port = this.ports.get(query.provider);
    if (port === undefined) return undefined;
    try {
      return await port.check(query);
    } catch {
      // A port that throws has not determined anything. Letting the exception escape would turn a
      // failed entitlement check into a dispatch fault the model may retry, which reads to the
      // caller as a flaky provider rather than as access it does not have.
      return undefined;
    }
  }
}
