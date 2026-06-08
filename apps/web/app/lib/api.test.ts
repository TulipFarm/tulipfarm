import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError, getRecord, listRecords, listResourceTypes } from "~/lib/api";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  // Baseline: no token, independent of any ambient apps/web/.env.local. Tests opt in explicitly.
  vi.stubEnv("VITE_API_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("attaches credentials:include and NO Authorization header when no token is set", async () => {
  const fetchFn = mockFetch(200, { types: [] });
  await listResourceTypes();
  const [, init] = fetchFn.mock.calls[0];
  expect(init.credentials).toBe("include");
  expect(init.headers.Authorization).toBeUndefined();
});

test("attaches a Bearer token when VITE_API_TOKEN is set", async () => {
  vi.stubEnv("VITE_API_TOKEN", "tulip_dev");
  const fetchFn = mockFetch(200, { types: [] });
  await listResourceTypes();
  const [, init] = fetchFn.mock.calls[0];
  expect(init.headers.Authorization).toBe("Bearer tulip_dev");
});

test("listResourceTypes unwraps the types array", async () => {
  mockFetch(200, { types: [{ name: "ticket", schema: "type: object", hasHooks: false }] });
  const types = await listResourceTypes();
  expect(types).toHaveLength(1);
  expect(types[0].name).toBe("ticket");
});

test("listRecords builds a query string with limit + includeDeleted, omitting an absent cursor", async () => {
  const fetchFn = mockFetch(200, { items: [], nextCursor: null });
  await listRecords("ticket");
  const [url] = fetchFn.mock.calls[0];
  expect(url).toContain("/api/v1/resources/ticket?");
  expect(url).toContain("limit=50");
  expect(url).toContain("includeDeleted=false");
  expect(url).not.toContain("cursor=");
});

test("listRecords includes the cursor when provided", async () => {
  const fetchFn = mockFetch(200, { items: [], nextCursor: null });
  await listRecords("ticket", "abc123");
  const [url] = fetchFn.mock.calls[0];
  expect(url).toContain("cursor=abc123");
});

test("getRecord encodes path segments", async () => {
  const fetchFn = mockFetch(200, { id: "x", version: 1, createdAt: "", updatedAt: "" });
  await getRecord("ticket", "a/b");
  const [url] = fetchFn.mock.calls[0];
  expect(url).toContain("/api/v1/resources/ticket/a%2Fb");
});

test("throws ApiError carrying the status on 401 and 404", async () => {
  mockFetch(401, { error: "unauthorized" });
  await expect(listResourceTypes()).rejects.toMatchObject({
    name: "ApiError",
    status: 401,
    message: "unauthorized",
  });

  mockFetch(404, { error: "not found" });
  await expect(getRecord("ticket", "missing")).rejects.toBeInstanceOf(ApiError);
});
