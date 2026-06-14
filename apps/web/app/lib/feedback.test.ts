import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearFeedback, getConversationFeedback, sendFeedback } from "./feedback";

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
  vi.stubEnv("VITE_API_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("sendFeedback POSTs rating + note to the message endpoint", async () => {
  const fetchFn = mockFetch(200, { status: "ok" });
  await sendFeedback("m1", "down", "too long");
  const [url, init] = fetchFn.mock.calls[0];
  expect(url).toBe("http://localhost:4010/api/v1/messages/m1/feedback");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ rating: "down", note: "too long" });
});

test("sendFeedback omits note when not provided", async () => {
  const fetchFn = mockFetch(200, { status: "ok" });
  await sendFeedback("m1", "up");
  const [, init] = fetchFn.mock.calls[0];
  expect(JSON.parse(init.body)).toEqual({ rating: "up" });
});

test("clearFeedback DELETEs the message endpoint", async () => {
  const fetchFn = mockFetch(200, {});
  await clearFeedback("m1");
  const [url, init] = fetchFn.mock.calls[0];
  expect(url).toBe("http://localhost:4010/api/v1/messages/m1/feedback");
  expect(init.method).toBe("DELETE");
});

test("getConversationFeedback GETs and unwraps the list", async () => {
  const fetchFn = mockFetch(200, {
    feedback: [{ messageId: "m1", rating: "up", note: null }],
  });
  const out = await getConversationFeedback("c1");
  const [url] = fetchFn.mock.calls[0];
  expect(url).toBe("http://localhost:4010/api/v1/conversations/c1/feedback");
  expect(out).toEqual([{ messageId: "m1", rating: "up", note: null }]);
});
