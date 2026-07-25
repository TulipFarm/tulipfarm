import { describe, expect, it } from "vitest";
import type { PutArtifactInput } from "./artifact-store";
import { MemoryArtifactStore } from "./memory-artifact-store";

const CREATED_AT = "2026-07-24T10:00:00.000Z";

function artifact(overrides: Partial<PutArtifactInput> = {}): PutArtifactInput {
  return {
    id: "artifact-1",
    businessId: "business-1",
    schemaRef: "classify/output/v1",
    content: { label: "billing" },
    blob: null,
    contentHash: "hash-1",
    classification: ["internal"],
    acl: { readers: ["agent:agent-1"] },
    retention: { policy: "standard", expiresAt: null },
    redaction: { redactedPaths: [] },
    producer: { runId: "run-1", stateKey: "classify", attempt: 1 },
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe("MemoryArtifactStore", () => {
  it("rejects a replay that changes immutable metadata", async () => {
    const store = new MemoryArtifactStore();
    await store.put(artifact());

    await expect(
      store.put(artifact({ acl: { readers: ["agent:agent-2"] } }))
    ).rejects.toMatchObject({ code: "artifact_conflict" });
  });

  it("snapshots nested input and returned records", async () => {
    const store = new MemoryArtifactStore();
    const retention: { policy: "standard"; expiresAt: string | null } = {
      policy: "standard",
      expiresAt: null,
    };
    const producer = { runId: "run-1", stateKey: "classify", attempt: 1 };
    await store.put(artifact({ retention, producer }));

    retention.expiresAt = "2026-07-24T10:01:00.000Z";
    producer.attempt = 2;
    const first = await store.find("business-1", "artifact-1");
    if (!first) throw new Error("expected stored Artifact");
    const readers = first.acl.readers as string[];
    readers.splice(0, 1);

    await expect(store.find("business-1", "artifact-1")).resolves.toMatchObject({
      acl: { readers: ["agent:agent-1"] },
      retention: { expiresAt: null },
      producer: { attempt: 1 },
    });
  });

  it("rejects output and lineage references to missing or self-referential Artifacts", async () => {
    const store = new MemoryArtifactStore();
    await store.put(artifact());

    await expect(
      store.bindOutput({
        businessId: "business-1",
        runId: "run-1",
        stateKey: "classify",
        outputName: "result",
        artifactId: "missing",
        createdAt: CREATED_AT,
      })
    ).rejects.toMatchObject({ code: "artifact_reference_invalid" });
    await expect(
      store.appendLineage({
        businessId: "business-1",
        artifactId: "artifact-1",
        sourceArtifactId: "artifact-1",
        relation: "derived_from",
        createdAt: CREATED_AT,
      })
    ).rejects.toMatchObject({ code: "artifact_reference_invalid" });
  });
});
