import { KNOWLEDGE_TOOLS } from "@tulipfarm/knowledge";
import { KV_TOOLS } from "@tulipfarm/kv";
import { MEMORY_DOCUMENT_TOOLS } from "@tulipfarm/memory";
import { describe, expect, it } from "vitest";
import { FRONTEND_TOOLS } from "../platform/frontend-tools";
import { PLATFORM_TOOLS } from "../platform/tools";
import { RESOURCE_TOOLS } from "../resources/tools.js";
import { AGENT_TOOLS } from "../soul/agents/tools.js";
import { RESOURCE_TYPE_TOOLS } from "../soul/resource-types/tools.js";
import { SKILL_TOOLS } from "../soul/skills/tools.js";

/* Provider schema sweep: statically registered Tool patterns must stay lookaround-free. */

const ALL_TOOL_SETS: Array<[string, ReadonlyArray<{ name: string; inputSchema: unknown }>]> = [
  ["MEMORY_DOCUMENT_TOOLS", MEMORY_DOCUMENT_TOOLS],
  ["KV_TOOLS", KV_TOOLS],
  ["KNOWLEDGE_TOOLS", KNOWLEDGE_TOOLS],
  ["RESOURCE_TOOLS", RESOURCE_TOOLS],
  ["RESOURCE_TYPE_TOOLS", RESOURCE_TYPE_TOOLS],
  ["AGENT_TOOLS", AGENT_TOOLS],
  ["SKILL_TOOLS", SKILL_TOOLS],
  ["PLATFORM_TOOLS", PLATFORM_TOOLS],
  ["FRONTEND_TOOLS", FRONTEND_TOOLS],
];

/** Collect every `pattern` keyword value in a JSON-Schema tree. */
function collectPatterns(node: unknown, path: string, out: Array<[string, string]>): void {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) collectPatterns(item, `${path}[${i}]`, out);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "pattern" && typeof value === "string") out.push([`${path}.pattern`, value]);
    else collectPatterns(value, `${path}.${key}`, out);
  }
}

const LOOKAROUND = /\(\?[=!<]/;

describe("tool inputSchema LLM compatibility", () => {
  it("no registered tool schema uses regex lookaround in a pattern", () => {
    const offenders: string[] = [];
    for (const [setName, tools] of ALL_TOOL_SETS) {
      for (const tool of tools) {
        const patterns: Array<[string, string]> = [];
        collectPatterns(tool.inputSchema, `${setName}/${tool.name}`, patterns);
        for (const [at, pattern] of patterns) {
          if (LOOKAROUND.test(pattern)) offenders.push(`${at} = ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
