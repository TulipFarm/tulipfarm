import type { ExposedTool } from "./contract";

/** Skill narrowing: which exposed Tools the model is shown. Never an authorization decision. */

/**
 * The Tool that loads a Skill, and so the one whose call switches which Skill is active.
 *
 * Declared here rather than imported from `@tulipfarm/soul`, which this package may not depend on;
 * `apps/api/src/tools/contract-coverage.test.ts` pins the two spellings together.
 */
export const SKILL_TOOL = "skill";

/**
 * Structural Tools cannot be hidden by Skill narrowing.
 *
 * Every name here is a way a Turn *ends* — it answers, asks, or hands the work on. `delegate_to_agent`
 * belongs for that reason; `transfer_to_agent` was listed beside it and no host has ever registered
 * it, so the set advertised an exit that could not be taken (#419). A name is admitted here only
 * once some host offers it.
 */
const ALWAYS_EXPOSED_TOOL_NAMES: ReadonlySet<string> = new Set([
  SKILL_TOOL,
  "complete_task",
  "delegate_to_agent",
  "present",
  "request_input",
  "update_presentation",
]);

/**
 * The Tools an iteration shows the model. `tools` stays the authorization boundary — narrowing
 * only shrinks the catalog the model sees, so an unnarrowed name is still refused at dispatch.
 *
 * A scope may hide a read; it may never hide a write. Hiding a read costs the model an
 * alternative it can work without — it still holds the Skill's own reads, and can answer or say
 * it cannot. Hiding a *write* takes away the only way the Turn can do the thing it was asked to
 * do, and does it silently: the Tool is absent rather than refused, the system prompt assembled
 * before the `skill` load still lists it, and no result comes back for the model to reason about.
 * The only completion left is text, which is how a Turn that filed nothing ends by claiming it
 * did (#419). `mutating === true` and not `!== false` on purpose: dispatch treats an undeclared
 * Tool as a write because that fails safe, whereas narrowing is a visibility choice, so it acts
 * only on a Tool that declares itself.
 */
export function narrowToolsToSkill(
  tools: readonly ExposedTool[],
  activeSkillName: string | undefined,
  skillToolScopes: ReadonlyMap<string, readonly string[]> | undefined
): readonly ExposedTool[] {
  const scope = activeSkillName === undefined ? undefined : skillToolScopes?.get(activeSkillName);
  if (scope === undefined) return tools;
  return tools.filter(
    (t) => t.mutating === true || ALWAYS_EXPOSED_TOOL_NAMES.has(t.name) || scope.includes(t.name)
  );
}

/**
 * `skill`'s Skill-identifying argument is `name`, in both its adopting modes: `{ name }` loads the
 * Skill, `{ name, file }` reads one of the files that Skill advertised. A reference read therefore
 * switches to the Skill it names, which is the same Skill the model is working in.
 *
 * `{ mode: "inspect" }` names a Skill without adopting it, so it must not switch. Inspecting is
 * how an authoring or auditing Turn reads a Skill it is editing or judging — often one whose
 * contents it does not trust. Switching there would do two harmful things at once: re-narrow the
 * offer to the inspected Skill's scope, taking away the authoring Turn's own reads mid-flow, and
 * tag every later dispatch as acting under a Skill the Turn was only looking at.
 */
export function extractSkillName(callArguments: unknown): string | undefined {
  if (typeof callArguments !== "object" || callArguments === null) return undefined;
  const { name, mode } = callArguments as { name?: unknown; mode?: unknown };
  if (mode === "inspect") return undefined;
  return typeof name === "string" ? name : undefined;
}
