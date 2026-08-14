import type { ToolContractDefinition } from "@tulipfarm/schema";
import type { AccessGrant } from "./grants";

/**
 * Routine authority is limited to pinned ToolContracts; contracts without required targets scope
 * only to their own Tool id.
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
