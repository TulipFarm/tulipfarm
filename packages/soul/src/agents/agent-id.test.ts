import { describe, expect, it } from "vitest";
import type { SoulAgent } from "../types";
import { agentIdOf, resolveAgentRef } from "./agent-id";

function agent(name: string, frontmatter: Record<string, unknown> = {}): SoulAgent {
  return { id: agentIdOf(name, frontmatter), name, frontmatter, body: "" };
}

describe("agentIdOf", () => {
  it("takes the authored id when the frontmatter carries one", () => {
    const authored = "11111111-2222-3333-4444-555555555555";
    expect(agentIdOf("support-triage", { id: authored })).toBe(authored);
  });

  it("survives a rename once the id is authored", () => {
    const frontmatter = { id: "11111111-2222-3333-4444-555555555555" };
    expect(agentIdOf("support-triage", frontmatter)).toBe(agentIdOf("renamed", frontmatter));
  });

  it("derives a stable id for an Agent authored before the field existed", () => {
    expect(agentIdOf("support-triage", {})).toBe(agentIdOf("support-triage", {}));
    expect(agentIdOf("support-triage", {})).not.toBe(agentIdOf("other", {}));
  });

  it("ignores an id that is not a usable string", () => {
    const derived = agentIdOf("support-triage", {});
    for (const id of [42, "", null, undefined, {}]) {
      expect(agentIdOf("support-triage", { id })).toBe(derived);
    }
  });
});

describe("resolveAgentRef", () => {
  const support = agent("support-triage", { id: "11111111-2222-3333-4444-555555555555" });
  const agents = new Map([[support.name, support]]);

  it("resolves by id", () => {
    expect(resolveAgentRef(agents, support.id)).toBe(support);
  });

  it("resolves by Soul slug, so references made before the id still work", () => {
    expect(resolveAgentRef(agents, "support-triage")).toBe(support);
  });

  it("answers nothing for a reference naming neither", () => {
    expect(resolveAgentRef(agents, "ghost")).toBeUndefined();
  });

  it("prefers the id when a different Agent has since taken the name", () => {
    // `support-triage` was renamed to `triage`, and a new Agent took the freed name. A stored
    // reference to the original must still reach it rather than the impostor holding its old name.
    const renamed: SoulAgent = { ...support, name: "triage" };
    const impostor = agent("support-triage", { id: "99999999-8888-7777-6666-555555555555" });
    const both = new Map([
      [impostor.name, impostor],
      [renamed.name, renamed],
    ]);
    expect(resolveAgentRef(both, renamed.id)).toBe(renamed);
  });
});
