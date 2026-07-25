import type { PublishedToolContract } from "./contract";

export type ToolRiskLevel = "low" | "medium" | "high";

export interface ToolRiskContext {
  readonly taint?: "trusted" | "untrusted";
  readonly recordCount?: number;
  readonly unusualCost?: boolean;
  readonly irreversible?: boolean;
}

export interface ToolRiskAssessment {
  readonly level: ToolRiskLevel;
  readonly reasons: readonly string[];
}

const RANK: Readonly<Record<ToolRiskLevel, number>> = { low: 0, medium: 1, high: 2 };

export function assessToolRisk(
  contract: PublishedToolContract,
  context: ToolRiskContext
): ToolRiskAssessment {
  let rank = RANK[contract.riskClass];
  const reasons = new Set<string>([`contract_${contract.riskClass}`]);
  if (contract.mutating && context.taint === "untrusted") {
    rank = Math.max(rank, RANK.high);
    reasons.add("untrusted_mutation");
  }
  if (context.irreversible) {
    rank = Math.max(rank, RANK.high);
    reasons.add("irreversible");
  }
  if (context.unusualCost || (context.recordCount !== undefined && context.recordCount > 100)) {
    rank = Math.max(rank, RANK.high);
    reasons.add("unusual_scope");
  }
  const level = (Object.entries(RANK).find(([, value]) => value === rank)?.[0] ??
    "high") as ToolRiskLevel;
  return Object.freeze({ level, reasons: Object.freeze([...reasons].sort()) });
}
