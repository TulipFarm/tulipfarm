export const PHASE_14_SIGNAL_ORDER = [
  "test",
  "lint",
  "typecheck",
  "build",
  "compose",
  "chat",
  "webhook",
  "schedule",
  "effect",
  "acl-deny",
  "restore",
] as const;

export type Phase14SignalId = (typeof PHASE_14_SIGNAL_ORDER)[number];

export interface VerificationSignal {
  readonly id: Phase14SignalId;
  readonly status: "passed" | "failed";
  readonly command: readonly string[];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly exitCode: number;
  readonly outputSha256: string;
  readonly evidenceRef: string;
}

export interface VerificationComponents {
  readonly api: string;
  readonly worker: string;
  readonly integrationWorker: string;
}

export interface VerificationHardware {
  readonly platform: string;
  readonly cpuModel: string;
  readonly logicalCpus: number;
  readonly totalMemoryBytes: number;
}

export interface Phase14VerificationRecord {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly generatedAt: string;
  readonly repository: {
    readonly commitSha: string;
    readonly treeSha: string;
  };
  readonly components: VerificationComponents;
  readonly hardware: VerificationHardware;
  readonly signals: readonly VerificationSignal[];
}

export interface ExpectedVerificationSource {
  readonly commitSha: string;
  readonly treeSha: string;
  readonly components: VerificationComponents;
  readonly commands: readonly {
    readonly id: Phase14SignalId;
    readonly command: readonly string[];
  }[];
}

export type VerificationRecordErrorCode =
  | "command_mismatch"
  | "component_mismatch"
  | "record_invalid"
  | "repository_mismatch"
  | "signal_evidence_invalid"
  | "signal_failed"
  | "signal_order_invalid";

export class VerificationRecordError extends Error {
  readonly name = "VerificationRecordError";
  readonly code: VerificationRecordErrorCode;
  readonly detail: string;

  constructor(code: VerificationRecordErrorCode, detail: string) {
    super(`${code}:${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

const GIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMPONENT_DIGEST = /^sha256:[a-f0-9]{64}$/;

function isTimestamp(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

function validateRecordShape(record: Phase14VerificationRecord): void {
  if (
    record.schemaVersion !== 1 ||
    record.runId.length === 0 ||
    !isTimestamp(record.generatedAt) ||
    !GIT_SHA.test(record.repository.commitSha) ||
    !GIT_SHA.test(record.repository.treeSha) ||
    record.hardware.platform.length === 0 ||
    record.hardware.cpuModel.length === 0 ||
    !Number.isInteger(record.hardware.logicalCpus) ||
    record.hardware.logicalCpus <= 0 ||
    !Number.isFinite(record.hardware.totalMemoryBytes) ||
    record.hardware.totalMemoryBytes <= 0
  ) {
    throw new VerificationRecordError("record_invalid", "metadata");
  }
  for (const [name, digest] of Object.entries(record.components)) {
    if (!COMPONENT_DIGEST.test(digest)) {
      throw new VerificationRecordError("record_invalid", `component:${name}`);
    }
  }
}

function validateSignalOrder(signals: readonly VerificationSignal[]): void {
  if (
    signals.length !== PHASE_14_SIGNAL_ORDER.length ||
    signals.some((signal, index) => signal.id !== PHASE_14_SIGNAL_ORDER[index])
  ) {
    throw new VerificationRecordError("signal_order_invalid", "required_order");
  }
}

function validateSignalEvidence(signal: VerificationSignal): void {
  const startedAt = Date.parse(signal.startedAt);
  const completedAt = Date.parse(signal.completedAt);
  if (
    signal.command.length === 0 ||
    signal.command.some((part) => part.length === 0) ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt) ||
    completedAt < startedAt ||
    !Number.isInteger(signal.exitCode) ||
    !SHA256.test(signal.outputSha256) ||
    signal.evidenceRef.length === 0
  ) {
    throw new VerificationRecordError("signal_evidence_invalid", signal.id);
  }
  if (signal.status !== (signal.exitCode === 0 ? "passed" : "failed")) {
    throw new VerificationRecordError("signal_evidence_invalid", `${signal.id}:status`);
  }
}

/**
 * Fail-closed Phase 14 release gate.
 *
 * A checked-in `"passed"` constant is not evidence. The caller supplies a record produced by the
 * command runner plus the independently resolved commit, tree, and component digests expected for
 * cutover. Missing, stale, malformed, reordered, or failed evidence is rejected.
 */
export function verifyPhase14Record(
  record: Phase14VerificationRecord,
  expected: ExpectedVerificationSource
): Phase14VerificationRecord {
  validateRecordShape(record);
  if (
    record.repository.commitSha !== expected.commitSha ||
    record.repository.treeSha !== expected.treeSha
  ) {
    throw new VerificationRecordError("repository_mismatch", "commit_or_tree");
  }
  for (const name of ["api", "worker", "integrationWorker"] as const) {
    if (record.components[name] !== expected.components[name]) {
      throw new VerificationRecordError("component_mismatch", name);
    }
  }
  validateSignalOrder(record.signals);
  if (
    expected.commands.length !== PHASE_14_SIGNAL_ORDER.length ||
    expected.commands.some(
      (command, index) =>
        command.id !== PHASE_14_SIGNAL_ORDER[index] ||
        command.command.length === 0 ||
        command.command.some((part) => part.length === 0)
    )
  ) {
    throw new VerificationRecordError("record_invalid", "expected_commands");
  }
  for (const signal of record.signals) {
    validateSignalEvidence(signal);
    const expectedCommand = expected.commands.find((command) => command.id === signal.id);
    if (
      expectedCommand === undefined ||
      JSON.stringify(signal.command) !== JSON.stringify(expectedCommand.command)
    ) {
      throw new VerificationRecordError("command_mismatch", signal.id);
    }
    if (signal.status !== "passed") {
      throw new VerificationRecordError("signal_failed", signal.id);
    }
  }
  return record;
}
