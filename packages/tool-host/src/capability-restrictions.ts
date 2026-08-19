import type { AgentCapabilityRestrictions } from "@tulipfarm/schema";
import type { ToolDef } from "./types";

/**
 * Server-side evaluation of an Agent's authored capability restrictions.
 *
 * A restriction is data on the Agent, so it is decided here rather than by the model reading its
 * own system prompt. Two phases consult it:
 *
 * - **offer** (`agentCanBeOfferedTool`) trims the model-facing Tool set. Cosmetic and best-effort:
 *   a restriction whose verdict needs the call's arguments cannot be decided yet, so the Tool is
 *   still offered and dispatch answers for it.
 * - **dispatch** (`agentCapabilityDenial`) is the authorization boundary. It sees the arguments,
 *   fails closed on a call whose target it cannot read, and runs before authority, approval and
 *   `execute`, so a forbidden call never reaches a human as a choice or a Tool as work.
 */

type ToolShape = Pick<ToolDef, "name" | "mutating">;
type ToolRestriction = NonNullable<AgentCapabilityRestrictions["tools"]>;
type RecordRestriction = NonNullable<AgentCapabilityRestrictions["records"]>;
type ResourceTypeRestriction = NonNullable<AgentCapabilityRestrictions["resourceTypes"]>;

type Phase = "offer" | "dispatch";

/**
 * Flow-control Tools a blanket restriction must not reach.
 *
 * These carry no business effect — they end a State or a task, or draw and read the Surface — but
 * they are declared `mutating` because they write turn-scoped rows. Letting `allowMutating: false`
 * take them away would leave a read-only Agent unable to finish a Routine State or ask a
 * clarifying question, i.e. it would break the Turn rather than bound it. `tools.deny` still
 * names them: an explicit refusal is an author's decision, a blanket one is not.
 *
 * Parallel to `ALWAYS_EXPOSED_TOOL_NAMES` in `@tulipfarm/agent-runtime`'s Skill narrowing, which
 * this package must not import. That set is about visibility; this one is about authority, so it
 * deliberately omits `delegate_to_agent` — handing work to a laxer Agent is exactly the effect a
 * read-only Agent must not have (#461).
 */
const FLOW_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "complete_state",
  "complete_task",
  "present",
  "request_input",
  "update_presentation",
]);

const RECORD_TOOL_ACTIONS: Readonly<Record<string, string>> = {
  record_list: "list",
  record_search: "search",
  record_get: "read",
  record_create: "create",
  record_update: "update",
  record_delete: "delete",
};

const RESOURCE_TYPE_TOOL_ACTIONS: Readonly<Record<string, string>> = {
  list_resource_types: "list",
  resource_type_schema: "read",
  create_resource_type: "create",
  resource_type_update: "update",
};

function toolDenied(tool: ToolShape, restriction: ToolRestriction | undefined): string | undefined {
  if (restriction === undefined) return undefined;
  if (restriction.deny?.includes(tool.name)) {
    return `tool "${tool.name}" is denied by this Agent's capability restrictions`;
  }
  if (FLOW_CONTROL_TOOL_NAMES.has(tool.name)) return undefined;
  if (restriction.allow !== undefined && !restriction.allow.includes(tool.name)) {
    return `tool "${tool.name}" is outside this Agent's allowed Tools`;
  }
  if (restriction.allowMutating === false && tool.mutating) {
    return `mutating tool "${tool.name}" is denied by this Agent's capability restrictions`;
  }
  return undefined;
}

function stringArgument(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function actionDenied(
  toolName: string,
  action: string,
  allow: readonly string[] | undefined,
  deny: readonly string[] | undefined
): string | undefined {
  if (deny?.includes(action)) {
    return `tool "${toolName}" performs "${action}", which this Agent is denied`;
  }
  if (allow !== undefined && !allow.includes(action)) {
    return `tool "${toolName}" performs "${action}", which is outside this Agent's allowed actions`;
  }
  return undefined;
}

/**
 * Whether a restriction scoped to named types has nothing to say about this call.
 *
 * At dispatch a call whose type argument is missing or unreadable stays in scope, so a malformed
 * call cannot slip past the named-type test. At the offer boundary there are no arguments at all,
 * so a scoped restriction is undecidable and the Tool keeps its place in the catalog.
 */
function outOfScope(
  scope: readonly string[] | undefined,
  args: unknown,
  key: string,
  phase: Phase
): boolean {
  if (scope === undefined) return false;
  if (phase === "offer") return true;
  const target = stringArgument(args, key);
  return target !== undefined && !scope.includes(target);
}

function recordDenied(
  toolName: string,
  args: unknown,
  restriction: RecordRestriction | undefined,
  phase: Phase
): string | undefined {
  const action = RECORD_TOOL_ACTIONS[toolName];
  if (action === undefined || restriction === undefined) return undefined;
  if (outOfScope(restriction.resourceTypes, args, "type", phase)) return undefined;
  return actionDenied(toolName, action, restriction.actions?.allow, restriction.actions?.deny);
}

function resourceTypeDenied(
  toolName: string,
  args: unknown,
  restriction: ResourceTypeRestriction | undefined,
  phase: Phase
): string | undefined {
  const action = RESOURCE_TYPE_TOOL_ACTIONS[toolName];
  if (action === undefined || restriction === undefined) return undefined;
  if (outOfScope(restriction.names, args, "name", phase)) return undefined;
  return actionDenied(toolName, action, restriction.actions?.allow, restriction.actions?.deny);
}

/**
 * The reason this Agent may not make this call, or `undefined` when nothing forbids it.
 *
 * An Agent that authored no restrictions is unrestricted, so absence returns `undefined` and the
 * dispatch path behaves exactly as it did before restrictions existed.
 */
export function agentCapabilityDenial(
  restrictions: AgentCapabilityRestrictions | undefined,
  tool: ToolShape,
  args: unknown
): string | undefined {
  if (restrictions === undefined) return undefined;
  return (
    toolDenied(tool, restrictions.tools) ??
    recordDenied(tool.name, args, restrictions.records, "dispatch") ??
    resourceTypeDenied(tool.name, args, restrictions.resourceTypes, "dispatch")
  );
}

/** Whether the model should be shown this Tool at all. Never the authorization decision. */
export function agentCanBeOfferedTool(
  restrictions: AgentCapabilityRestrictions | undefined,
  tool: ToolShape
): boolean {
  if (restrictions === undefined) return true;
  return (
    toolDenied(tool, restrictions.tools) === undefined &&
    recordDenied(tool.name, undefined, restrictions.records, "offer") === undefined &&
    resourceTypeDenied(tool.name, undefined, restrictions.resourceTypes, "offer") === undefined
  );
}
