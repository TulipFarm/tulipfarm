import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertRecoveryTargets,
  assertRestoreEquivalent,
  isRollingWorkerCompatible,
  RECOVERY_PROFILE,
  REQUIRED_BACKUP_COMPONENTS,
  type RecoveryEvidence,
} from "../ops/resilience/contract";

const ROOT = resolve(import.meta.dirname, "..");

function evidence(overrides: Partial<RecoveryEvidence> = {}): RecoveryEvidence {
  return {
    postgresLsn: "0/16B6C50",
    soulHead: "abc123",
    blobDigest: "sha256:blob",
    keyMetadataDigest: "sha256:key-metadata",
    waitingRuns: 2,
    ambiguousEffects: 1,
    auditTailHash: "sha256:audit-tail",
    ...overrides,
  };
}

describe("backup and restore contract", () => {
  it("covers every authoritative backup component", () => {
    expect(REQUIRED_BACKUP_COMPONENTS).toEqual(["postgres", "blob", "soul", "key_metadata"]);
  });

  it("rejects a restore that loses waiting, ambiguous, or audit state", () => {
    expect(() => assertRestoreEquivalent(evidence(), evidence())).not.toThrow();
    expect(() => assertRestoreEquivalent(evidence(), evidence({ waitingRuns: 1 }))).toThrowError(
      "restore evidence mismatch: waitingRuns"
    );
    expect(() =>
      assertRestoreEquivalent(evidence(), evidence({ ambiguousEffects: 0 }))
    ).toThrowError("restore evidence mismatch: ambiguousEffects");
    expect(() =>
      assertRestoreEquivalent(evidence(), evidence({ auditTailHash: "sha256:fork" }))
    ).toThrowError("restore evidence mismatch: auditTailHash");
  });

  it("enforces the documented reference RPO and RTO", () => {
    expect(RECOVERY_PROFILE).toEqual({ rpoMs: 300_000, rtoMs: 3_600_000 });
    expect(() =>
      assertRecoveryTargets({
        incidentAt: new Date("2026-07-26T10:05:00.000Z"),
        backupAt: new Date("2026-07-26T10:00:00.000Z"),
        recoveryStartedAt: new Date("2026-07-26T10:05:00.000Z"),
        recoveryCompletedAt: new Date("2026-07-26T11:05:00.000Z"),
      })
    ).not.toThrow();
    expect(() =>
      assertRecoveryTargets({
        incidentAt: new Date("2026-07-26T10:05:01.000Z"),
        backupAt: new Date("2026-07-26T10:00:00.000Z"),
        recoveryStartedAt: new Date("2026-07-26T10:05:00.000Z"),
        recoveryCompletedAt: new Date("2026-07-26T11:05:01.000Z"),
      })
    ).toThrow();
  });

  it("allows current/previous schema workers and rejects incompatible rolling binaries", () => {
    expect(isRollingWorkerCompatible({ databaseVersion: 11, workerVersion: 11 })).toBe(true);
    expect(isRollingWorkerCompatible({ databaseVersion: 11, workerVersion: 10 })).toBe(true);
    expect(isRollingWorkerCompatible({ databaseVersion: 11, workerVersion: 9 })).toBe(false);
    expect(isRollingWorkerCompatible({ databaseVersion: 11, workerVersion: 12 })).toBe(false);
  });

  it("ships guarded backup, restore, and drill entrypoints", () => {
    for (const path of [
      "ops/resilience/backup.sh",
      "ops/resilience/restore.sh",
      "ops/resilience/drill.sh",
    ]) {
      expect(existsSync(resolve(ROOT, path)), path).toBe(true);
    }
    const restore = readFileSync(resolve(ROOT, "ops/resilience/restore.sh"), "utf8");
    expect(restore).toContain('--confirm "RESTORE"');
    expect(restore).not.toContain("reset:dev");
  });
});
