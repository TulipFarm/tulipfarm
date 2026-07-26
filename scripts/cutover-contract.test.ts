import { describe, expect, it, vi } from "vitest";
import {
  CutoverCoordinator,
  CutoverError,
  type CutoverPlan,
  REQUIRED_CUTOVER_SURFACES,
} from "../ops/cutover/contract";

function plan(overrides: Partial<CutoverPlan> = {}): CutoverPlan {
  return {
    id: "cutover-2026-07-26",
    targetDigest: "sha256:target",
    routes: Object.fromEntries(
      REQUIRED_CUTOVER_SURFACES.map((surface) => [
        surface,
        { createsRun: true, externalMutations: "tool_broker" },
      ])
    ) as CutoverPlan["routes"],
    components: {
      api: "sha256:api",
      worker: "sha256:worker",
      integrationWorker: "sha256:integration-worker",
    },
    ...overrides,
  };
}

function harness() {
  const calls: string[] = [];
  const dependencies = {
    backup: {
      verify: vi.fn(async () => {
        calls.push("backup");
        return { archiveId: "backup-1", verifiedAt: "2026-07-26T10:00:00.000Z" };
      }),
    },
    conversion: {
      convert: vi.fn(() => ({
        files: [{ operation: "upsert" as const, path: "agents/a/agent.yaml", content: "valid" }],
        warnings: [],
      })),
    },
    proposals: {
      submit: vi.fn(async () => {
        calls.push("proposal");
        return { proposalId: "proposal-1" };
      }),
      approve: vi.fn(async () => {
        calls.push("approve");
      }),
    },
    routing: {
      preview: vi.fn(async () => {
        calls.push("preview");
      }),
      verifyRollback: vi.fn(async () => {
        calls.push("rollback-verified");
      }),
      activate: vi.fn(async () => {
        calls.push("activate");
      }),
      rollback: vi.fn(async () => {
        calls.push("rollback");
      }),
    },
    smoke: {
      run: vi.fn(async () => {
        calls.push("smoke");
        return {
          surfaces: [...REQUIRED_CUTOVER_SURFACES],
          deniedAccess: true,
          allMutationsHaveEffects: true,
        };
      }),
    },
    audit: { record: vi.fn(async () => undefined) },
  };
  return { calls, coordinator: new CutoverCoordinator(dependencies), dependencies };
}

describe("Phase 14 cutover contract", () => {
  it("backs up, proposes converted Soul, verifies rollback, then activates and smokes", async () => {
    const { calls, coordinator, dependencies } = harness();
    const result = await coordinator.execute({
      plan: plan(),
      legacySoul: { agents: [], skills: [] },
      approvedBy: "operator-1",
    });

    expect(result).toMatchObject({
      status: "active",
      backupId: "backup-1",
      proposalId: "proposal-1",
    });
    expect(calls).toEqual([
      "backup",
      "proposal",
      "approve",
      "preview",
      "rollback-verified",
      "activate",
      "smoke",
    ]);
    expect(dependencies.proposals.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "migration",
        files: expect.any(Array),
      })
    );
  });

  it("refuses activation when any traffic surface bypasses Runs or effect evidence", async () => {
    const { coordinator, dependencies } = harness();
    const unsafe = plan({
      routes: {
        ...plan().routes,
        chat: { createsRun: false, externalMutations: "direct" },
      },
    });

    await expect(
      coordinator.execute({
        plan: unsafe,
        legacySoul: {},
        approvedBy: "operator-1",
      })
    ).rejects.toEqual(new CutoverError("unsafe_route_plan", "chat"));
    expect(dependencies.routing.activate).not.toHaveBeenCalled();
  });

  it("rolls routing back without resetting data when post-activation smoke fails", async () => {
    const { calls, coordinator, dependencies } = harness();
    dependencies.smoke.run.mockResolvedValue({
      surfaces: ["chat"],
      deniedAccess: false,
      allMutationsHaveEffects: false,
    });

    await expect(
      coordinator.execute({
        plan: plan(),
        legacySoul: {},
        approvedBy: "operator-1",
      })
    ).rejects.toEqual(new CutoverError("smoke_failed", "cutover-2026-07-26"));
    expect(calls.at(-1)).toBe("rollback");
  });
});
