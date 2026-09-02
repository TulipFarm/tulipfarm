import { describe, expect, it } from "vitest";
import { buildSoulCatalogue } from "./catalogue";
import type { RegistryEntry } from "./integrations/registry";
import type { SoulLoader } from "./published-loader";
import type { SoulAgent, SoulIntegration, SoulResource, SoulRoutine, SoulSkill } from "./types";

const registryEntry = (
  name: string,
  availability: RegistryEntry["availability"],
  description?: string
): RegistryEntry => ({ name, availability, description });

const skill = (name: string, frontmatter: Record<string, unknown> = {}): SoulSkill => ({
  name,
  frontmatter,
  body: "",
});
const agent = (name: string, description?: string): SoulAgent => ({
  name,
  frontmatter: description ? { description } : {},
  body: "",
});
const resource = (name: string, schema: Record<string, unknown>): SoulResource => ({
  name,
  schema,
  hasHooks: false,
  hooksEnabled: true,
});
const routine = (name: string, config: Record<string, unknown>): SoulRoutine => ({
  name,
  config,
  hasHooks: false,
});
const integration = (slug: string, description?: string): SoulIntegration => ({
  slug,
  sourceIntegration: slug,
  manifest: {
    name: slug,
    description,
    egress: { type: "mcp", entry: { transport: "stdio", command: "echo" } },
  },
});

function fakeLoader(
  over: {
    agents?: SoulAgent[];
    skills?: SoulSkill[];
    resources?: SoulResource[];
    routines?: SoulRoutine[];
    integrations?: SoulIntegration[];
  } = {}
): SoulLoader {
  const toMap = <T extends { name: string }>(xs: T[] = []): Map<string, T> =>
    new Map(xs.map((x) => [x.name, x]));
  const toSlugMap = (xs: SoulIntegration[] = []): Map<string, SoulIntegration> =>
    new Map(xs.map((x) => [x.slug, x]));
  return {
    agents: toMap(over.agents),
    skills: toMap(over.skills),
    resources: toMap(over.resources),
    routines: toMap(over.routines),
    integrations: toSlugMap(over.integrations),
  } as unknown as SoulLoader;
}

describe("buildSoulCatalogue", () => {
  it("projects every section sorted by name, with the platform agents first-class", () => {
    const cat = buildSoulCatalogue(
      fakeLoader({
        agents: [agent("zeta", "Last agent"), agent("alpha", "First agent")],
        skills: [
          skill("review", { description: "Review" }),
          skill("export", { description: "CSV" }),
        ],
        resources: [resource("ticket", {}), resource("invoice", {})],
        routines: [routine("nightly", {}), routine("hourly", {})],
        integrations: [integration("slack"), integration("github")],
      })
    );
    // Platform agents are always present, sorted in among soul agents by name.
    expect(cat.agents.map((a) => a.name)).toEqual(["alpha", "zeta"]);
    expect(cat.skills.map((s) => s.name)).toEqual(["export", "review"]);
    expect(cat.resourceTypes.map((r) => r.name)).toEqual(["invoice", "ticket"]);
    expect(cat.routines.map((r) => r.name)).toEqual(["hourly", "nightly"]);
    expect(cat.integrations.map((i) => i.name)).toEqual(["github", "slack"]);
  });

  it("reads descriptions from each type's metadata, falling back through title then ''", () => {
    const cat = buildSoulCatalogue(
      fakeLoader({
        skills: [skill("s", { description: "Skill desc" })],
        resources: [
          resource("with-desc", { description: "Schema desc", title: "Ignored" }),
          resource("with-title", { title: "Schema title" }),
          resource("bare", {}),
        ],
        routines: [routine("r", { title: "Routine title" })],
        integrations: [integration("i", "Integration title")],
      })
    );
    expect(cat.skills[0]?.description).toBe("Skill desc");
    expect(cat.resourceTypes.find((r) => r.name === "with-desc")?.description).toBe("Schema desc");
    expect(cat.resourceTypes.find((r) => r.name === "with-title")?.description).toBe(
      "Schema title"
    );
    expect(cat.resourceTypes.find((r) => r.name === "bare")?.description).toBe("");
    expect(cat.routines[0]?.description).toBe("Routine title");
    expect(cat.integrations[0]?.description).toBe("Integration title");
  });

  // Skills once landed in the Soul unreviewed and carried `_pendingAudit` until an operator
  // activated them, so the catalogue filtered them out. A Skill now reaches the Soul only after
  // its audit is confirmed, leaving nothing to withhold — and a filter kept past its gate hides
  // Skills from prompt assembly for a reason no code states any more.
  it("lists every Skill in the Soul, including one carrying the legacy pending marker", () => {
    const cat = buildSoulCatalogue(
      fakeLoader({
        skills: [skill("live", { description: "ok" }), skill("legacy", { _pendingAudit: true })],
      })
    );
    expect(cat.skills.map((s) => s.name)).toEqual(["legacy", "live"]);
  });

  it("still lists the platform agents when the loader is absent, with every other section empty", () => {
    const cat = buildSoulCatalogue(undefined);
    expect(cat.agents).toEqual([]);
    expect(cat.skills).toEqual([]);
    expect(cat.resourceTypes).toEqual([]);
    expect(cat.routines).toEqual([]);
    expect(cat.integrations).toEqual([]);
  });

  it("marks a connected Integration's status without a registry", () => {
    const cat = buildSoulCatalogue(fakeLoader({ integrations: [integration("slack", "Chat")] }));
    expect(cat.integrations).toEqual([{ name: "slack", description: "Chat", status: "connected" }]);
  });

  // This is the fix for #663: an Agent that only ever saw connected Integrations claimed a
  // catalogued-but-unconnected one had no native support at all, and invented a raw API-key path.
  describe("with a marketplace registry", () => {
    it("lists a marketplace entry the Soul has not connected, labelled by its availability", () => {
      const cat = buildSoulCatalogue(
        fakeLoader({}),
        new Map([
          ["linear", registryEntry("linear", "coming_soon", "Issue tracking")],
          ["github", registryEntry("github", "available", "Code hosting")],
        ])
      );
      expect(cat.integrations).toEqual([
        { name: "github", description: "Code hosting", status: "available" },
        { name: "linear", description: "Issue tracking", status: "coming_soon" },
      ]);
    });

    it("prefers the connected entry over the registry's copy of the same name", () => {
      const cat = buildSoulCatalogue(
        fakeLoader({ integrations: [integration("github", "Connected description")] }),
        new Map([["github", registryEntry("github", "available", "Marketplace description")]])
      );
      expect(cat.integrations).toEqual([
        { name: "github", description: "Connected description", status: "connected" },
      ]);
    });
  });
});
