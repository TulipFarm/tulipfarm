import type { PresentationContext } from "@tulipfarm/surface";
import type { ToolAvailability } from "@tulipfarm/tool-broker";
import type { ToolDef } from "./types";

/**
 * The read surface the Tool host needs from a registry. Deliberately narrower than any concrete
 * registry: a process that only executes Tools has no business building a model-facing tool set,
 * and keeping that out of the contract is what lets the durable runtime host Tools without the
 * model SDK the control plane's streaming path uses.
 */
export interface ToolCatalog {
  getAll(): ToolDef[];
}

/** A catalog assembled at composition time. Registering a duplicate name is a wiring bug. */
export class InMemoryToolCatalog implements ToolCatalog {
  private readonly tools = new Map<string, ToolDef>();

  register(tool: ToolDef): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
    this.tools.set(tool.name, tool);
  }

  getAll(): ToolDef[] {
    return [...this.tools.values()];
  }
}

/** Visibility only: offered Tools still require authorization. */
function offerable(
  availability: ToolAvailability | undefined,
  presentationContext?: PresentationContext
): boolean {
  if (availability === undefined) return true;
  if (availability.requiresPresentation === true && !presentationContext) return false;
  if (
    availability.requiresWebChat === true &&
    (presentationContext?.target.channel !== "web" || presentationContext.target.surface !== "chat")
  ) {
    return false;
  }
  return true;
}

/** Per-agent tool scoping: an agent without an allowlist gets an explicit registry snapshot. */
export function allowedToolNamesFor(
  catalog: ToolCatalog | undefined,
  agent: { readonly toolAllowlist?: readonly string[] } | undefined,
  presentationContext?: PresentationContext,
  excluded?: ReadonlySet<string>
): ReadonlySet<string> | undefined {
  if (!(catalog && catalog.getAll().length > 0)) return undefined;
  const agentAllowed = agent?.toolAllowlist
    ? new Set(agent.toolAllowlist)
    : new Set(catalog.getAll().map((toolDefinition) => toolDefinition.name));
  const availability = new Map(
    catalog.getAll().map((tool) => [tool.name, tool.definition?.availableTo])
  );
  return new Set(
    [...agentAllowed].filter((name) => {
      if (excluded?.has(name)) return false;
      return offerable(availability.get(name), presentationContext);
    })
  );
}

/** Name/description pairs for the prompt, sorted for a byte-stable prefix. */
export function availableToolsFor(
  catalog: ToolCatalog | undefined,
  agent: { readonly toolAllowlist?: readonly string[] } | undefined,
  presentationContext?: PresentationContext,
  excluded?: ReadonlySet<string>
): { name: string; description: string }[] {
  if (!catalog) return [];
  const allowed = allowedToolNamesFor(catalog, agent, presentationContext, excluded);
  return catalog
    .getAll()
    .filter((t) => !allowed || allowed.has(t.name))
    .map((t) => ({ name: t.name, description: t.description }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
