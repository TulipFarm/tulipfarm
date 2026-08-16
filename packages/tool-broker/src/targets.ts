import type { PublishedToolContract } from "./contract";
import { safeToolTargetRef, ToolDefinitionError } from "./define";
import type { ToolTargetRef } from "./intent";

/**
 * Contract-declared target derivation: turns one call's arguments into the concrete objects the
 * call will touch, so authorization can be scoped to those objects instead of to the whole Tool.
 *
 * A code-defined Tool carries `authorization.targets`, a function. A Tool reached through a pinned
 * Soul bundle carries only documents, so the derivation has to be data on the ToolContract itself —
 * that is `spec.targets`. Both end at the same `ToolTargetRef` shape and the same grant grammar.
 *
 * Every failure here is a refusal. Returning `[]` on an unresolved template would hand the gate a
 * Tool-granular decision that looks identical to a contract which legitimately declares no target,
 * which is exactly the conflation this exists to prevent.
 */

export type ToolTargetDerivationErrorCode =
  /** A template placeholder named an argument the call did not supply as a non-empty scalar. */
  | "target_unresolved"
  /** The derived ref breaks the grant grammar (reserved id, malformed type or domain). */
  | "target_invalid"
  /** A declared target type is absent from `requiredResources`, so no grant floor covers it. */
  | "target_type_undeclared"
  /** A declared resource has no target, so deriving would stop that resource being checked. */
  | "target_drops_resource";

export class ToolTargetDerivationError extends Error {
  readonly name = "ToolTargetDerivationError";

  constructor(
    readonly code: ToolTargetDerivationErrorCode,
    readonly detail: string
  ) {
    super(`${code}:${detail}`);
  }
}

/** `{dotted.path}`; braces cannot nest, so a malformed template resolves nothing and refuses. */
const PLACEHOLDER = /\{([^{}]*)\}/g;

/** Only non-empty scalars identify an object; an object or array argument is not an id. */
function scalarAt(args: unknown, path: string): string | undefined {
  let cursor: unknown = args;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (typeof cursor === "string") return cursor.length > 0 ? cursor : undefined;
  if (typeof cursor === "number" && Number.isFinite(cursor)) return String(cursor);
  return undefined;
}

function interpolate(contract: PublishedToolContract, template: string, args: unknown): string {
  let unresolved: string | undefined;
  const id = template.replace(PLACEHOLDER, (_match, path: string) => {
    const value = scalarAt(args, path.trim());
    if (value === undefined) {
      unresolved ??= path.trim();
      return "";
    }
    return value;
  });
  if (unresolved !== undefined) {
    throw new ToolTargetDerivationError("target_unresolved", `${contract.toolId}:{${unresolved}}`);
  }
  return id;
}

/**
 * Derives the targets a contract declares for this call.
 *
 * A contract with no `spec.targets` derives nothing and keeps the coarser static-resource check —
 * that is the one legitimate empty result. Anything a contract does declare must resolve, or the
 * call is refused rather than authorized against a broader scope than it asked for.
 *
 * @throws {ToolTargetDerivationError} when a declared target cannot be derived, or when the
 * declaration and `requiredResources` disagree about what is being checked.
 */
export function deriveContractTargets(
  contract: PublishedToolContract,
  args: unknown
): readonly ToolTargetRef[] {
  const declared = contract.targets;
  if (declared === undefined || declared.length === 0) return [];

  const refs: ToolTargetRef[] = [];
  for (const binding of declared) {
    const id = interpolate(contract, binding.id, args);
    let safe: ToolTargetRef | undefined;
    try {
      safe = safeToolTargetRef(contract.toolId, {
        type: binding.type,
        id,
        ...(binding.domain === undefined ? {} : { domain: binding.domain }),
      });
    } catch (cause) {
      // A grant-grammar violation is a contract defect, not a provider fault; refuse it by name.
      throw new ToolTargetDerivationError(
        "target_invalid",
        cause instanceof ToolDefinitionError ? cause.message : String(cause)
      );
    }
    if (safe === undefined) {
      throw new ToolTargetDerivationError(
        "target_unresolved",
        `${contract.toolId}:${binding.type}`
      );
    }
    // Checked against the normalized type, which is what the gate will match a grant on.
    if (!contract.requiredResources.includes(safe.type)) {
      throw new ToolTargetDerivationError(
        "target_type_undeclared",
        `${contract.toolId}:${safe.type}`
      );
    }
    refs.push(safe);
  }

  // Derived targets replace the static resource list at the gate, so a resource with no target
  // would silently stop being checked.
  const derivedTypes = new Set(refs.map((ref) => ref.type));
  const dropped = contract.requiredResources.filter((resource) => !derivedTypes.has(resource));
  if (dropped.length > 0) {
    throw new ToolTargetDerivationError(
      "target_drops_resource",
      `${contract.toolId}:${dropped.join(",")}`
    );
  }

  return Object.freeze(refs);
}
