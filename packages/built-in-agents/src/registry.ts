import type { BuiltInAgentSpec } from "./agent";
import { CHAT_TITLE } from "./agents/chat-title";
import { EFFORT_CLASSIFIER } from "./agents/effort-classifier";
import { ONBOARDING_PERSONALIZER } from "./agents/onboarding-personalizer";
import { SKILL_AUDIT } from "./agents/skill-audit";
import { TOOL_RESULT_DISTILLER } from "./agents/tool-result-distiller";

/**
 * Every BuiltInAgent the product ships.
 *
 * The list is what makes this a package rather than a folder. It is the thing the fitness test
 * iterates, so "does every single-shot model call the runtime makes for itself declare a rung, an
 * output ceiling and a deadline?" has a mechanical answer instead of a reviewer's memory.
 *
 * Adding a BuiltInAgent means adding a directory under `agents/` and a line here. One that is not
 * in this list is not governed by anything, which is the state all five of these were in before
 * the package existed.
 *
 * Each agent declares its own spec beside its prompt; this file only collects them, so the numbers
 * stay next to the code they bound.
 */
export const BUILT_IN_AGENTS: readonly BuiltInAgentSpec[] = [
  TOOL_RESULT_DISTILLER,
  EFFORT_CLASSIFIER,
  CHAT_TITLE,
  SKILL_AUDIT,
  ONBOARDING_PERSONALIZER,
];
