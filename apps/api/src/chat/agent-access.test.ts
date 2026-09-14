import { DEFAULT_ASSISTANT_ID, type SoulAgent } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import type { TeamAssetService } from "../team-assets/service";
import { mayUseAgent } from "./agent-access";

describe("mayUseAgent", () => {
  const principal = { kind: "user" as const, id: "user-123", businessId: "bus-123" };

  it("permits default assistant without checking teamAssets", async () => {
    const defaultAgent: SoulAgent = {
      id: DEFAULT_ASSISTANT_ID,
      name: "tulip",
      frontmatter: {},
      body: "",
    };
    const access = vi.fn();
    const allowed = await mayUseAgent(defaultAgent, principal, {
      access,
    } as unknown as TeamAssetService);
    expect(allowed).toBe(true);
    expect(access).not.toHaveBeenCalled();
  });

  it("checks teamAssets.access using agent.id rather than name", async () => {
    const customAgent: SoulAgent = {
      id: "77f84984-4295-4514-afd3-f61972224c7b",
      name: "qa-demos-staging-tester-fresh",
      frontmatter: {
        ownership: { teamId: "663a2569-2cff-4fae-90b6-4d13df54e50d" },
      },
      body: "custom instructions",
    };

    const access = vi.fn().mockResolvedValue({ levels: ["view", "use"] });
    const allowed = await mayUseAgent(customAgent, principal, {
      access,
    } as unknown as TeamAssetService);

    expect(allowed).toBe(true);
    expect(access).toHaveBeenCalledWith(
      "agent",
      customAgent.id,
      principal,
      customAgent.frontmatter.ownership
    );
  });

  it("returns false if use level is not granted", async () => {
    const customAgent: SoulAgent = {
      id: "77f84984-4295-4514-afd3-f61972224c7b",
      name: "qa-demos-staging-tester-fresh",
      frontmatter: {},
      body: "",
    };

    const access = vi.fn().mockResolvedValue({ levels: ["view"] });
    const allowed = await mayUseAgent(customAgent, principal, {
      access,
    } as unknown as TeamAssetService);

    expect(allowed).toBe(false);
  });

  it("returns false if teamAssets service is undefined", async () => {
    const customAgent: SoulAgent = {
      id: "77f84984-4295-4514-afd3-f61972224c7b",
      name: "qa-demos-staging-tester-fresh",
      frontmatter: {},
      body: "",
    };

    const allowed = await mayUseAgent(customAgent, principal, undefined);
    expect(allowed).toBe(false);
  });
});
