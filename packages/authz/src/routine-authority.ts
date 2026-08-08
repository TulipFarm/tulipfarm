import type { ToolContractDefinition } from "@tulipfarm/schema";
import type { AccessGrant } from "./grants";

/**
 * Compiles a Routine's own pinned ToolContract definitions into the one `AuthorityLayer` its Runs
 * dispatch under (SPEC §12). A contract that declares `requiredActions`/`requiredResources` grants
 * exactly those; one that declares neither is scoped to itself alone, via the same `{ type: "Tool",
 * id: toolId }` fallback target `protectedRequests` (tool-broker) resolves to when a contract and
 * its intent both omit a resource. Nothing here can grant a Tool the bundle never published — a
 * Routine's authority can only ever be as wide as what it declares wanting to call.
 */
export function compileRoutineAuthority(
  contracts: readonly ToolContractDefinition[]
): AccessGrant[] {
  const grants: AccessGrant[] = [];
  for (const contract of contracts) {
    const actions =
      contract.spec.requiredActions && contract.spec.requiredActions.length > 0
        ? contract.spec.requiredActions
        : ["*"];
    const resources = contract.spec.requiredResources ?? [];
    for (const action of actions) {
      if (resources.length === 0) {
        grants.push({
          action,
          resourceType: "Tool",
          recordSelector: contract.spec.toolId,
          effect: "allow",
        });
        continue;
      }
      for (const resourceType of resources) {
        grants.push({ action, resourceType, effect: "allow" });
      }
    }
  }
  return grants;
}
