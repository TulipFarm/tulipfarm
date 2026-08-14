import { KillSwitchDeniedError, type MutationGuard } from "@tulipfarm/observability";
import { ajv, canonicalHash } from "@tulipfarm/schema";
import type { ToolCatalog } from "../catalog";
import type { CredentialDispatcher } from "../credential-dispatch";
import type { ToolIntent } from "../intent";
import { mayRetry, retryDelayMs } from "./retry";
import type { EffectStore } from "./store";

export type DispatchPhase = "before_dispatch" | "after_dispatch";

export class AdapterDispatchError extends Error {
  constructor(
    readonly phase: DispatchPhase,
    readonly code: string,
    readonly retryable: boolean,
    readonly providerRequestId?: string
  ) {
    super(code);
    this.name = "AdapterDispatchError";
  }
}

export interface ToolAdapterRequest {
  readonly intent: ToolIntent;
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly timeoutMs?: number;
}

export interface ToolAdapter {
  dispatch(request: ToolAdapterRequest, credential?: string): Promise<unknown>;
}

export type ToolDispatchErrorCode =
  | "effect_not_found"
  | "contract_not_found"
  | "adapter_not_found"
  | "dispatch_failed"
  | "ambiguous"
  | "invalid_output"
  | "kill_switch_denied";

export class ToolDispatchError extends Error {
  constructor(
    readonly code: ToolDispatchErrorCode,
    readonly effectId: string,
    /** The underlying `AdapterDispatchError.code` that caused a `dispatch_failed`, when known —
     * callers use this to give a specific, actionable message instead of the opaque
     * `dispatch_failed:<effectId>` default. */
    readonly detail?: string
  ) {
    super(`${code}:${effectId}`);
    this.name = "ToolDispatchError";
  }
}

/** Identity a kill switch can scope on that the effect ledger itself does not record. */
export interface MutationIdentity {
  readonly agentId?: string;
  readonly routineId?: string;
  readonly integrationId?: string;
  readonly model?: string;
}

export interface EffectDispatcherDeps {
  readonly store: EffectStore;
  readonly catalog: ToolCatalog;
  readonly adapters: ReadonlyMap<string, ToolAdapter>;
  readonly credentialDispatcher?: CredentialDispatcher;
  readonly mutationGuard?: MutationGuard;
  /** Identity the effect ledger does not carry, supplied by whoever composed the dispatcher. */
  readonly mutationIdentity?: MutationIdentity;
  readonly wait?: (delayMs: number) => Promise<void>;
  readonly now?: () => string;
}

function classifyError(error: unknown, mutating: boolean): AdapterDispatchError {
  if (error instanceof AdapterDispatchError) return error;
  return new AdapterDispatchError(
    mutating ? "after_dispatch" : "before_dispatch",
    "adapter_error",
    false
  );
}

async function withTimeout(
  operation: Promise<unknown>,
  timeoutMs: number | undefined
): Promise<unknown> {
  if (timeoutMs === undefined || timeoutMs <= 0) return operation;
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new AdapterDispatchError("after_dispatch", "provider_timeout", true)),
        timeoutMs
      );
    }),
  ]);
}

export class EffectDispatcher {
  private readonly wait: (delayMs: number) => Promise<void>;
  private readonly now: () => string;

  constructor(private readonly deps: EffectDispatcherDeps) {
    this.wait = deps.wait ?? (() => Promise.resolve());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async dispatch(businessId: string, effectId: string): Promise<unknown> {
    const effect = await this.deps.store.get(businessId, effectId);
    if (effect === undefined) throw new ToolDispatchError("effect_not_found", effectId);
    const contract = this.deps.catalog.get(effect.intent.toolId, effect.intent.toolVersion);
    if (contract === undefined) throw new ToolDispatchError("contract_not_found", effectId);
    const adapter = this.deps.adapters.get(contract.adapter.ref);
    if (adapter === undefined) throw new ToolDispatchError("adapter_not_found", effectId);
    const validateOutput = ajv.compile(contract.outputSchema);

    if (this.deps.mutationGuard !== undefined) {
      try {
        await this.deps.mutationGuard.assertAllowed({
          businessId,
          mutation: contract.mutating,
          runId: effect.runId,
          stateId: effect.stateId,
          effectId,
          toolId: effect.intent.toolId,
          provider: contract.adapter.ref,
          destination: effect.intent.destination,
          dataClasses: contract.dataClasses,
          ...this.deps.mutationIdentity,
        });
      } catch (error) {
        // Any guard failure denies, but the operator still needs to know which switch stopped them.
        throw new ToolDispatchError(
          "kill_switch_denied",
          effectId,
          error instanceof KillSwitchDeniedError ? error.reasonCode : undefined
        );
      }
    }

    let attemptNumber = 0;
    while (true) {
      const attempt = await this.deps.store.beginAttempt(businessId, effectId, this.now());
      attemptNumber = attempt.attempt;
      try {
        const request = {
          intent: effect.intent,
          idempotencyKey: effect.idempotencyKey,
          attempt: attemptNumber,
          timeoutMs: contract.timeout?.wallClockMs,
        };
        const output = await withTimeout(
          this.deps.credentialDispatcher === undefined
            ? adapter.dispatch(request)
            : this.deps.credentialDispatcher.dispatch(effect, adapter, request),
          contract.timeout?.wallClockMs
        );
        if (!validateOutput(output)) {
          await this.deps.store.finishAttempt({
            businessId,
            effectId,
            attempt: attemptNumber,
            attemptState: "failed",
            effectState: "failed",
            errorCode: "invalid_output",
            finishedAt: this.now(),
          });
          throw new ToolDispatchError("invalid_output", effectId);
        }
        await this.deps.store.finishAttempt({
          businessId,
          effectId,
          attempt: attemptNumber,
          attemptState: "confirmed",
          effectState: "confirmed",
          outputDigest: canonicalHash(output),
          finishedAt: this.now(),
        });
        return output;
      } catch (thrown) {
        if (thrown instanceof ToolDispatchError) throw thrown;
        const error = classifyError(thrown, contract.mutating);
        const ambiguous = error.phase === "after_dispatch" && contract.mutating;
        const retry =
          error.retryable && mayRetry(contract, attemptNumber, error.phase) && !ambiguous;
        await this.deps.store.finishAttempt({
          businessId,
          effectId,
          attempt: attemptNumber,
          attemptState: ambiguous ? "ambiguous" : "failed",
          effectState: ambiguous ? "ambiguous" : retry ? "authorized" : "failed",
          providerRequestId: error.providerRequestId,
          errorCode: error.code,
          finishedAt: this.now(),
        });
        if (ambiguous) throw new ToolDispatchError("ambiguous", effectId);
        if (!retry) throw new ToolDispatchError("dispatch_failed", effectId, error.code);
        await this.wait(retryDelayMs(attemptNumber));
      }
    }
  }
}
