import { describe, expect, it } from "vitest";
import { buildKnowledgeToolSet } from "./ai-toolset";
import type { KnowledgeService } from "./service";

describe("buildKnowledgeToolSet", () => {
  it("exposes the four knowledge tools as an AI SDK tool set", () => {
    const set = buildKnowledgeToolSet({ userId: "u", service: {} as KnowledgeService });
    expect(Object.keys(set).sort()).toEqual([
      "create_knowledge_collection",
      "create_knowledge_document",
      "list_knowledge_collections",
      "query_knowledge",
    ]);
  });
});
