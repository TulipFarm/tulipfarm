import {
  type KnowledgePage,
  type PageReadAuthorizer,
  PgKnowledgePageRepo,
} from "@tulipfarm/knowledge";
import type { Queryable } from "@tulipfarm/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InternalApiClient } from "../internal/client";
import { createWorkerMcpPageReadGate } from "./mcp-page-gate";

const page: KnowledgePage = {
  _id: "00000000-0000-4000-8000-000000000001",
  title: "Private source",
  content: "Private content",
  plainText: "Private content",
  source: "mcp",
  sourceId: "mcp:source",
  domain: null,
  tags: [],
  active: true,
  alwaysLoadForAgents: false,
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const db: Queryable = { query: async () => ({ rows: [] }) };

function fixture() {
  vi.spyOn(PgKnowledgePageRepo.prototype, "getById").mockResolvedValue(page);
  vi.spyOn(PgKnowledgePageRepo.prototype, "listBySpace").mockResolvedValue([page]);
  const authored: PageReadAuthorizer = {
    canRead: vi.fn(async () => true),
    readablePageIds: async (_, ids) => ({ allowed: ids, excluded: 0 }),
    canReadSpace: async () => true,
    readableSpaceIds: async (_, ids) => ids,
    canEdit: async () => true,
    assertDeleteApproved: async () => {},
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => Response.json({ allowed: true }));
  const client = new InternalApiClient({
    baseUrl: "http://api.test",
    credential: "test-service-credential",
    fetch,
  });
  const require = vi.spyOn(client, "require");
  const logger = { error: vi.fn() };
  const context = {
    userId: "actual-reader",
    subject: { kind: "user", id: "actual-reader" },
    runId: "00000000-0000-4000-8000-000000000002",
  };
  const gate = createWorkerMcpPageReadGate(authored, db, client, context, logger);
  return { authored, require, fetch, logger, context, gate };
}

afterEach(() => vi.restoreAllMocks());

describe("worker MCP Page gate", () => {
  it("rechecks each use through the service callback with the actual Run reader", async () => {
    const f = fixture();
    expect(await f.gate.canRead("actual-reader", page._id)).toBe(true);
    expect(await f.gate.canRead("actual-reader", page._id)).toBe(true);
    expect(f.require).toHaveBeenCalledTimes(2);
    expect(f.require).toHaveBeenCalledWith(
      "POST",
      "/api/v1/internal/mcp-knowledge/page-access",
      { runId: f.context.runId, readerUserId: "actual-reader", pageId: page._id },
      expect.objectContaining({ timeoutMs: 35_000 })
    );
    expect(f.authored.canRead).not.toHaveBeenCalled();
  });

  it("never substitutes an owner or uses an authored grant when the live check fails", async () => {
    const f = fixture();
    expect(await f.gate.canRead("source-owner", page._id)).toBe(false);
    expect(f.require).not.toHaveBeenCalled();
    f.fetch.mockRejectedValue(new Error("private provider output"));
    expect(await f.gate.canRead("actual-reader", page._id)).toBe(false);
    expect(f.logger.error).toHaveBeenCalledWith("MCP Knowledge fresh reader check unavailable");
    expect(f.authored.canRead).not.toHaveBeenCalled();
  });

  it("refuses copies when the host lacks the service callback and refuses their writes", async () => {
    const f = fixture();
    const missing = createWorkerMcpPageReadGate(f.authored, db, undefined, f.context);
    expect(await missing.canRead("actual-reader", page._id)).toBe(false);
    expect(await f.gate.canEdit?.("actual-reader", "page", page._id)).toBe(false);
    expect(await f.gate.canEdit?.("actual-reader", "space", "space")).toBe(false);
  });

  it("preserves the normal authored gate for non-MCP Pages", async () => {
    const f = fixture();
    vi.spyOn(PgKnowledgePageRepo.prototype, "getById").mockResolvedValue({
      ...page,
      source: "authored",
    });
    expect(await f.gate.canRead("actual-reader", page._id)).toBe(true);
    expect(f.authored.canRead).toHaveBeenCalledWith("actual-reader", page._id);
    expect(f.require).not.toHaveBeenCalled();
  });
});
