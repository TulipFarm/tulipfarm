import { describe, expect, it } from "vitest";
import { FRONTEND_TOOLS } from "../platform/frontend-tools";
import { buildToolRegistry } from "../tools/setup";
import type { KnowledgeService } from "./service";

// Frontend tools (get_client_context, navigate_to) are always-on (no service); they're covered by
// frontend-tools.test.ts, so filter them out here to keep this focused on the knowledge family.
const frontendNames = new Set(FRONTEND_TOOLS.map((t) => t.name));

describe("knowledge tools via ToolRegistry", () => {
  it("exposes the knowledge + OKF tools as an AI SDK tool set", () => {
    const registry = buildToolRegistry({ knowledge: {} as KnowledgeService });
    const set = registry.buildToolSet({ userId: "u" });
    expect(
      Object.keys(set)
        .filter((k) => !frontendNames.has(k))
        .sort()
    ).toEqual([
      "cite_sources",
      "create_bundle",
      "create_knowledge_collection",
      "create_knowledge_document",
      "get_backlinks",
      "get_bundle_graph",
      "get_concept_by_path",
      "get_document",
      "list_bundles",
      "list_knowledge_collections",
      "navigate_bundle",
      "query_knowledge",
      "write_concept",
    ]);
  });
});
