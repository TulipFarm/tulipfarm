import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPage, deletePage, listPages, searchKnowledge, updatePage } from "./knowledge-api";

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

  it("listPages builds a paginated GET", async () => {
    const calls = mockFetch(() => ({ items: [], nextCursor: null }));
    await listPages("CUR", 10);
    expect(calls[0].init.method ?? "GET").toBe("GET");
    expect(calls[0].url).toContain("/api/v1/knowledge/pages?");
    expect(calls[0].url).toContain("limit=10");
    expect(calls[0].url).toContain("cursor=CUR");
  });

  it("createPage POSTs the body with the CSRF echo header", async () => {
    const calls = mockFetch(() => ({ id: "d1", version: 1 }));
    await createPage({ title: "t", content: "c" });
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].url).toContain("/api/v1/knowledge/pages");
    expect(headersOf(calls[0].init)["x-csrf-token"]).toBe("tok123");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ title: "t", content: "c" });
  });

  it("updatePage sends a quoted If-Match header", async () => {
    const calls = mockFetch(() => ({ id: "d1", version: 3 }));
    await updatePage("d1", 2, { title: "x" });
    expect(calls[0].init.method).toBe("PUT");
    expect(headersOf(calls[0].init)["If-Match"]).toBe('"2"');
  });

  it("searchKnowledge POSTs to /search", async () => {
    const calls = mockFetch(() => ({ results: [], warnings: [] }));
    await searchKnowledge("hello", 5);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].url).toContain("/api/v1/knowledge/search");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ query: "hello", limit: 5 });
  });

  it("deletePage issues a DELETE", async () => {
    const calls = mockFetch(() => undefined);
    await deletePage("d1");
    expect(calls[0].init.method).toBe("DELETE");
    expect(calls[0].url).toContain("/api/v1/knowledge/pages/d1");
  });
});
