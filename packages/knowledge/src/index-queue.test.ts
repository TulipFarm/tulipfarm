import { describe, expect, it, vi } from "vitest";
import { type Enqueuer, enqueueIndex, handleIndexJob, jobKey, resourceToText } from "./index-queue";
import type { KnowledgeService } from "./service";

function fakeService() {
  const reindexById = vi.fn(async () => {});
  const ingestSource = vi.fn(async () => null);
  return {
    service: { reindexById, ingestSource } as unknown as KnowledgeService,
    reindexById,
    ingestSource,
  };
}

describe("jobKey", () => {
  it("is deterministic per source", () => {
    expect(jobKey({ kind: "page", pageId: "d1" })).toBe("page:d1");
    expect(jobKey({ kind: "resource", resourceType: "ticket", resourceId: "r1", record: {} })).toBe(
      "resource:r1"
    );
    expect(jobKey({ kind: "conversation", conversationId: "c1" })).toBe("conversation:c1");
  });
});

describe("resourceToText", () => {
  it("joins string fields and skips system + non-string fields", () => {
    const { title, content } = resourceToText("ticket", {
      id: "x",
      version: 1,
      title: "Bug",
      body: "broken",
      count: 3,
    });
    expect(title).toBe("Bug");
    expect(content).toContain("body: broken");
    expect(content).not.toContain("version");
    expect(content).not.toContain("count");
  });

  it("falls back to name then type+id for the title", () => {
    expect(resourceToText("ticket", { name: "Acme" }).title).toBe("Acme");
    expect(resourceToText("ticket", { id: "7" }).title).toBe("ticket 7");
  });
});

describe("handleIndexJob", () => {
  it("page job → reindexById", async () => {
    const { service, reindexById } = fakeService();
    await handleIndexJob({ kind: "page", pageId: "d1" }, { service });
    expect(reindexById).toHaveBeenCalledWith("d1");
  });

  it("resource job → ingestSource with flattened text", async () => {
    const { service, ingestSource } = fakeService();
    await handleIndexJob(
      {
        kind: "resource",
        resourceType: "ticket",
        resourceId: "r1",
        record: { title: "Bug", body: "x" },
      },
      { service }
    );
    expect(ingestSource).toHaveBeenCalledWith(
      expect.objectContaining({ source: "resource", sourceId: "r1", title: "Bug" })
    );
  });

  it("resource job with no indexable text → no-op", async () => {
    const { service, ingestSource } = fakeService();
    await handleIndexJob(
      { kind: "resource", resourceType: "ticket", resourceId: "r1", record: { id: "x" } },
      { service }
    );
    expect(ingestSource).not.toHaveBeenCalled();
  });

  it("conversation job → ingestSource via loadConversationText", async () => {
    const { service, ingestSource } = fakeService();
    const loadConversationText = vi.fn(async () => ({ title: "Chat", content: "hello there" }));
    await handleIndexJob(
      { kind: "conversation", conversationId: "c1" },
      { service, loadConversationText }
    );
    expect(loadConversationText).toHaveBeenCalledWith("c1");
    expect(ingestSource).toHaveBeenCalledWith(
      expect.objectContaining({ source: "conversation", sourceId: "c1" })
    );
  });

  it("conversation job with no loader → no-op", async () => {
    const { service, ingestSource } = fakeService();
    await handleIndexJob({ kind: "conversation", conversationId: "c1" }, { service });
    expect(ingestSource).not.toHaveBeenCalled();
  });
});

describe("enqueueIndex", () => {
  it("sends with a deterministic singletonKey + retry config", async () => {
    const send = vi.fn(async () => "job-id");
    const boss: Enqueuer = { send };
    await enqueueIndex(boss, { kind: "page", pageId: "d1" });
    expect(send).toHaveBeenCalledWith(
      "knowledge-index",
      { kind: "page", pageId: "d1" },
      { singletonKey: "page:d1", retryLimit: 3, retryBackoff: true }
    );
  });
});
