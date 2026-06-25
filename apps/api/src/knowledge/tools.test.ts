import { describe, expect, it, vi } from "vitest";
import type { KnowledgeService } from "./service";
import { KNOWLEDGE_TOOLS, type KnowledgeTool, type KnowledgeToolContext } from "./tools";

function getTool(name: string): KnowledgeTool {
  const t = KNOWLEDGE_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

function ctx(service: Partial<KnowledgeService>): KnowledgeToolContext {
  return { userId: "u1", service: service as KnowledgeService };
}

describe("knowledge tools", () => {
  it("exposes the knowledge + OKF bundle tools", () => {
    expect(KNOWLEDGE_TOOLS.map((t) => t.name).sort()).toEqual([
      "create_bundle",
      "create_knowledge_collection",
      "create_knowledge_document",
      "list_bundles",
      "list_knowledge_collections",
      "navigate_bundle",
      "query_knowledge",
      "write_concept",
    ]);
  });

  it("query_knowledge validates input and returns results", async () => {
    const search = vi.fn(async () => ({
      results: [
        { documentId: "d", chunkId: "c", title: "T", content: "x", source: "authored", score: 0.9 },
      ],
      warnings: [],
    }));
    const t = getTool("query_knowledge");
    expect(await t.handler({}, ctx({}))).toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
    const good = await t.handler({ query: "france" }, ctx({ search } as never));
    expect(good).toMatchObject({ success: true });
    expect(search).toHaveBeenCalled();
  });

  it("create_knowledge_document validates and returns the id", async () => {
    const createDocument = vi.fn(async () => ({ _id: "doc-1", title: "T" }));
    const t = getTool("create_knowledge_document");
    expect(await t.handler({ title: "T" }, ctx({}))).toMatchObject({ success: false });
    const res = await t.handler({ title: "T", content: "body" }, ctx({ createDocument } as never));
    expect(res).toMatchObject({ success: true, data: { id: "doc-1" } });
  });

  it("create_knowledge_collection returns the id", async () => {
    const createCollection = vi.fn(async () => ({ _id: "col-1", name: "kb" }));
    const res = await getTool("create_knowledge_collection").handler(
      { name: "kb" },
      ctx({ createCollection } as never)
    );
    expect(res).toMatchObject({ success: true, data: { id: "col-1", name: "kb" } });
  });

  it("list_knowledge_collections returns collections", async () => {
    const listCollections = vi.fn(async () => ({
      items: [{ _id: "c1", name: "kb", description: null, domain: null }],
      nextCursor: null,
    }));
    const res = await getTool("list_knowledge_collections").handler(
      {},
      ctx({ listCollections } as never)
    );
    const data = (res as { success: true; data: { collections: unknown[] } }).data;
    expect(data.collections).toHaveLength(1);
  });

  it("returns internal_error (never throws) when the service fails", async () => {
    const search = vi.fn(async () => {
      throw new Error("db down");
    });
    const res = await getTool("query_knowledge").handler({ query: "x" }, ctx({ search } as never));
    expect(res).toMatchObject({
      success: false,
      error: { code: "internal_error", message: "db down" },
    });
  });
});
