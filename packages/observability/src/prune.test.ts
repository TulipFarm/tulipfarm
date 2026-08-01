import { describe, expect, it, vi } from "vitest";
import { PgObservabilityPruner } from "./prune";

describe("PgObservabilityPruner", () => {
  it("deletes events before the cutoff and returns the deleted count", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "one" }, { id: "two" }] }));
    const cutoff = new Date("2026-01-01T00:00:00.000Z");

    await expect(new PgObservabilityPruner({ query }).deleteOlderThan(cutoff)).resolves.toBe(2);
    expect(query).toHaveBeenCalledWith("DELETE FROM obs_event WHERE ts < $1 RETURNING id", [
      cutoff,
    ]);
  });
});
