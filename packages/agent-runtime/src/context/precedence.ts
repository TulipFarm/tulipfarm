/** Fixed instruction precedence; lower levels cannot override higher levels. */
export const INSTRUCTION_PRECEDENCE = [
  "platform_safety",
  "business_guardrail",
  "routine_instructions",
  "agent_instructions",
  "skill_instructions",
  "user_request",
  "untrusted_source",
] as const;

export type InstructionPrecedence = (typeof INSTRUCTION_PRECEDENCE)[number];

/** Levels that carry the platform's own invariants and are never compacted away. */
export const NON_COMPACTABLE_PRECEDENCE: readonly InstructionPrecedence[] = [
  "platform_safety",
  "business_guardrail",
];

const RANK: Readonly<Record<string, number>> = Object.fromEntries(
  INSTRUCTION_PRECEDENCE.map((level, index) => [level, index])
);

export function precedenceRank(level: string): number | undefined {
  return RANK[level];
}

/** True when `candidate` sits at or below `ceiling` and therefore cannot override it. */
export function precedenceWithin(
  candidate: InstructionPrecedence,
  ceiling: InstructionPrecedence
): boolean {
  return RANK[candidate] >= RANK[ceiling];
}
