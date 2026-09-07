import { createHash } from "node:crypto";
import {
  CancellationError,
  type RunCancellationManager,
  type RunRecoveryManager,
} from "@tulipfarm/run-kernel";
import type { AuditService } from "../audit/service";
import { OperationalCommandError, OperationalNotImplementedError } from "./routes";
import type { RunCommandInput } from "./types";

export interface RuntimeRunCommandServiceOptions {
  readonly cancellation: Pick<RunCancellationManager, "cancel">;
  readonly recovery: Pick<RunRecoveryManager, "reconcile">;
  readonly audit?: Pick<AuditService, "recordOrWarn">;
  readonly now?: () => Date;
}

export interface RunCommandResult {
  readonly commandId: string;
  readonly runId: string;
  readonly status: "accepted" | "duplicate";
}

function commandId(businessId: string, input: RunCommandInput): string {
  return createHash("sha256")
    .update(`${businessId}\0${input.runId}\0${input.action}\0${input.idempotencyKey}`)
    .digest("hex");
}

/** Executes source-neutral Run commands through the durable kernel managers. */
export class RuntimeRunCommandService {
  private readonly now: () => Date;

  constructor(private readonly options: RuntimeRunCommandServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async execute(
    businessId: string,
    input: RunCommandInput,
    actorId?: string
  ): Promise<RunCommandResult> {
    const result = {
      commandId: commandId(businessId, input),
      runId: input.runId,
    };
    if (input.action === "cancel") {
      try {
        await this.options.cancellation.cancel({
          businessId,
          runId: input.runId,
          expectedVersion: input.expectedVersion,
          reason: input.reason,
          inFlightEffects: {},
          now: this.now().toISOString(),
        });
        return this.accepted(input, result, actorId);
      } catch (error) {
        if (!(error instanceof CancellationError)) throw error;
        if (error.code === "run_not_found") {
          throw new OperationalCommandError(404, "run_not_found", "Run not found.");
        }
        if (error.code === "run_not_cancellable" && error.detail === "cancelled") {
          return { ...result, status: "duplicate" };
        }
        if (error.code === "run_not_cancellable") {
          throw new OperationalCommandError(
            409,
            "run_terminal",
            `The Run is already terminal with status ${error.detail}.`
          );
        }
        throw new OperationalCommandError(
          409,
          error.code,
          error.code === "cancellation_conflict"
            ? "The Run changed before it could be cancelled."
            : "The Run has unresolved effects that require reconciliation."
        );
      }
    }

    if (input.action === "reconcile") {
      const outcome = await this.options.recovery.reconcile({
        businessId,
        runId: input.runId,
        expectedVersion: input.expectedVersion,
      });
      if (outcome.outcome === "requeued") return this.accepted(input, result, actorId);
      if (outcome.outcome === "already_requeued") return { ...result, status: "duplicate" };
      if (outcome.outcome === "not_found") {
        throw new OperationalCommandError(404, "run_not_found", "Run not found.");
      }
      if (outcome.outcome === "version_conflict") {
        throw new OperationalCommandError(
          409,
          "run_version_conflict",
          "The Run changed before it could be reconciled."
        );
      }
      if (outcome.outcome === "terminal") {
        throw new OperationalCommandError(
          409,
          "run_terminal",
          `The Run is already terminal with status ${outcome.status}.`
        );
      }
      throw new OperationalCommandError(
        409,
        "reconciliation_evidence_required",
        "This Run needs provider evidence before it can be reconciled."
      );
    }

    throw new OperationalNotImplementedError(
      input.action === "pause"
        ? "Pause is not supported because Runs have no paused state."
        : input.action === "resume"
          ? "Resume is driven by durable waits and cannot be forced by a general Run command."
          : "Retry is source-specific; use the owning product surface to create a new attempt."
    );
  }

  private async accepted(
    input: RunCommandInput,
    result: { readonly commandId: string; readonly runId: string },
    actorId: string | undefined
  ): Promise<RunCommandResult> {
    await this.options.audit?.recordOrWarn({
      ...(actorId === undefined ? {} : { actorId }),
      action: `run.${input.action}`,
      target: `run:${input.runId}`,
      runId: input.runId,
      safeMetadata: {
        commandId: result.commandId,
        expectedVersion: input.expectedVersion,
        reasonDigest: createHash("sha256").update(JSON.stringify(input.reason)).digest("hex"),
      },
    });
    return { ...result, status: "accepted" };
  }
}
