import { describe, expect, it } from "vitest";
import { MemorySessionStore } from "./session-store";

describe("MemorySessionStore", () => {
  it("create then get returns the userId", async () => {
    const store = new MemorySessionStore();
    const sid = await store.create("user-1");
    expect(await store.get(sid)).toBe("user-1");
  });

  it("returns null for an unknown sid", async () => {
    const store = new MemorySessionStore();
    expect(await store.get("missing")).toBeNull();
  });

  it("destroy removes the session", async () => {
    const store = new MemorySessionStore();
    const sid = await store.create("user-1");
    await store.destroy(sid);
    expect(await store.get(sid)).toBeNull();
  });

  it("generates unique 43-char base64url session ids", async () => {
    const store = new MemorySessionStore();
    const a = await store.create("u");
    const b = await store.create("u");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
