import type { ToolTargetRef } from "./intent";

/**
 * Authority layer L5 — what the *provider* would let this person do (D7).
 *
 * Layers L1–L4 all describe authority this platform granted. None of them can know that a
 * particular engineer was never added to a particular repository, or that a document was shared
 * with one team and not another. That knowledge lives in the provider, and we neither replicate it
 * nor keep it fresh.
 *
 * When a call spends the caller's own credential the provider applies that knowledge itself and
 * this layer is unnecessary. It exists for the other case: a call that spends the deployment's
 * shared credential still reaches the provider *as the bot*, so the bot's access — usually far
 * wider than any individual's — becomes the effective access unless something checks the human
 * first. This is that check, and it is the only thing standing between "HR cannot see the
 * engineering repo" as a policy and as a fact.
 *
 * There are three answers, and conflating any two of them is how this layer breaks:
 *
 * - a **verdict** (`allowed` true or false) — the provider was asked and answered;
 * - **`undefined`** — *could not determine*. A provider that is unreachable, a response we cannot
 *   parse, an unmapped identity. The caller must deny: a layer that answered "yes" in this state
 *   would be at its most permissive exactly when it is least informed;
 * - **`not_applicable`** — there is no provider-side question to ask. Not a determination that
 *   failed, and not permission: it means L5 contributes nothing here and layers L1–L4 are the whole
 *   answer. Returning `undefined` for these instead would deny every call this layer was never
 *   meant to decide, and returning `{allowed:true}` would state an entitlement nobody verified.
 *
 * The third answer is load-bearing. Its cases are structural — a subject that is not a person has
 * no provider identity to check, and a target that names something other than a resource the
 * provider can report access on (an account under which a repository does not yet exist) offers
 * nothing to ask about. Without it, correctness at this layer would require every Tool of a covered
 * provider to name a checkable resource, which is not a property any Tool author can guarantee.
 */

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

/**
 * L5 has no question to ask about this call. Distinct from `{allowed:true}`, which asserts a
 * provider-side entitlement that was actually confirmed, and from `undefined`, which is a
 * determination that failed and must deny.
 */
export const NOT_APPLICABLE = "not_applicable" as const;
export type EntitlementNotApplicable = typeof NOT_APPLICABLE;

export type EntitlementAnswer = EntitlementVerdict | EntitlementNotApplicable | undefined;

export interface ToolEntitlementPort {
  /** The integration slug this port speaks for. One port answers for exactly one provider. */
  readonly provider: string;
  check(query: EntitlementQuery): Promise<EntitlementAnswer>;
}

/**
 * Routes a query to the port owning its provider.
 *
 * A provider with no port returns `undefined` from `check` *and* `false` from `covers`, and callers
 * must distinguish the two: an uncovered provider has no per-principal entitlement model wired yet,
 * which is a known gap rather than a determination that failed. Denying every uncovered provider
 * would make writing a port a precondition for shipping any provider Tool at all — a rule that
 * would be suspended the first time it bit, and a rule that gets suspended is worse than one that
 * is stated honestly. `covers` exists so the gap can be listed rather than discovered.
 */
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
