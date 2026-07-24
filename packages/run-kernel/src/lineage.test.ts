import { MemoryArtifactStore } from "@tulipfarm/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { ArtifactService, type PublishArtifactInput } from "./artifacts";
import { RunOutputLineage } from "./lineage";
import { TypedOutputValidator } from "./outputs";

const CREATED_AT = "2026-07-24T10:00:00.000Z";
const NOW = new Date("2026-07-24T10:05:00.000Z");
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const SCHEMA_REF = "classify/output/v1";

const CLASSIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["label"],
  properties: { label: { type: "string" } },
};

function publishInput(overrides: Partial<PublishArtifactInput> = {}): PublishArtifactInput {
  return {
    id: "artifact-1",
    businessId: "business-1",
    schemaRef: SCHEMA_REF,
    value: { label: "billing" },
    storage: "inline",
    classification: ["internal"],
    acl: { readers: ["agent:agent-1"] },
    retention: { policy: "standard", expiresAt: null },
    redaction: { redactedPaths: [] },
    producer: { runId: RUN_ID, stateKey: "classify", attempt: 1 },
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function contextRequest(overrides: Record<string, unknown> = {}) {
  return {
    businessId: "business-1",
    runId: RUN_ID,
    reader: "agent:agent-1",
    allowedClassifications: ["internal"],
    now: NOW,
    inputs: [{ name: "classification", from: { stateKey: "classify", outputName: "result" } }],
    ...overrides,
  };
}

describe("RunOutputLineage", () => {
  let store: MemoryArtifactStore;
  let lineage: RunOutputLineage;

  beforeEach(async () => {
    store = new MemoryArtifactStore();
    const service = new ArtifactService(
      store,
      new TypedOutputValidator([{ ref: SCHEMA_REF, schema: CLASSIFY_SCHEMA }])
    );
    lineage = new RunOutputLineage(store, service);
    await service.publish(publishInput());
  });

  async function bindResult(artifactId = "artifact-1"): Promise<void> {
    await lineage.bind({
      businessId: "business-1",
      runId: RUN_ID,
      stateKey: "classify",
      outputName: "result",
      artifactId,
      createdAt: CREATED_AT,
    });
  }

  it("resolves named State outputs into validated downstream Context", async () => {
    await bindResult();

    await expect(lineage.assembleContext(contextRequest())).resolves.toEqual({
      classification: { label: "billing" },
    });
  });

  it("keeps a rebind of the same named output idempotent across retries", async () => {
    await bindResult();
    await bindResult();

    await expect(lineage.assembleContext(contextRequest())).resolves.toEqual({
      classification: { label: "billing" },
    });
  });

  it("refuses to rebind a named output to a different Artifact", async () => {
    await bindResult();

    await expect(bindResult("artifact-other")).rejects.toThrow();
  });

  it("fails closed when a declared named output was never produced", async () => {
    await expect(lineage.assembleContext(contextRequest())).rejects.toMatchObject({
      code: "artifact_not_found",
    });
  });

  it("keeps unauthorized output out of downstream Context", async () => {
    await bindResult();

    await expect(
      lineage.assembleContext(contextRequest({ reader: "agent:agent-2" }))
    ).rejects.toMatchObject({ code: "artifact_unauthorized" });
  });

  it("keeps output above the Context classification ceiling out of downstream Context", async () => {
    await bindResult();

    await expect(
      lineage.assembleContext(contextRequest({ allowedClassifications: ["public"] }))
    ).rejects.toMatchObject({ code: "artifact_classification_denied" });
  });

  it("does not resolve a named output belonging to another Run", async () => {
    await bindResult();

    await expect(
      lineage.assembleContext(contextRequest({ runId: "00000000-0000-4000-8000-000000000002" }))
    ).rejects.toMatchObject({ code: "artifact_not_found" });
  });

  it("traces the Artifact lineage recorded for a Run output", async () => {
    await bindResult();

    expect(await lineage.trace("business-1", RUN_ID)).toEqual([
      {
        businessId: "business-1",
        runId: RUN_ID,
        stateKey: "classify",
        outputName: "result",
        artifactId: "artifact-1",
        createdAt: CREATED_AT,
      },
    ]);
  });
});
