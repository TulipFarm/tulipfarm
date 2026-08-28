import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DISTILLED_TOOLS, estimateTokens, MAX_RAW_RESULT_TOKENS } from "@tulipfarm/agent-runtime";
import { loadBundledSkills } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import { NETWORK_TOOLS } from "../tools/network/tools.js";

/**
 * A bundled Skill must fit in one Tool result, whole.
 *
 * `skill` results are exempt from distillation precisely because a summary of instructions is not
 * instructions — but the cut at `MAX_RAW_RESULT_TOKENS` still applies, and a Skill that crosses it
 * loses its tail silently. The tail is where a SKILL.md keeps its worked examples, so the model
 * would be handed the doctrine without the shapes and left to guess them.
 *
 * Every advertised reference file is under the same ceiling for the same reason.
 */
const logger = { info() {}, warn() {}, error() {} };

describe("bundled Skill sizes", () => {
  it("keeps every bundled Skill and its references inside one Tool result", async () => {
    const skills = await loadBundledSkills(logger);
    expect(skills.size).toBeGreaterThan(0);

    const oversized: string[] = [];
    for (const [name, skill] of skills) {
      if (estimateTokens(skill.body) > MAX_RAW_RESULT_TOKENS) {
        oversized.push(`${name}/SKILL.md is ${skill.body.length} chars`);
      }
      for (const file of skill.files) {
        const content = await readFile(join(skill.directory, file), "utf8");
        if (estimateTokens(content) > MAX_RAW_RESULT_TOKENS) {
          oversized.push(`${name}/${file} is ${content.length} chars`);
        }
      }
    }

    expect(oversized, `cut at ${MAX_RAW_RESULT_TOKENS} tokens`).toEqual([]);
  });
});

describe("what gets distilled", () => {
  it("summarises a page read and nothing else", () => {
    // `DISTILLED_TOOLS` lives in `@tulipfarm/agent-runtime`, which cannot import this app, so the
    // set is pinned here. Distillation was documented for network Tools
    // (docs/architecture/governed-network-tools.md) but applied to every Tool, which is how a
    // Skill's instructions came back to the model as a summary of themselves.
    expect([...DISTILLED_TOOLS]).toEqual(["web_fetch"]);
  });

  it("never summarises an API response", () => {
    // A JSON body is already the compact form, and `api_request` is mutating and never cached, so
    // an Agent that believes its result was filtered pays a second request to see the rest.
    const apiRequest = NETWORK_TOOLS.find((tool) => tool.name === "api_request");

    expect(apiRequest).toBeDefined();
    expect(DISTILLED_TOOLS.has("api_request")).toBe(false);
    expect(apiRequest?.inputSchema.properties).not.toHaveProperty("prompt");
  });
});
