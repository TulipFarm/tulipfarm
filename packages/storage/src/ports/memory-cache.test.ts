import { describe, expect, it } from "vitest";
import { MemoryCache } from "./memory-cache";

describe("MemoryCache", () => {
  it("returns what was stored", async () => {
    const cache = new MemoryCache();
    await cache.set("a", { hello: "world" }, 1_000);

    await expect(cache.get("a")).resolves.toEqual({ hello: "world" });
  });

  it("misses a key that was never stored", async () => {
    await expect(new MemoryCache().get("absent")).resolves.toBeUndefined();
  });

  it("stops answering once the entry has expired", async () => {
    let clock = 0;
    const cache = new MemoryCache({ now: () => clock });
    await cache.set("a", "value", 1_000);

    clock = 999;
    await expect(cache.get("a")).resolves.toBe("value");
    clock = 1_000;
    await expect(cache.get("a")).resolves.toBeUndefined();
  });

  it("refuses to store an entry that is already expired", async () => {
    const cache = new MemoryCache();
    await cache.set("a", "value", 0);

    await expect(cache.get("a")).resolves.toBeUndefined();
  });

  it("evicts the least recently used entry rather than the oldest written", async () => {
    const cache = new MemoryCache({ maxEntries: 2 });
    await cache.set("a", 1, 10_000);
    await cache.set("b", 2, 10_000);
    await cache.get("a");
    await cache.set("c", 3, 10_000);

    await expect(cache.get("a")).resolves.toBe(1);
    await expect(cache.get("b")).resolves.toBeUndefined();
    await expect(cache.get("c")).resolves.toBe(3);
  });

  it("never grows past its bound", async () => {
    const cache = new MemoryCache({ maxEntries: 3 });
    for (let index = 0; index < 50; index += 1) await cache.set(`k${index}`, index, 10_000);

    const present = await Promise.all(
      Array.from({ length: 50 }, (_value, index) => cache.get(`k${index}`))
    );
    expect(present.filter((value) => value !== undefined)).toHaveLength(3);
  });

  it("forgets a key on demand", async () => {
    const cache = new MemoryCache();
    await cache.set("a", "value", 10_000);
    await cache.delete("a");

    await expect(cache.get("a")).resolves.toBeUndefined();
  });
});
