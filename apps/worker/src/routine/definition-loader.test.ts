import {
  compileExecutionBundle,
  createHmacBundleSigner,
  InMemoryBundleStore,
  PinnedDefinitionLoader,
  signExecutionBundle,
} from "@tulipfarm/soul";
import type { PersistedRun } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { RoutineDefinitionLoadError, WorkerRoutineDefinitionLoader } from "./definition-loader";

const signer = createHmacBundleSigner("bundle-key", "test-secret");

function routine(lifecycle = "published") {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Routine",
    metadata: {
      id: "00000000-0000-4000-8000-000000000101",
      slug: "daily-digest",
      schemaVersion: 1,
      authoredVersion: 3,
      lifecycle,
    },
    spec: {
      owner: "agent:assistant",
      start: "Finish",
      states: [{ type: "branch", name: "Finish", conditions: [{ condition: "true", end: true }] }],
    },
  };
}

function run(override: Partial<PersistedRun> = {}): PersistedRun {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    businessId: "business-1",
    source: "routine",
    bundle: {
      digest: "bundle-digest",
      routineId: "00000000-0000-4000-8000-000000000101",
      routineVersion: "3",
    },
    identity: {
      initiator: { kind: "agent", id: "assistant" },
      effectiveSubject: { kind: "agent", id: "assistant" },
      guardrailContextRef: "guardrail:default",
    },
    bounds: {
      wallTimeMs: 60_000,
      activeTimeMs: 30_000,
      attempts: 3,
      sideEffects: 0,
    },
    status: "claimed",
    version: 1,
    createdAt: "2026-08-02T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    resultArtifactId: null,
    errorEvidenceRef: null,
    leaseOwner: "worker-1",
    leaseExpiresAt: "2026-08-02T00:01:00.000Z",
    ...override,
  };
}

async function loader(document = routine()) {
  const bundles = new InMemoryBundleStore();
  const record = signExecutionBundle(
    compileExecutionBundle({
      businessId: "business-1",
      changesetId: "changeset-1",
      commitSha: "commit-1",
      documents: [document],
    }),
    signer
  );
  await bundles.put(record);
  return {
    record,
    loader: new WorkerRoutineDefinitionLoader(new PinnedDefinitionLoader(bundles, signer)),
  };
}

describe("WorkerRoutineDefinitionLoader", () => {
  it("loads the immutable Routine named by the Run rather than an active alias", async () => {
    const { loader: definitions, record } = await loader();

    const loaded = await definitions.load(
      run({
        bundle: {
          digest: record.digest,
          routineId: "00000000-0000-4000-8000-000000000101",
          routineVersion: "3",
        },
      })
    );

    expect(loaded.bundle.digest).toBe(record.digest);
    expect(loaded.document.metadata.slug).toBe("daily-digest");
    expect(loaded.document.spec.start).toBe("Finish");
  });

  it("fails closed when the Run's exact bundle pin cannot be found", async () => {
    const { loader: definitions } = await loader();

    await expect(definitions.load(run())).rejects.toEqual(
      new RoutineDefinitionLoadError(
        "pinned_routine_unavailable",
        "00000000-0000-4000-8000-000000000001"
      )
    );
  });

  it("refuses a non-Routine Run", async () => {
    const { loader: definitions } = await loader();

    await expect(definitions.load(run({ source: "chat" }))).rejects.toMatchObject({
      code: "non_routine_run",
    });
  });

  it("refuses a non-published Routine even when its bundle is signed", async () => {
    const { loader: definitions, record } = await loader(routine("draft"));

    await expect(
      definitions.load(
        run({
          bundle: {
            digest: record.digest,
            routineId: "00000000-0000-4000-8000-000000000101",
            routineVersion: "3",
          },
        })
      )
    ).rejects.toMatchObject({ code: "unpublished_routine" });
  });
});
