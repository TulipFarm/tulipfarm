import type { ToolContractDefinition } from "@tulipfarm/schema";
import {
  type PublishedToolContract,
  publishToolContract,
  type ToolContractRef,
  toolContractRef,
} from "./contract";
import { searchToolContracts, type ToolCatalogEntry } from "./search";

export type ToolCatalogErrorCode = "contract_not_published" | "duplicate_contract";

export class ToolCatalogError extends Error {
  constructor(
    readonly code: ToolCatalogErrorCode,
    readonly contractRef: ToolContractRef
  ) {
    super(`${code}:${contractRef}`);
    this.name = "ToolCatalogError";
  }
}

export class ToolCatalog {
  private constructor(
    private readonly contracts: ReadonlyMap<ToolContractRef, PublishedToolContract>
  ) {}

  static load(definitions: readonly ToolContractDefinition[]): ToolCatalog {
    const contracts = new Map<ToolContractRef, PublishedToolContract>();
    for (const definition of definitions) {
      const ref = toolContractRef(definition.spec.toolId, definition.spec.toolVersion);
      if (contracts.has(ref)) throw new ToolCatalogError("duplicate_contract", ref);
      try {
        contracts.set(ref, publishToolContract(definition));
      } catch {
        throw new ToolCatalogError("contract_not_published", ref);
      }
    }
    return new ToolCatalog(contracts);
  }

  get(toolId: string, toolVersion: string): PublishedToolContract | undefined {
    return this.contracts.get(toolContractRef(toolId, toolVersion));
  }

  authorized(allowlist?: ReadonlySet<string>): PublishedToolContract[] {
    if (allowlist === undefined || allowlist.size === 0) return [];
    return [...this.contracts]
      .filter(([ref]) => allowlist.has(ref))
      .map(([, contract]) => contract);
  }

  search(query: string, allowlist?: ReadonlySet<string>): ToolCatalogEntry[] {
    return searchToolContracts(this.authorized(allowlist), query);
  }
}
