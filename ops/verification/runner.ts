import { cpus, platform, totalmem } from "node:os";
import {
  PHASE_14_SIGNAL_ORDER,
  type Phase14SignalId,
  type Phase14VerificationRecord,
  type VerificationComponents,
  type VerificationHardware,
} from "./phase14.ts";

export interface VerificationCommandPlan {
  readonly id: Phase14SignalId;
  /** Executable followed by arguments. Commands never run through a shell. */
  readonly command: readonly string[];
}

export interface Phase14VerificationPlan {
  readonly runId: string;
  readonly repository: {
    readonly commitSha: string;
    readonly treeSha: string;
  };
  readonly components: VerificationComponents;
  readonly commands: readonly VerificationCommandPlan[];
}

export interface CommandExecutionEvidence {
  readonly exitCode: number;
  readonly outputSha256: string;
  readonly evidenceRef: string;
}

export interface Phase14RunnerDependencies {
  execute(command: VerificationCommandPlan): Promise<CommandExecutionEvidence>;
  now?: () => Date;
  hardware?: () => VerificationHardware;
}

export class VerificationRunnerError extends Error {
  readonly name = "VerificationRunnerError";
  readonly code: "command_plan_invalid";
  readonly detail: string;

  constructor(code: "command_plan_invalid", detail: string) {
    super(`${code}:${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertValidPhase14RunId(runId: string): void {
  if (!RUN_ID.test(runId)) {
    throw new VerificationRunnerError("command_plan_invalid", "run_id");
  }
}

function systemHardware(): VerificationHardware {
  return {
    platform: `${platform()}-${process.arch}`,
    cpuModel: cpus()[0]?.model ?? "unknown",
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
  };
}

function validateCommands(commands: readonly VerificationCommandPlan[]): void {
  if (
    commands.length !== PHASE_14_SIGNAL_ORDER.length ||
    commands.some((command, index) => command.id !== PHASE_14_SIGNAL_ORDER[index])
  ) {
    throw new VerificationRunnerError("command_plan_invalid", "required_order");
  }
  for (const command of commands) {
    if (command.command.length === 0 || command.command.some((part) => part.length === 0)) {
      throw new VerificationRunnerError("command_plan_invalid", `${command.id}:empty_command`);
    }
  }
}

/** Execute every required signal in order and derive its status exclusively from the exit code. */
export async function runPhase14Verification(
  plan: Phase14VerificationPlan,
  dependencies: Phase14RunnerDependencies
): Promise<Phase14VerificationRecord> {
  assertValidPhase14RunId(plan.runId);
  validateCommands(plan.commands);
  const now = dependencies.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const signals = [];

  for (const command of plan.commands) {
    const startedAt = now().toISOString();
    const evidence = await dependencies.execute(command);
    const completedAt = now().toISOString();
    signals.push({
      id: command.id,
      status: evidence.exitCode === 0 ? ("passed" as const) : ("failed" as const),
      command: command.command,
      startedAt,
      completedAt,
      exitCode: evidence.exitCode,
      outputSha256: evidence.outputSha256,
      evidenceRef: evidence.evidenceRef,
    });
  }

  return {
    schemaVersion: 1,
    runId: plan.runId,
    generatedAt,
    repository: plan.repository,
    components: plan.components,
    hardware: dependencies.hardware?.() ?? systemHardware(),
    signals,
  };
}
