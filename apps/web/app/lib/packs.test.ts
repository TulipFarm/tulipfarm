import { ajv, CHAT_REQUEST_SCHEMA, PACK_MAX_BYTES } from "@tulipfarm/schema";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError, apiGet, apiWrite } from "./api";
import { listPacks, packChatLaunchError, previewPack } from "./packs";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  apiGet: vi.fn(),
  apiWrite: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  listPacks.invalidate();
});

test("catalog reads use the shared API client", async () => {
  vi.mocked(apiGet).mockResolvedValue({ packs: [] });
  expect(await listPacks()).toEqual([]);
  expect(apiGet).toHaveBeenCalledWith("/api/v1/packs");
});

test.each([{ url: "https://example.com/pack.yaml" }, { yaml: "complete: source\n" }])(
  "preview sends only the selected source through the CSRF-aware API client",
  async (source) => {
    vi.mocked(apiWrite).mockResolvedValue({ pack: {}, sha256: "hash" });
    await previewPack(source);
    expect(apiWrite).toHaveBeenCalledWith("POST", "/api/v1/packs/preview", source);
  }
);

test("client preserves API validation errors", async () => {
  const error = new ApiError(422, "invalid", "/yaml");
  vi.mocked(apiWrite).mockRejectedValue(error);
  await expect(previewPack({ yaml: "invalid" })).rejects.toBe(error);
});

test("the complete planning message fits the Chat schema and HTTP body even with maximal JSON escaping", () => {
  const prompt = "\u0000".repeat(PACK_MAX_BYTES);
  const request = {
    message: { role: "user", content: prompt },
    mode: "plan",
    model: "auto",
    clientContext: { route: "/", title: "Chat" },
  };
  expect(packChatLaunchError(prompt)).toBeNull();
  expect(ajv.compile(CHAT_REQUEST_SCHEMA)(request)).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(request)).byteLength).toBeLessThan(1024 * 1024);
});

test("complete-message limits count UTF-8 bytes, never truncate, and reject one byte over", () => {
  const boundary = "é".repeat(PACK_MAX_BYTES / 2);
  expect(new TextEncoder().encode(boundary).byteLength).toBe(PACK_MAX_BYTES);
  expect(packChatLaunchError(boundary)).toBeNull();
  expect(packChatLaunchError(`${boundary}x`)).toContain("Nothing has been sent or omitted");
});
