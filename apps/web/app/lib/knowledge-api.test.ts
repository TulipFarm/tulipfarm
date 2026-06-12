import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addDocToCollection,
  createDocument,
  deleteDocument,
  listCollectionsWithCounts,
  listDocuments,
  searchDocuments,
  updateDocument,
} from "./knowledge-api";

type Call = { url: string; init: RequestInit };

// Stub global fetch with a responder; `undefined` body simulates a 204 (no JSON parsed).
function mockFetch(responder: (url: string, init: RequestInit) => unknown): Call[] {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const body = responder(url, init);
    return { ok: true, status: body === undefined ? 204 : 200, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const headersOf = (init: RequestInit): Record<string, string> =>
  (init.headers ?? {}) as Record<string, string>;

describe("knowledge-api", () => {
  beforeEach(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: test seeds the csrf cookie that api.ts echoes.
    document.cookie = "csrf_token=tok123";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listDocuments builds a paginated GET", async () => {
    const calls = mockFetch(() => ({ items: [], nextCursor: null }));
    await listDocuments("CUR", 10);
    expect(calls[0].init.method ?? "GET").toBe("GET");
    expect(calls[0].url).toContain("/api/v1/knowledge/documents?");
    expect(calls[0].url).toContain("limit=10");
    expect(calls[0].url).toContain("cursor=CUR");
  });

  it("createDocument POSTs the body with the CSRF echo header", async () => {
    const calls = mockFetch(() => ({ id: "d1", version: 1 }));
    await createDocument({ title: "t", content: "c" });
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].url).toContain("/api/v1/knowledge/documents");
    expect(headersOf(calls[0].init)["x-csrf-token"]).toBe("tok123");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ title: "t", content: "c" });
  });

  it("updateDocument sends a quoted If-Match header", async () => {
    const calls = mockFetch(() => ({ id: "d1", version: 3 }));
    await updateDocument("d1", 2, { title: "x" });
    expect(calls[0].init.method).toBe("PUT");
    expect(headersOf(calls[0].init)["If-Match"]).toBe('"2"');
  });

  it("searchDocuments POSTs to /search", async () => {
    const calls = mockFetch(() => ({ results: [], warnings: [] }));
    await searchDocuments("hello", 5);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].url).toContain("/api/v1/knowledge/search");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ query: "hello", limit: 5 });
  });

  it("addDocToCollection sends a 204 POST without parsing a body", async () => {
    const calls = mockFetch(() => undefined);
    await addDocToCollection("c1", "d1");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].url).toContain("/api/v1/knowledge/collections/c1/documents");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ documentId: "d1" });
  });

  it("deleteDocument issues a DELETE", async () => {
    const calls = mockFetch(() => undefined);
    await deleteDocument("d1");
    expect(calls[0].init.method).toBe("DELETE");
    expect(calls[0].url).toContain("/api/v1/knowledge/documents/d1");
  });

  it("listCollectionsWithCounts attaches docCount via per-collection id fetch (N+1)", async () => {
    const calls = mockFetch((url) => {
      if (url.includes("/collections/c1/documents")) return { documentIds: ["a", "b"] };
      if (url.includes("/collections/c2/documents")) return { documentIds: [] };
      if (url.includes("/collections?")) {
        return {
          items: [
            {
              id: "c1",
              name: "one",
              description: null,
              domain: null,
              version: 1,
              createdAt: "",
              updatedAt: "",
            },
            {
              id: "c2",
              name: "two",
              description: null,
              domain: null,
              version: 1,
              createdAt: "",
              updatedAt: "",
            },
          ],
          nextCursor: null,
        };
      }
      return { items: [], nextCursor: null };
    });
    const res = await listCollectionsWithCounts();
    expect(res.items.find((c) => c.id === "c1")?.docCount).toBe(2);
    expect(res.items.find((c) => c.id === "c2")?.docCount).toBe(0);
    expect(calls.length).toBe(3); // 1 list + 2 count fetches
  });
});
