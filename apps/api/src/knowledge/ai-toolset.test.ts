import { describe, expect, it } from "vitest";
import { buildToolRegistry } from "../tools/setup";
import type { KnowledgeService } from "./service";

describe("knowledge tools via ToolRegistry", () => {
  it("exposes the four knowledge tools as an AI SDK tool set", () => {
    const registry = buildToolRegistry({ knowledge: {} as KnowledgeService });
    const set = registry.buildToolSet({ userId: "u" });
    expect(Object.keys(set).sort()).toEqual([
      "create_knowledge_collection",
      "create_knowledge_document",
      "list_knowledge_collections",
      "query_knowledge",
    ]);
  });
});
