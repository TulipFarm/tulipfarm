import type { PublishedToolContract } from "./contract";

export interface ToolCatalogEntry {
  readonly toolId: string;
  readonly toolVersion: string;
  readonly action: string;
  readonly riskClass: PublishedToolContract["riskClass"];
  readonly mutating: boolean;
  readonly requiredActions: readonly string[];
  readonly requiredResources: readonly string[];
  readonly dataClasses: readonly string[];
  readonly allowedDestinations: readonly string[];
}

function entry(contract: PublishedToolContract): ToolCatalogEntry {
  return Object.freeze({
    toolId: contract.toolId,
    toolVersion: contract.toolVersion,
    action: contract.action,
    riskClass: contract.riskClass,
    mutating: contract.mutating,
    requiredActions: contract.requiredActions,
    requiredResources: contract.requiredResources,
    dataClasses: contract.dataClasses,
    allowedDestinations: contract.allowedDestinations,
  });
}

function searchableText(contract: PublishedToolContract): string {
  return [
    contract.toolId,
    contract.action,
    ...contract.requiredActions,
    ...contract.requiredResources,
    ...contract.dataClasses,
    ...contract.allowedDestinations,
  ]
    .join(" ")
    .toLocaleLowerCase();
}

export function searchToolContracts(
  authorizedContracts: readonly PublishedToolContract[],
  query: string
): ToolCatalogEntry[] {
  const terms = query
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return [];

  return authorizedContracts
    .filter((contract) => {
      const text = searchableText(contract);
      return terms.every((term) => text.includes(term));
    })
    .sort((left, right) => {
      const byId = left.toolId.localeCompare(right.toolId);
      return byId === 0 ? left.toolVersion.localeCompare(right.toolVersion) : byId;
    })
    .map(entry);
}
