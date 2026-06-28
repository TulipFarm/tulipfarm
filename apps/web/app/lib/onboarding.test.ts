import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  dismissOnboardingChecklist,
  getOnboardingChecklist,
  listOnboardingSuggestions,
} from "./onboarding";

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

test("getOnboardingChecklist GETs the checklist endpoint and returns the body", async () => {
  const payload = { dismissed: false, steps: [], recommendations: [] };
  const fetchFn = mockFetch(200, payload);
  const out = await getOnboardingChecklist();
  const [url] = fetchFn.mock.calls[0];
  expect(url).toBe("http://localhost:4010/api/v1/onboarding/checklist");
  expect(out).toEqual(payload);
});

test("dismissOnboardingChecklist PUTs the dismissed flag to the user KV store", async () => {
  const fetchFn = mockFetch(200, { key: "checklist", value: { dismissed: true } });
  await dismissOnboardingChecklist();
  const [url, init] = fetchFn.mock.calls[0];
  expect(url).toBe("http://localhost:4010/api/v1/kv/onboarding/checklist");
  expect(init.method).toBe("PUT");
  expect(JSON.parse(init.body)).toEqual({ value: { dismissed: true } });
});
