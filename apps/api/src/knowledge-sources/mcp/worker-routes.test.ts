import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpKnowledgeFeature } from "./compose";
import { type McpKnowledgeRunReaderResolver, registerMcpKnowledgeWorkerRoutes } from "./routes";

const payload = {
  runId: "11111111-1111-4111-8111-111111111111",
  readerUserId: "reader",
  pageId: "22222222-2222-4222-8222-222222222222",
};
const url = "/api/v1/internal/mcp-knowledge/page-access";

describe("MCP Knowledge worker reader authority", () => {
  let app: FastifyInstance;
  let authenticated: boolean;
  const resolveReader = vi.fn<McpKnowledgeRunReaderResolver>();
  const canReadPageForRun = vi.fn<McpKnowledgeFeature["canReadPageForRun"]>();

  beforeEach(async () => {
    authenticated = true;
    resolveReader.mockReset().mockResolvedValue("reader");
    canReadPageForRun.mockReset().mockResolvedValue(true);
    app = Fastify();
    registerMcpKnowledgeWorkerRoutes(
      app,
      {
        canReadPageForRun,
        reconcile: async () => 0,
        batch: async () => {
          throw new Error("unexpected batch");
        },
      },
      async (_request, reply) => {
        if (!authenticated) reply.code(403).send({ error: "forbidden", message: "Forbidden" });
      },
      resolveReader
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("authenticates the worker before resolving a reader", async () => {
    authenticated = false;
    const response = await app.inject({ method: "POST", url, payload });
    expect(response.statusCode).toBe(403);
    expect(resolveReader).not.toHaveBeenCalled();
    expect(canReadPageForRun).not.toHaveBeenCalled();
  });

  it.each(["another-user", undefined])(
    "rejects a claimed reader when authority is %s",
    async (reader) => {
      resolveReader.mockResolvedValue(reader);
      const response = await app.inject({ method: "POST", url, payload });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ allowed: false });
      expect(canReadPageForRun).not.toHaveBeenCalled();
    }
  );

  it("binds the fresh source check to the Run reader and rechecks lineage afterward", async () => {
    const response = await app.inject({ method: "POST", url, payload });
    expect(response.json()).toEqual({ allowed: true });
    expect(resolveReader).toHaveBeenCalledTimes(2);
    expect(resolveReader).toHaveBeenNthCalledWith(1, payload.runId);
    expect(resolveReader).toHaveBeenNthCalledWith(2, payload.runId);
    expect(canReadPageForRun).toHaveBeenCalledWith(payload.runId, "reader", payload.pageId);
  });

  it("withholds access when reader authority disappears during the source read", async () => {
    resolveReader.mockResolvedValueOnce("reader").mockResolvedValueOnce(undefined);
    const response = await app.inject({ method: "POST", url, payload });
    expect(response.json()).toEqual({ allowed: false });
    expect(canReadPageForRun).toHaveBeenCalledOnce();
  });

  it("does not turn valid reader authority into source permission", async () => {
    canReadPageForRun.mockResolvedValue(false);
    const response = await app.inject({ method: "POST", url, payload });
    expect(response.json()).toEqual({ allowed: false });
  });

  it("surfaces authority lookup failures without attempting a source read", async () => {
    resolveReader.mockRejectedValue(new Error("authority unavailable"));
    const response = await app.inject({ method: "POST", url, payload });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("knowledge_access_unavailable");
    expect(canReadPageForRun).not.toHaveBeenCalled();
  });

  it("requires both the Run and claimed reader", async () => {
    for (const body of [
      { pageId: payload.pageId, readerUserId: "reader" },
      {
        pageId: payload.pageId,
        runId: payload.runId,
      },
    ]) {
      const response = await app.inject({ method: "POST", url, payload: body });
      expect(response.statusCode).toBe(400);
    }
    expect(resolveReader).not.toHaveBeenCalled();
  });
});
