import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import { getPage, getSpace, type KnowledgePage } from "~/lib/knowledge-api";
import { getMcpKnowledgePageSource } from "~/lib/mcp-knowledge";
import { clientLoader as detailLoader } from "./_app.knowledge.pages.$pageId.$";
import { clientLoader } from "./_app.knowledge.pages.$pageId.edit";

vi.mock("~/lib/knowledge-api", () => ({
  getPage: vi.fn(),
  getSpace: vi.fn(),
  writePage: vi.fn(),
  getBacklinks: vi.fn(),
  listAllPages: vi.fn(),
}));
vi.mock("~/lib/mcp-knowledge", () => ({ getMcpKnowledgePageSource: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

const page: KnowledgePage = {
  id: "page-id",
  title: "Handbook",
  content: "Source content",
  source: "mcp",
  sourceId: "mcp:source-hash",
  domain: null,
  tags: [],
  active: true,
  alwaysLoadForAgents: false,
  version: 1,
  spaceId: "space",
  path: "handbook",
  resource: null,
  createdAt: "2026-09-18T00:00:00Z",
  updatedAt: "2026-09-18T00:00:00Z",
};

test("an edit deep link redirects a synced Page to its read-only view before loading an editor", async () => {
  vi.mocked(getPage).mockResolvedValue(page);
  const result = await clientLoader({
    params: { pageId: "page-id" },
    request: new Request("http://localhost/knowledge/pages/page-id/edit"),
    context: undefined,
    serverLoader: async () => {
      throw new Error("No server loader in this SPA.");
    },
  }).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(Response);
  if (!(result instanceof Response)) throw new Error("Expected a redirect.");
  expect(result.status).toBe(302);
  expect(result.headers.get("Location")).toBe("/knowledge/pages/page-id/handbook");
  expect(getSpace).not.toHaveBeenCalled();
});

test("a revoked source gate prevents the Page loader from returning copied content", async () => {
  vi.mocked(getPage).mockResolvedValue(page);
  vi.mocked(getMcpKnowledgePageSource).mockRejectedValue(new ApiError(404, "Source unavailable."));
  await expect(
    detailLoader({
      params: { pageId: "page-id", "*": "handbook" },
      request: new Request("http://localhost/knowledge/pages/page-id/handbook"),
      context: undefined,
      serverLoader: async () => {
        throw new Error("No server loader in this SPA.");
      },
    })
  ).rejects.toMatchObject({ status: 404 });
  expect(getMcpKnowledgePageSource).toHaveBeenCalledWith("page-id");
  expect(getSpace).not.toHaveBeenCalled();
});
