import { MCP_TOOL_ERROR_REASONS } from "@tulipfarm/integrations";
import {
  DISPATCH_LEASE_EXPIRED_REF,
  type PersistedRun,
  type PersistedState,
  type RunStore,
} from "@tulipfarm/storage";
import { MemoryEffectStore } from "@tulipfarm/tool-broker";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerOperationalRoutes } from "./routes";
import { createRunReader } from "./run-reader";
import { createRuntimeOperationalApi } from "./runtime";

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
  leaseGeneration: 1,
};

describe("RunReader", () => {
  it.each(Object.entries(MCP_TOOL_ERROR_REASONS))(
    "derives a fixed explanation from the stored safe code %s",
    async (errorCode, reason) => {
      const effects = new MemoryEffectStore();
      const effectId = "00000000-0000-4000-8000-000000000002";
      await effects.reserve({
        effectId,
        businessId: run.businessId,
        runId: run.id,
        stateId: "chat:call-1",
        logicalEffectOrdinal: 0,
        idempotencyKey: "safe-reason",
        intentDigest: "a".repeat(64),
        intent: { arguments: { credential: "private-arguments" }, targetRefs: [] } as never,
        guardrailRevision: "guardrail-1",
        createdAt: run.createdAt,
      });
      await effects.beginAttempt(run.businessId, effectId, run.createdAt);
      await effects.finishAttempt({
        businessId: run.businessId,
        effectId,
        attempt: 1,
        attemptState: "ambiguous",
        effectState: "ambiguous",
        errorCode,
        finishedAt: run.createdAt,
      });
      const reader = createRunReader(
        {
          find: async () => run,
          list: async () => ({ items: [run], nextCursor: null }),
          listStates: async () => [],
          countStateAttempts: async () => new Map(),
          listLineage: async () => [],
        },
        { usage: async () => [] },
        undefined,
        effects
      );
      const projected = await reader.get(run.businessId, run.id);
      expect(projected?.effects[0]?.latestAttempt).toEqual({
        state: "ambiguous",
        errorCode,
        reason,
        startedAt: run.createdAt,
        finishedAt: run.createdAt,
      });
      expect(JSON.stringify(projected?.effects)).not.toContain("private");
    }
  );

  it.each(["mcp_tool_failed", "Bearer private-credential", "private_secret_value"])(
    "projects only the latest safe effect attempt (%s)",
    async (errorCode) => {
      const effects = new MemoryEffectStore();
      const effectId = "00000000-0000-4000-8000-000000000002";
      await effects.reserve({
        effectId,
        businessId: run.businessId,
        runId: run.id,
        stateId: "chat:call-1",
        logicalEffectOrdinal: 0,
        idempotencyKey: "call-1",
        intentDigest: "a".repeat(64),
        intent: { arguments: { credential: "private-arguments" }, targetRefs: [] } as never,
        guardrailRevision: "guardrail-1",
        createdAt: run.createdAt,
      });
      await effects.beginAttempt(run.businessId, effectId, "2026-09-01T00:00:01.000Z");
      await effects.finishAttempt({
        businessId: run.businessId,
        effectId,
        attempt: 1,
        attemptState: "failed",
        effectState: "authorized",
        errorCode: "earlier-error",
        finishedAt: "2026-09-01T00:00:02.000Z",
      });
      await effects.beginAttempt(run.businessId, effectId, "2026-09-01T00:00:03.000Z");
      await effects.finishAttempt({
        businessId: run.businessId,
        effectId,
        attempt: 2,
        attemptState: "ambiguous",
        effectState: "ambiguous",
        errorCode,
        providerRequestId: "private-provider-request",
        output: { value: "private-result" },
        finishedAt: "2026-09-01T00:00:04.000Z",
      });
      const reader = createRunReader(
        {
          find: async () => run,
          list: async () => ({ items: [run], nextCursor: null }),
          listStates: async () => [],
          countStateAttempts: async () => new Map(),
          listLineage: async () => [],
        },
        { usage: async () => [] },
        undefined,
        effects
      );
      let role: "admin" | "member" = "admin";
      const app = Fastify();
      registerOperationalRoutes(
        app,
        createRuntimeOperationalApi({
          runs: reader,
          activity: { list: async () => ({ items: [], nextCursor: null }) },
          approvals: { findById: async () => null, listPending: async () => [] },
          healthProbes: [],
          guardrailsConfig: () => ({}),
        }),
        async (request) => {
          request.principal = {
            id: "user-1",
            kind: "user",
            businessId: run.businessId,
            credential: "session",
            authMethods: ["password"],
            authenticatedAt: new Date(run.createdAt),
            userId: "user-1",
            role,
          };
        }
      );
      try {
        const response = await app.inject(`/api/v1/runs/${run.id}`);
        expect(response.statusCode).toBe(200);
        expect(response.json().run.effects).toEqual([
          {
            effectId,
            stateId: "chat:call-1",
            state: "ambiguous",
            updatedAt: "2026-09-01T00:00:04.000Z",
            latestAttempt: {
              state: "ambiguous",
              errorCode: errorCode === "mcp_tool_failed" ? errorCode : "unclassified_error",
              startedAt: "2026-09-01T00:00:03.000Z",
              finishedAt: "2026-09-01T00:00:04.000Z",
            },
          },
        ]);
        expect(response.body).not.toContain("private");
        expect((await app.inject("/api/v1/runs")).json().items[0].effects).toEqual([]);
        role = "member";
        const denied = await app.inject(`/api/v1/runs/${run.id}`);
        expect(denied.statusCode).toBe(403);
        expect(denied.body).not.toContain("latestAttempt");
      } finally {
        await app.close();
      }
    }
  );

  it.each([
    { output: { summary: "Saved two Records" }, artifactId: null },
    { output: "Completed the review", artifactId: "artifact-1" },
    { output: 0, artifactId: null },
    { output: false, artifactId: null },
    { output: "", artifactId: null },
    { output: null, artifactId: "artifact-1" },
  ])(
    "preserves persisted output $output apart from Artifact references",
    async ({ output, artifactId }) => {
      const state: PersistedState = {
        businessId: run.businessId,
        runId: run.id,
        key: "review",
        definitionRef: "routine:review",
        resolvedInput: {},
        status: "succeeded",
        version: 2,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        finishedAt: "2026-09-01T00:00:02.000Z",
        resultArtifactId: artifactId,
        errorEvidenceRef: null,
        output,
      };
      const reader = createRunReader(
        {
          find: async () => run,
          list: async () => ({ items: [], nextCursor: null }),
          listStates: async () => [state],
          countStateAttempts: async () => new Map(),
          listLineage: async () => [],
        },
        { usage: async () => [] }
      );
      const result = (await reader.get(run.businessId, run.id))?.states[0];
      if (output === null) {
        expect(result).not.toHaveProperty("output");
      } else {
        expect(result?.output).toEqual(output);
      }
      if (artifactId === null) {
        expect(result).not.toHaveProperty("resultArtifactId");
      } else {
        expect(result).toHaveProperty("resultArtifactId", artifactId);
      }
    }
  );

  it("exposes durable recovery commands and immutable effect outcomes", async () => {
    const runs = {
      find: async () => run,
      listStates: async () => [],
      countStateAttempts: async () => new Map(),
      listLineage: async () => [],
    } as unknown as RunStore;
    const reader = createRunReader(runs, { usage: async () => [] }, undefined, {
      listAttempts: async () => [],
      listByRun: async () => [
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
          outputStored: true,
          output: null,
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
