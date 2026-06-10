import type { SoulAgent, SoulLoader } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import {
  GENERAL_ASSISTANT,
  GENERAL_ASSISTANT_NAME,
  getAgent,
  listAgents,
  resolveAgent,
} from "./registry";

function makeSoulLoader(agents: SoulAgent[] = []): SoulLoader {
  return { agents: new Map(agents.map((a) => [a.name, a])) } as unknown as SoulLoader;
}

const PLANNER: SoulAgent = {
  name: "sprint-planner",
  frontmatter: { label: "Sprint Planner", domain: "engineering" },
  body: "# Role\nYou plan sprints.",
};

describe("agent registry", () => {
  describe("GENERAL_ASSISTANT built-in", () => {
    it("has the reserved PascalCase name, a label, and a non-empty body", () => {
      expect(GENERAL_ASSISTANT.name).toBe(GENERAL_ASSISTANT_NAME);
      expect(GENERAL_ASSISTANT_NAME).toBe("GeneralAssistant");
      expect(GENERAL_ASSISTANT.frontmatter.label).toBeTruthy();
      expect(GENERAL_ASSISTANT.body.length).toBeGreaterThan(0);
    });

    it("carries no per-agent tool allowlist (flat ALLOW_ALL, AGT-V1-007)", () => {
      expect(GENERAL_ASSISTANT.frontmatter).not.toHaveProperty("tools");
      expect(GENERAL_ASSISTANT.frontmatter).not.toHaveProperty("allowedTools");
    });
  });

  describe("resolveAgent", () => {
    it("falls back to GeneralAssistant on a fresh install (undefined soulLoader)", () => {
      expect(resolveAgent(undefined, undefined)).toBe(GENERAL_ASSISTANT);
    });

    it("falls back to GeneralAssistant when no agentId is selected", () => {
      expect(resolveAgent(makeSoulLoader([PLANNER]), undefined)).toBe(GENERAL_ASSISTANT);
    });

    it("resolves the GeneralAssistant name to the built-in", () => {
      expect(resolveAgent(makeSoulLoader([PLANNER]), GENERAL_ASSISTANT_NAME)).toBe(
        GENERAL_ASSISTANT
      );
    });

    it("falls back to GeneralAssistant for an unknown/deleted agentId", () => {
      expect(resolveAgent(makeSoulLoader([PLANNER]), "ghost")).toBe(GENERAL_ASSISTANT);
    });

    it("resolves a loaded soul agent by id", () => {
      expect(resolveAgent(makeSoulLoader([PLANNER]), "sprint-planner")).toBe(PLANNER);
    });
  });

  describe("listAgents", () => {
    it("lists GeneralAssistant first on a fresh install", () => {
      expect(listAgents(makeSoulLoader([]))).toEqual([GENERAL_ASSISTANT]);
    });

    it("lists GeneralAssistant first, then loaded soul agents", () => {
      expect(listAgents(makeSoulLoader([PLANNER]))).toEqual([GENERAL_ASSISTANT, PLANNER]);
    });

    it("handles an undefined soulLoader", () => {
      expect(listAgents(undefined)).toEqual([GENERAL_ASSISTANT]);
    });
  });

  describe("getAgent", () => {
    it("returns the built-in by its reserved name", () => {
      expect(getAgent(makeSoulLoader([PLANNER]), GENERAL_ASSISTANT_NAME)).toBe(GENERAL_ASSISTANT);
    });

    it("returns a loaded soul agent by name", () => {
      expect(getAgent(makeSoulLoader([PLANNER]), "sprint-planner")).toBe(PLANNER);
    });

    it("returns undefined for an unknown name (no built-in fallback)", () => {
      expect(getAgent(makeSoulLoader([PLANNER]), "ghost")).toBeUndefined();
    });
  });
});
