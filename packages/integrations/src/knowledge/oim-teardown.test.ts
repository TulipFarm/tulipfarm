import { describe, expect, it } from "vitest";
import { teardownOimKnowledge } from "./oim-teardown";

describe("teardownOimKnowledge", () => {
  it("tombstones every source before removing durable scan state", async () => {
    const order: string[] = [];
    const result = await teardownOimKnowledge(
      {
        businessId: "business-1",
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
      },
      {
        publications: {
          async tombstoneConnection() {
            order.push("tombstone");
            return ["wiki:connection-1/page-1"];
          },
        },
        checkpoints: {
          async clearConnection() {
            order.push("checkpoint");
            return 2;
          },
        },
        now: () => new Date("2026-09-13T10:00:00.000Z"),
        newId: () => "cleanup-1",
      }
    );

    expect(order).toEqual(["tombstone", "checkpoint"]);
    expect(result).toEqual({ tombstonedSourceIds: ["wiki:connection-1/page-1"], checkpoints: 2 });
  });

  it("retains scan state when source tombstoning fails", async () => {
    let cleared = false;
    await expect(
      teardownOimKnowledge(
        {
          businessId: "business-1",
          integrationId: "wiki",
          integrationMajorVersion: 2,
          connectionId: "connection-1",
        },
        {
          publications: {
            async tombstoneConnection() {
              throw new Error("database unavailable");
            },
          },
          checkpoints: {
            async clearConnection() {
              cleared = true;
              return 0;
            },
          },
          now: () => new Date("2026-09-13T10:00:00.000Z"),
          newId: () => "cleanup-1",
        }
      )
    ).rejects.toMatchObject({
      name: "OimKnowledgeTeardownError",
      phase: "tombstone",
      retryable: true,
    });
    expect(cleared).toBe(false);
  });

  it("reports checkpoint cleanup as retryable after sources are already safe", async () => {
    await expect(
      teardownOimKnowledge(
        {
          businessId: "business-1",
          integrationId: "wiki",
          integrationMajorVersion: 2,
          connectionId: "connection-1",
        },
        {
          publications: {
            async tombstoneConnection() {
              return ["wiki:connection-1/page-1"];
            },
          },
          checkpoints: {
            async clearConnection() {
              throw new Error("database unavailable");
            },
          },
          now: () => new Date("2026-09-13T10:00:00.000Z"),
          newId: () => "cleanup-1",
        }
      )
    ).rejects.toEqual(
      expect.objectContaining({
        name: "OimKnowledgeTeardownError",
        phase: "checkpoint_cleanup",
        retryable: true,
      })
    );
  });
});
