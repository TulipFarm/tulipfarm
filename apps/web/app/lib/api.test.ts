import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ApiError,
  CATALOG_TTL_MS,
  createRecord,
  createResourceType,
  getRecord,
  getSession,
  listRecords,
  listResourceTypes,
  login,
  updateRecord,
} from "~/lib/api";

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
  // The catalog readers hold a settled value across calls, so without this a test would be served
  // the previous test's mock instead of its own.
  listResourceTypes.invalidate();
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

test("login POSTs credentials with credentials:include and returns the user", async () => {
  const fetchFn = mockFetch(200, {
    user: { id: "u1", email: "admin@tulipfarm.dev", role: "admin" },
  });
  const user = await login("admin@tulipfarm.dev", "pw");
  const [url, init] = fetchFn.mock.calls[0];
  expect(url).toContain("/api/v1/auth/login");
  expect(init.method).toBe("POST");
  expect(init.credentials).toBe("include");
  expect(JSON.parse(init.body)).toEqual({ email: "admin@tulipfarm.dev", password: "pw" });
  expect(user.email).toBe("admin@tulipfarm.dev");
});

test("login throws ApiError with the API message on 401", async () => {
  mockFetch(401, { error: "invalid credentials" });
  await expect(login("admin@tulipfarm.dev", "wrong")).rejects.toMatchObject({
    status: 401,
    message: "invalid credentials",
  });
});

test("getSession unwraps the current user", async () => {
  mockFetch(200, { user: { id: "u1", email: "admin@tulipfarm.dev", role: "admin" } });
  expect((await getSession()).role).toBe("admin");
});

test("listResourceTypes unwraps the types array", async () => {
  mockFetch(200, { types: [{ name: "ticket", schema: "type: object", hasHooks: false }] });
  const types = await listResourceTypes();
  expect(types).toHaveLength(1);
  expect(types[0].name).toBe("ticket");
});

// The sidebar's counts and the chat mention picker want the same catalogs but mount a few hundred
// milliseconds apart, so sharing only the in-flight promise still fetched each list twice per load.
test("serves a second caller from the settled catalog read instead of refetching", async () => {
  const fetchFn = mockFetch(200, {
    types: [{ name: "ticket", schema: "type: object", hasHooks: false }],
  });
  const first = await listResourceTypes();
  const second = await listResourceTypes();
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(second).toEqual(first);
});

test("refetches the catalog once the reuse window has passed", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const fetchFn = mockFetch(200, { types: [] });
    await listResourceTypes();
    vi.setSystemTime(Date.now() + CATALOG_TTL_MS + 1);
    await listResourceTypes();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test("writing a resource type drops the cached catalog so the next read sees it", async () => {
  mockFetch(200, { types: [] });
  expect(await listResourceTypes()).toHaveLength(0);

  mockFetch(201, { name: "ticket", schema: "type: object", hasHooks: false });
  await createResourceType("ticket", "type: object");

  const refetch = mockFetch(200, {
    types: [{ name: "ticket", schema: "type: object", hasHooks: false }],
  });
  expect(await listResourceTypes()).toHaveLength(1);
  expect(refetch).toHaveBeenCalledTimes(1);
});

test("does not cache a failed catalog read", async () => {
  mockFetch(500, { error: "boom" });
  await expect(listResourceTypes()).rejects.toBeInstanceOf(ApiError);

  const retry = mockFetch(200, {
    types: [{ name: "ticket", schema: "type: object", hasHooks: false }],
  });
  expect(await listResourceTypes()).toHaveLength(1);
  expect(retry).toHaveBeenCalledTimes(1);
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

test("createRecord POSTs a JSON body with Content-Type, idempotency key, and credentials:include", async () => {
  const fetchFn = mockFetch(201, { id: "TICK-1", version: 1, createdAt: "", updatedAt: "" });
  await createRecord("ticket", { title: "hi", open: true });
  const [url, init] = fetchFn.mock.calls[0];
  expect(url).toContain("/api/v1/resources/ticket");
  expect(init.method).toBe("POST");
  expect(init.credentials).toBe("include");
  expect(init.headers["Content-Type"]).toBe("application/json");
  expect(init.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.parse(init.body)).toEqual({ title: "hi", open: true });
});

test("updateRecord PUTs with a quoted If-Match version header and encodes the id", async () => {
  const fetchFn = mockFetch(200, { id: "TICK-1", version: 5, createdAt: "", updatedAt: "" });
  await updateRecord("ticket", "a/b", 4, { title: "edit" });
  const [url, init] = fetchFn.mock.calls[0];
  expect(url).toContain("/api/v1/resources/ticket/a%2Fb");
  expect(init.method).toBe("PUT");
  expect(init.headers["If-Match"]).toBe('"4"');
});

test("writes echo the csrf_token cookie as the x-csrf-token header", async () => {
  // biome-ignore lint/suspicious/noDocumentCookie: test verifies CSRF cookie → header wiring
  document.cookie = "csrf_token=tok-123";
  const fetchFn = mockFetch(201, { id: "x", version: 1, createdAt: "", updatedAt: "" });
  await createRecord("ticket", { title: "hi" });
  const [, init] = fetchFn.mock.calls[0];
  expect(init.headers["x-csrf-token"]).toBe("tok-123");
  // clear for other tests
  // biome-ignore lint/suspicious/noDocumentCookie: clearing test cookie
  document.cookie = "csrf_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
});

test("a 422 validation error surfaces the field path on the ApiError", async () => {
  mockFetch(422, { error: "must be string", boundary: "resource", path: "/customerId" });
  await expect(createRecord("ticket", {})).rejects.toMatchObject({
    status: 422,
    message: "must be string",
    path: "/customerId",
  });
});

test("a 409 version conflict throws ApiError with status 409", async () => {
  mockFetch(409, { error: "version conflict" });
  await expect(updateRecord("ticket", "TICK-1", 1, {})).rejects.toMatchObject({
    status: 409,
    message: "version conflict",
  });
});
