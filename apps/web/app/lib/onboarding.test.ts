import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { listOnboardingSuggestions } from "./onboarding";

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

test("listOnboardingSuggestions GETs and unwraps the suggestions array", async () => {
  const fetchFn = mockFetch(200, { suggestions: [{ id: "tickets", label: "L", prompt: "P" }] });
  const out = await listOnboardingSuggestions();
  const [url] = fetchFn.mock.calls[0];
  expect(url).toBe("http://localhost:4010/api/v1/onboarding/suggestions");
  expect(out).toEqual([{ id: "tickets", label: "L", prompt: "P" }]);
});
