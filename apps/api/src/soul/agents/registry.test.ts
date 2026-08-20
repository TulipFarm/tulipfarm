import type { SoulAgent, SoulLoader } from "@tulipfarm/soul";
import { DEFAULT_ASSISTANT_NAME } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import { delegableToolNames, hostedAgentResolver } from "./registry";

function loaderWith(agents: readonly SoulAgent[]): SoulLoader {
  return { agents: new Map(agents.map((agent) => [agent.name, agent])) } as unknown as SoulLoader;
}

describe("hostedAgentResolver", () => {
  it("carries the Agent's authored autonomy so the dispatcher can bound the turn by it", () => {
    const loader = loaderWith([
      { name: "mutator", frontmatter: { autonomy: "approval-required" }, body: "" },
    ]);

    expect(hostedAgentResolver(loader).resolve("mutator")).toMatchObject({
      name: "mutator",
      autonomy: "approval-required",
    });
  });

  it("states no autonomy for an Agent that declares none, or declares nonsense", () => {
    const loader = loaderWith([
      { name: "plain", frontmatter: {}, body: "" },
      { name: "bogus", frontmatter: { autonomy: "banana" }, body: "" },
    ]);
    const resolver = hostedAgentResolver(loader);

    expect(resolver.resolve("plain").autonomy).toBeUndefined();
    expect(resolver.resolve("bogus").autonomy).toBeUndefined();
  });

  it("carries authored capability restrictions to the dispatcher", () => {
    const loader = loaderWith([
      {
        name: "cleanup",
        frontmatter: { capabilityRestrictions: { records: { actions: { deny: ["delete"] } } } },
        body: "",
      },
    ]);

    expect(hostedAgentResolver(loader).resolve("cleanup")).toMatchObject({
      name: "cleanup",
      capabilityRestrictions: { records: { actions: { deny: ["delete"] } } },
    });
  });

  it("falls back to the default harness, which declares no ceiling", () => {
    const resolved = hostedAgentResolver(loaderWith([])).resolve("missing");

    expect(resolved.name).toBe(DEFAULT_ASSISTANT_NAME);
    expect(resolved.autonomy).toBeUndefined();
  });
});

describe("delegableToolNames", () => {
  const catalog = [
    { name: "record_list", mutating: false },
    { name: "record_delete", mutating: true },
    { name: "delegate_to_agent", mutating: true },
    { name: "complete_state", mutating: true },
  ];

  it("leaves the delegation root untouched for an Agent with no restrictions", () => {
    const loader = loaderWith([{ name: "plain", frontmatter: {}, body: "" }]);

    expect(delegableToolNames(loader, "plain", catalog)).toBeUndefined();
    expect(delegableToolNames(loader, undefined, catalog)).toBeUndefined();
  });

  it("narrows the delegation root to what a restricted Agent itself holds", () => {
    const loader = loaderWith([
      {
        name: "reporter",
        frontmatter: { capabilityRestrictions: { tools: { allowMutating: false } } },
        body: "",
      },
    ]);

    const names = delegableToolNames(loader, "reporter", catalog);

    expect(names).toContain("record_list");
    expect(names).not.toContain("record_delete");
    expect(names).not.toContain("delegate_to_agent");
  });
});
