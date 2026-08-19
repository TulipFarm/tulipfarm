import type { SoulAgent, SoulLoader } from "@tulipfarm/soul";
import { DEFAULT_ASSISTANT_NAME } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import { hostedAgentResolver } from "./registry";

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

  it("falls back to the default harness, which declares no ceiling", () => {
    const resolved = hostedAgentResolver(loaderWith([])).resolve("missing");

    expect(resolved.name).toBe(DEFAULT_ASSISTANT_NAME);
    expect(resolved.autonomy).toBeUndefined();
  });
});
