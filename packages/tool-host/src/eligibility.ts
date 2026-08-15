import type { ToolDefinition } from "@tulipfarm/tool-broker";

/**
 * Which Tools a process may execute in-process without the control plane's ambient capabilities.
 *
 * The durable runtime deliberately holds no live Soul (only signed bundle reads), no renderer
 * registry, and no provider credential leases. A Tool that needs any of those would be authorized
 * against strictly less evidence there than in the control plane, and a weaker check that still
 * returns "authorized" is worse than no check at all. So this predicate is the co-location
 * admission rule, and it fails closed: anything it cannot positively clear stays on the control
 * plane's dispatch path.
 *
 * The refusals are not a backlog. Each names a capability that is deliberately *not* replicated,
 * so the Tools they refuse are remote by design and stay that way:
 *
 * - `non_platform_tier` — system-tier Tools write the Soul. The write gateway is single-homed on
 *   purpose: it serializes commits and owns the git history that is the audit trail. A second
 *   writer would need distributed locking to buy a saved network hop.
 * - `requires_presentation` — the Tool renders into a client that is looking at it, so the hop it
 *   would save is the one that reaches the client.
 * - `provider_credential` / `non_service_credential` — leasing a third-party credential into the
 *   runtime widens the blast radius of a compromised Run past what the hop costs.
 * - `requires_ambient_capability` — declared by Tools whose *handlers* read ambient state the
 *   authorization surface does not mention. Without the declaration these clear every other check
 *   and then answer from nothing.
 */

/** Resource domains that are pure platform state, needing no Soul lookup to derive targets. */
const PLATFORM_RESOURCE_PREFIX = "platform.";

export type LocalDispatchRefusal =
  | "provider_credential"
  | "non_service_credential"
  | "requires_presentation"
  | "non_platform_tier"
  | "soul_scoped_resource"
  | "requires_ambient_capability";

/** Ambient context the durable runtime cannot supply, so no Tool needing it may run there. */
const UNAVAILABLE_AMBIENT = new Set(["soul", "renderer", "provider-credentials"]);

/**
 * Why a Tool may not be co-located, or `undefined` when it may. Returning the reason rather than a
 * boolean keeps the composition-time error and the dispatch-time denial saying the same thing.
 */
export function localDispatchRefusal(
  definition: ToolDefinition<unknown, unknown> | undefined
): LocalDispatchRefusal | undefined {
  // No declaration is no evidence; the gate would have nothing to authorize against.
  if (definition === undefined) return "soul_scoped_resource";
  // A provider means an entitlement check and a credential the durable runtime cannot lease.
  if (definition.provider !== undefined) return "provider_credential";
  if (definition.credentialMode !== "service") return "non_service_credential";
  // A handler that reads ambient state this process cannot supply would not fail — it would run
  // against nothing and return a confidently wrong answer, which no gate can catch.
  if (definition.requiresAmbient?.some((capability) => UNAVAILABLE_AMBIENT.has(capability))) {
    return "requires_ambient_capability";
  }
  if (
    definition.availableTo?.requiresPresentation === true ||
    definition.availableTo?.requiresWebChat === true
  ) {
    return "requires_presentation";
  }
  // System-tier Tools reach the Soul and its write gateway; platform-tier Tools do not.
  if (definition.tier !== "platform") return "non_platform_tier";
  const resources = definition.authorization.resources ?? [];
  if (!resources.every((resource) => resource.startsWith(PLATFORM_RESOURCE_PREFIX))) {
    // A Soul-scoped Resource domain needs a live `SoulLoader` to derive its targets, and without
    // one `targetsFor` would silently yield a narrower target set than the gate expects.
    return "soul_scoped_resource";
  }
  return undefined;
}
