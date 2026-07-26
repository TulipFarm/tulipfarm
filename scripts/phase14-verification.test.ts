import { describe, expect, it } from "vitest";
import {
  PHASE_14_SIGNAL_ORDER,
  type Phase14VerificationRecord,
  VerificationRecordError,
  verifyPhase14Record,
} from "../ops/verification/phase14";
import { runPhase14Verification, type VerificationCommandPlan } from "../ops/verification/runner";

const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const DIGEST = `sha256:${"c".repeat(64)}`;

function record(overrides: Partial<Phase14VerificationRecord> = {}): Phase14VerificationRecord {
  return {
    schemaVersion: 1,
    runId: "verification-2026-07-26",
    generatedAt: "2026-07-26T12:00:00.000Z",
    repository: { commitSha: COMMIT_SHA, treeSha: TREE_SHA },
    components: {
      api: DIGEST,
      worker: DIGEST,
      integrationWorker: DIGEST,
    },
    hardware: {
      platform: "darwin-arm64",
      cpuModel: "test",
      logicalCpus: 8,
      totalMemoryBytes: 16_000_000_000,
    },
    signals: PHASE_14_SIGNAL_ORDER.map((id, index) => ({
      id,
      status: "passed" as const,
      command: ["test-command", id],
      startedAt: `2026-07-26T12:${String(index).padStart(2, "0")}:00.000Z`,
      completedAt: `2026-07-26T12:${String(index).padStart(2, "0")}:01.000Z`,
      exitCode: 0,
      outputSha256: "d".repeat(64),
      evidenceRef: `.phase14-evidence/verification-2026-07-26/${id}.log`,
    })),
    ...overrides,
  };
}

const expected = {
  commitSha: COMMIT_SHA,
  treeSha: TREE_SHA,
  components: {
    api: DIGEST,
    worker: DIGEST,
    integrationWorker: DIGEST,
  },
  commands: PHASE_14_SIGNAL_ORDER.map((id) => ({
    id,
    command: ["test-command", id],
  })),
};

describe("Phase 14 final verification record", () => {
  it("accepts run-derived evidence bound to the exact source and components", () => {
    expect(verifyPhase14Record(record(), expected).signals.map((signal) => signal.id)).toEqual(
      PHASE_14_SIGNAL_ORDER
    );
  });

  it.each([
    ["stale commit", record({ repository: { commitSha: "e".repeat(40), treeSha: TREE_SHA } })],
    ["stale tree", record({ repository: { commitSha: COMMIT_SHA, treeSha: "e".repeat(40) } })],
    [
      "component mismatch",
      record({
        components: {
          api: `sha256:${"e".repeat(64)}`,
          worker: DIGEST,
          integrationWorker: DIGEST,
        },
      }),
    ],
  ])("rejects %s evidence", (_name, candidate) => {
    expect(() => verifyPhase14Record(candidate, expected)).toThrow(VerificationRecordError);
  });

  it("rejects a failed command rather than trusting its evidence text", () => {
    const candidate = record({
      signals: record().signals.map((signal) =>
        signal.id === "restore" ? { ...signal, status: "failed", exitCode: 1 } : signal
      ),
    });

    expect(() => verifyPhase14Record(candidate, expected)).toThrowError(
      expect.objectContaining({ code: "signal_failed" })
    );
  });

  it("rejects missing, reordered, or non-derived signal evidence", () => {
    const base = record();
    expect(() =>
      verifyPhase14Record({ ...base, signals: base.signals.slice(1) }, expected)
    ).toThrowError(expect.objectContaining({ code: "signal_order_invalid" }));
    expect(() =>
      verifyPhase14Record(
        {
          ...base,
          signals: base.signals.map((signal) =>
            signal.id === "chat" ? { ...signal, outputSha256: "" } : signal
          ),
        },
        expected
      )
    ).toThrowError(expect.objectContaining({ code: "signal_evidence_invalid" }));
  });

  it("rejects substituting a no-op for an approved acceptance command", () => {
    const base = record();
    const candidate = {
      ...base,
      signals: base.signals.map((signal) =>
        signal.id === "restore" ? { ...signal, command: ["/usr/bin/true"] } : signal
      ),
    };

    expect(() => verifyPhase14Record(candidate, expected)).toThrowError(
      expect.objectContaining({ code: "command_mismatch", detail: "restore" })
    );
  });
});

describe("runPhase14Verification", () => {
  it("executes every signal in order and derives status from the command exit", async () => {
    const commands = PHASE_14_SIGNAL_ORDER.map((id) => ({
      id,
      command: ["verify", id],
    })) satisfies readonly VerificationCommandPlan[];
    const calls: string[] = [];

    const result = await runPhase14Verification(
      {
        runId: "run-1",
        repository: { commitSha: COMMIT_SHA, treeSha: TREE_SHA },
        components: expected.components,
        commands,
      },
      {
        now: (() => {
          let second = 0;
          return () => new Date(1_800_000_000_000 + second++ * 1000);
        })(),
        hardware: () => ({
          platform: "test",
          cpuModel: "test",
          logicalCpus: 1,
          totalMemoryBytes: 1,
        }),
        execute: async (signal) => {
          calls.push(signal.id);
          return {
            exitCode: signal.id === "effect" ? 9 : 0,
            outputSha256: "f".repeat(64),
            evidenceRef: `.phase14-evidence/run-1/${signal.id}.log`,
          };
        },
      }
    );

    expect(calls).toEqual(PHASE_14_SIGNAL_ORDER);
    expect(result.signals.find((signal) => signal.id === "effect")).toMatchObject({
      status: "failed",
      exitCode: 9,
    });
    expect(() => verifyPhase14Record(result, { ...expected, commands })).toThrowError(
      expect.objectContaining({ code: "signal_failed" })
    );
  });

  it("refuses a command plan that omits or reorders a required signal", async () => {
    const commands = PHASE_14_SIGNAL_ORDER.slice(1).map((id) => ({
      id,
      command: ["verify", id],
    }));

    await expect(
      runPhase14Verification(
        {
          runId: "run-1",
          repository: { commitSha: COMMIT_SHA, treeSha: TREE_SHA },
          components: expected.components,
          commands,
        },
        {
          execute: async () => ({
            exitCode: 0,
            outputSha256: "f".repeat(64),
            evidenceRef: "evidence.log",
          }),
        }
      )
    ).rejects.toThrowError(expect.objectContaining({ code: "command_plan_invalid" }));
  });

  it("refuses a run ID that could escape the default evidence directory", async () => {
    await expect(
      runPhase14Verification(
        {
          runId: "../../outside",
          repository: { commitSha: COMMIT_SHA, treeSha: TREE_SHA },
          components: expected.components,
          commands: expected.commands,
        },
        {
          execute: async () => ({
            exitCode: 0,
            outputSha256: "f".repeat(64),
            evidenceRef: "evidence.log",
          }),
        }
      )
    ).rejects.toThrowError(
      expect.objectContaining({ code: "command_plan_invalid", detail: "run_id" })
    );
  });
});
