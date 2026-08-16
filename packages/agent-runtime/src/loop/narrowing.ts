import type { ExposedTool } from "./contract";

/** Skill narrowing: which exposed Tools the model is shown. Never an authorization decision. */

/** Structural Tools cannot be hidden by Skill narrowing. */
const ALWAYS_EXPOSED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "load_skill",
  "complete_task",
  "transfer_to_agent",
  "delegate_to_agent",
  "present",
  "request_input",
  "update_presentation",
]);

/**
 * The Tools an iteration shows the model. `tools` stays the authorization boundary — narrowing
 * only shrinks the catalog the model sees, so an unnarrowed name is still refused at dispatch.
 */
export function narrowToolsToSkill(
  tools: readonly ExposedTool[],
  activeSkillName: string | undefined,
  skillToolScopes: ReadonlyMap<string, readonly string[]> | undefined
): readonly ExposedTool[] {
  const scope = activeSkillName === undefined ? undefined : skillToolScopes?.get(activeSkillName);
  if (scope === undefined) return tools;
  return tools.filter((t) => ALWAYS_EXPOSED_TOOL_NAMES.has(t.name) || scope.includes(t.name));
}

/** `load_skill`'s only argument is `{ name: string }` — the Skill this call switched into. */
export function extractSkillName(callArguments: unknown): string | undefined {
  if (typeof callArguments !== "object" || callArguments === null) return undefined;
  const name = (callArguments as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}
