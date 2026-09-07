import { DISPATCH_LEASE_EXPIRED_REF, type PersistedRun, type RunStore } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { createRunReader } from "./run-reader";

const run: PersistedRun = {
  id: "00000000-0000-4000-8000-000000000001",
  businessId: "business-1",
  source: "routine",
  bundle: { digest: "sha256:bundle-1", routineId: "routine-1", routineVersion: "1" },
  identity: {
    initiator: { kind: "user", id: "user-1" },
    effectiveSubject: { kind: "agent", id: "agent-1" },
    guardrailContextRef: "guardrail-context-1",
  },
  status: "needs_reconciliation",
  version: 3,
  createdAt: "2026-09-01T00:00:00.000Z",
  startedAt: "2026-09-01T00:00:01.000Z",
  finishedAt: null,
  resultArtifactId: null,
  errorEvidenceRef: DISPATCH_LEASE_EXPIRED_REF,
  leaseOwner: null,
  leaseExpiresAt: null,
};

describe("RunReader", () => {
  it("exposes durable recovery commands and immutable effect outcomes", async () => {
    const runs = {
      find: async () => run,
      listStates: async () => [],
      countStateAttempts: async () => new Map(),
      listLineage: async () => [],
    } as unknown as RunStore;
    const reader = createRunReader(runs, { usage: async () => [] }, undefined, {
      list: async () => [
        {
          effectId: "00000000-0000-4000-8000-000000000002",
          businessId: "business-1",
          runId: run.id,
          stateId: "send",
          logicalEffectOrdinal: 0,
          idempotencyKey: "send-1",
          intentDigest: "a".repeat(64),
          intent: {} as never,
          guardrailRevision: "guardrail-1",
          state: "confirmed",
          createdAt: "2026-09-01T00:00:02.000Z",
          updatedAt: "2026-09-01T00:00:03.000Z",
        },
      ],
    });

    await expect(reader.get("business-1", run.id)).resolves.toMatchObject({
      availableCommands: ["cancel", "reconcile"],
      effects: [
        {
          stateId: "send",
          state: "confirmed",
        },
      ],
    });
  });
});
