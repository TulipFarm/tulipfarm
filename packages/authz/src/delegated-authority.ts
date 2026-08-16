/** A delegation grant is an authority layer like any other, so the child's bound is one
 * intersection decided by `decideEffectivePermission` rather than a second, drifting rule. */

import type { AuthorityLayer } from "./effective";
import type { AccessGrant, AccessRequest } from "./grants";

/** Invoking a Tool. Mirrors `compileRoutineAuthority`: the Tool id is the record selector. */
export const DELEGATED_TOOL_ACTION = "tool.invoke";
export const DELEGATED_TOOL_RESOURCE = "Tool";

/**
 * Handling data of one class. Kept a separate action from Tool invocation because a grant scoped
 * by `dataClass` cannot also cover a request that declares none, and a Tool that touches no
 * classified data must not need a data grant to run.
 */
export const DELEGATED_DATA_ACTION = "data.handle";
export const DELEGATED_DATA_RESOURCE = "DataClass";

/** The Tool and classification halves of a delegation grant. Structural: `ChildAuthority` fits. */
export interface DelegatedAuthority {
  readonly tools: readonly string[];
  readonly classifications: readonly string[];
}

/** Compiles one granted authority into a named layer for the intersection. */
export function delegatedAuthorityLayer(
  name: string,
  authority: DelegatedAuthority
): AuthorityLayer {
  const grants: AccessGrant[] = [];
  for (const tool of authority.tools) {
    grants.push({
      action: DELEGATED_TOOL_ACTION,
      resourceType: DELEGATED_TOOL_RESOURCE,
      recordSelector: tool,
      effect: "allow",
    });
  }
  for (const classification of authority.classifications) {
    grants.push({
      action: DELEGATED_DATA_ACTION,
      resourceType: DELEGATED_DATA_RESOURCE,
      recordSelector: classification,
      effect: "allow",
    });
  }
  return { name, grants };
}

export function delegatedToolRequest(toolName: string): AccessRequest {
  return {
    action: DELEGATED_TOOL_ACTION,
    resourceType: DELEGATED_TOOL_RESOURCE,
    recordId: toolName,
  };
}

export function delegatedDataClassRequest(dataClass: string): AccessRequest {
  return {
    action: DELEGATED_DATA_ACTION,
    resourceType: DELEGATED_DATA_RESOURCE,
    recordId: dataClass,
  };
}
