import type { ToolContractDefinition } from "@tulipfarm/schema";

export type GovernedImportErrorCode =
  | "destination_required"
  | "discovery_invalid"
  | "explicit_selection_required"
  | "operation_not_found"
  | "tool_not_found";

export class GovernedImportError extends Error {
  readonly name = "GovernedImportError";

  constructor(readonly code: GovernedImportErrorCode) {
    super(`governed_import:${code}`);
  }
}

/**
 * Input to the Soul proposal boundary. The composing application serializes these definitions
 * through the one changeset gateway; this package receives no writer, registry, or activation API.
 */
export interface GovernedToolContractProposal {
  readonly id: string;
  readonly businessId: string;
  readonly principalId: string;
  readonly expectedBaseCommit: string;
  readonly source: "discovery" | "import";
  readonly discoveryDigest: string;
  readonly activation: "proposal_only";
  readonly requiresApproval: true;
  readonly definitions: readonly ToolContractDefinition[];
}

export interface GovernedToolContractProposalPort {
  propose(input: GovernedToolContractProposal): Promise<{ readonly proposalId: string }>;
}

export interface GovernedImportResult {
  readonly proposalId: string;
  readonly discoveryDigest: string;
  readonly proposedTools: readonly string[];
}

export interface GovernedImportRequestBase {
  readonly changesetId: string;
  readonly businessId: string;
  readonly principalId: string;
  readonly expectedBaseCommit: string;
  readonly allowedDestinations: readonly string[];
}

export function requireExplicitSelection(selection: readonly string[]): void {
  if (selection.length === 0 || new Set(selection).size !== selection.length) {
    throw new GovernedImportError("explicit_selection_required");
  }
}

export function requireDestinations(destinations: readonly string[]): void {
  if (destinations.length === 0 || new Set(destinations).size !== destinations.length) {
    throw new GovernedImportError("destination_required");
  }
}

export function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}
