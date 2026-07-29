import { createSurfaceArtifact } from "@tulipfarm/surface";
import { describe, expect, it } from "vitest";
import { MemorySurfaceArtifactStore } from "./artifact-store";

describe("MemorySurfaceArtifactStore", () => {
  it("keeps immutable revisions and enforces optimistic updates", async () => {
    const store = new MemorySurfaceArtifactStore();
    const artifact = createSurfaceArtifact({
      id: "status",
      component: { name: "Status", version: "1.0" },
      props: { label: "Ready" },
      target: { channel: "web", surface: "chat" },
      audience: ["user:1"],
      classification: "internal",
    });
    await store.create(artifact);
    await expect(store.update("status", 1, { label: "Done" })).resolves.toMatchObject({
      revision: 2,
      props: { label: "Done" },
    });
    await expect(store.update("status", 1, { label: "Stale" })).rejects.toThrow(
      "Expected revision 1"
    );
  });
});
