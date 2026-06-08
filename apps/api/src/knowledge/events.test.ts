import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { DOMAIN_EVENTS } from "../domain-events";
import { subscribeKnowledgeIndexing } from "./events";
import type { Enqueuer } from "./indexing";

describe("subscribeKnowledgeIndexing", () => {
  it("enqueues a resource job on resource.created and resource.updated", async () => {
    const send = vi.fn(async () => "j");
    const boss: Enqueuer = { send };
    const emitter = new EventEmitter();
    subscribeKnowledgeIndexing(emitter, boss);

    emitter.emit(DOMAIN_EVENTS.RESOURCE_CREATED, {
      resourceType: "ticket",
      resourceId: "r1",
      record: { title: "x" },
    });
    emitter.emit(DOMAIN_EVENTS.RESOURCE_UPDATED, {
      resourceType: "ticket",
      resourceId: "r2",
      record: { title: "y" },
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    expect(send).toHaveBeenNthCalledWith(
      1,
      "knowledge-index",
      expect.objectContaining({ kind: "resource", resourceId: "r1" }),
      expect.objectContaining({ singletonKey: "resource:r1" })
    );
  });

  it("enqueues a conversation job on conversation.completed", async () => {
    const send = vi.fn(async () => "j");
    const emitter = new EventEmitter();
    subscribeKnowledgeIndexing(emitter, { send });

    emitter.emit(DOMAIN_EVENTS.CONVERSATION_COMPLETED, { conversationId: "c1" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith(
      "knowledge-index",
      expect.objectContaining({ kind: "conversation", conversationId: "c1" }),
      expect.anything()
    );
  });
});
