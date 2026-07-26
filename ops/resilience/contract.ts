export const REQUIRED_BACKUP_COMPONENTS = ["postgres", "blob", "soul", "key_metadata"] as const;

export const RECOVERY_PROFILE = {
  rpoMs: 5 * 60 * 1000,
  rtoMs: 60 * 60 * 1000,
} as const;

export interface RecoveryEvidence {
  readonly postgresLsn: string;
  readonly soulHead: string;
  readonly blobDigest: string;
  readonly keyMetadataDigest: string;
  readonly waitingRuns: number;
  readonly ambiguousEffects: number;
  readonly auditTailHash: string;
}

export function assertRestoreEquivalent(before: RecoveryEvidence, after: RecoveryEvidence): void {
  for (const key of Object.keys(before) as Array<keyof RecoveryEvidence>) {
    if (before[key] !== after[key]) {
      throw new Error(`restore evidence mismatch: ${key}`);
    }
  }
}

export function assertRecoveryTargets(input: {
  readonly incidentAt: Date;
  readonly backupAt: Date;
  readonly recoveryStartedAt: Date;
  readonly recoveryCompletedAt: Date;
}): void {
  const rpoMs = input.incidentAt.getTime() - input.backupAt.getTime();
  const rtoMs = input.recoveryCompletedAt.getTime() - input.recoveryStartedAt.getTime();
  if (rpoMs < 0 || rpoMs > RECOVERY_PROFILE.rpoMs) {
    throw new Error(`recovery point exceeded reference profile: ${rpoMs}ms`);
  }
  if (rtoMs < 0 || rtoMs > RECOVERY_PROFILE.rtoMs) {
    throw new Error(`recovery time exceeded reference profile: ${rtoMs}ms`);
  }
}

/** Each migration supports the current and immediately previous worker schema. */
export function isRollingWorkerCompatible(input: {
  readonly databaseVersion: number;
  readonly workerVersion: number;
}): boolean {
  return (
    input.workerVersion <= input.databaseVersion && input.workerVersion >= input.databaseVersion - 1
  );
}
