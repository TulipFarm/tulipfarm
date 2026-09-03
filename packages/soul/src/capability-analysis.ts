import { isRecord } from "@tulipfarm/schema";
import type { AuthoredDefinition, DefinitionIndex, SoulSemanticIssue } from "./refs";

/** Reject static authority widening through Agent ceilings or Routine Tool destinations. */

const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Resolve a plain (slug or id) reference to its definition, if present in the tree. */
function lookup(index: DefinitionIndex, ref: string, kind: string): AuthoredDefinition | undefined {
  const byId = index.get(ref);
  if (byId?.kind === kind) return byId;
  return index.candidates(ref, kind)[0];
}

function analyzeAgentRiskCeilings(index: DefinitionIndex): SoulSemanticIssue[] {
  const issues: SoulSemanticIssue[] = [];
  for (const agent of index.ofKind("Agent")) {
    const ceiling = agent.spec.permissionCeiling;
    if (!isRecord(ceiling) || typeof ceiling.maxRiskClass !== "string") continue;
    const ceilingRank = RISK_RANK[ceiling.maxRiskClass];
    if (ceilingRank === undefined) continue;
    stringList(agent.spec.allowedTools).forEach((toolRef, i) => {
      const tool = lookup(index, toolRef, "ToolContract");
      const riskClass = tool?.spec.riskClass;
      if (typeof riskClass !== "string") return;
      const toolRank = RISK_RANK[riskClass];
      if (toolRank !== undefined && toolRank > ceilingRank) {
        issues.push({
          code: "RISK_EXCEEDS_CEILING",
          subject: agent.subject,
          ref: toolRef,
          field: `/spec/allowedTools/${i}`,
        });
      }
    });
  }
  return issues;
}

function analyzeRoutineDestinations(index: DefinitionIndex): SoulSemanticIssue[] {
  const issues: SoulSemanticIssue[] = [];
  for (const routine of index.ofKind("Routine")) {
    const states = Array.isArray(routine.spec.states) ? routine.spec.states : [];
    states.forEach((state, i) => {
      if (!isRecord(state) || state.type !== "tool") return;
      const destination = state.destination;
      const ref = isRecord(state.toolRef) ? state.toolRef : undefined;
      const toolKey = ref && (typeof ref.id === "string" ? ref.id : (ref.name as string));
      if (typeof destination !== "string" || typeof toolKey !== "string") return;
      const tool = lookup(index, toolKey, "ToolContract");
      if (!tool) return;
      const allowed = stringList(tool.spec.allowedDestinations);
      if (allowed.length > 0 && !allowed.includes(destination)) {
        issues.push({
          code: "DESTINATION_NOT_GRANTED",
          subject: routine.subject,
          ref: destination,
          field: `/spec/states/${i}/destination`,
        });
      }
    });
  }
  return issues;
}

export function analyzeCapabilities(index: DefinitionIndex): SoulSemanticIssue[] {
  return [...analyzeAgentRiskCeilings(index), ...analyzeRoutineDestinations(index)];
}
