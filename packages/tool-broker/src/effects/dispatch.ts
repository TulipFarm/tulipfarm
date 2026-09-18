import { KillSwitchDeniedError, type MutationGuard } from "@tulipfarm/observability";
import { ajv, canonicalHash, type ToolAdapterKind } from "@tulipfarm/schema";
import type { ToolCatalog } from "../catalog";
import type { PublishedToolContract } from "../contract";
import type { CredentialDispatcher } from "../credential-dispatch";
import type { ToolIntent } from "../intent";
import { mayRetry, nextRetryDelayMs } from "./retry";
import type { EffectStore } from "./store";

export type DispatchPhase = "before_dispatch" | "after_dispatch";

export class AdapterDispatchError extends Error {
  constructor(
    readonly phase: DispatchPhase,
    readonly code: string,
    readonly retryable: boolean,
    readonly providerRequestId?: string,
    /** Provider-stated delay before a safe retry, bounded by the broker before waiting. */
    readonly retryAfterMs?: number
  ) {
    super(code);
    this.name = "AdapterDispatchError";
  }
}

export interface EffectRetryParkInput {
  readonly businessId: string;
  readonly effectId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly attempt: number;
  readonly reason: string;
  readonly delayMs: number;
  readonly notBefore: string;
}

export interface EffectRetryParkResult {
  readonly waitId: string;
}

export type EffectRetryParker = (input: EffectRetryParkInput) => Promise<EffectRetryParkResult>;

export type EffectRetryWaitStatus =
  | { readonly status: "none" }
  | {
      readonly status: "pending" | "ready" | "unavailable";
      readonly waitId: string;
      readonly notBefore: string;
    };

export type EffectRetryWaitReader = (
  businessId: string,
  effectId: string,
  attempt: number
) => Promise<EffectRetryWaitStatus>;

export class EffectDispatchDeferredError extends Error {
  readonly name = "EffectDispatchDeferredError";

  constructor(readonly deferred: EffectRetryParkInput & { readonly waitId: string }) {
    super(`retry_deferred:${deferred.effectId}:${deferred.waitId}`);
  }
}

export interface ToolAdapterRequest {
  readonly intent: ToolIntent;
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly timeoutMs?: number;
  /** Aborts provider work when the host or contract deadline expires. */
  readonly abortSignal?: AbortSignal;
}

/** Plaintext credentials leased for one dispatch, keyed by manifest credential slot. */
export type ToolAdapterCredentials = Readonly<Record<string, string>>;

export interface ToolAdapter {
  /**
   * The backend this adapter actually is. Resolution is by `ToolContractSpec.adapter.ref`, which a
   * contract chooses freely, so without this the declared `adapter.kind` is decoration: a contract
   * could name a ref registered to another backend and be handed that backend's authority. The
   * dispatcher refuses when the two disagree.
   */
  readonly kind: ToolAdapterKind;
  dispatch(
    request: ToolAdapterRequest,
    credential?: string,
    credentials?: ToolAdapterCredentials
  ): Promise<unknown>;
}

export type ToolDispatchErrorCode =
  | "effect_not_found"
  | "contract_not_found"
  | "adapter_not_found"
  | "adapter_kind_mismatch"
  | "mcp_binding_mismatch"
  | "dispatch_failed"
  | "dispatch_in_progress"
  | "ambiguous"
  | "invalid_output"
  | "kill_switch_denied"
  | "retry_wait_unavailable";

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
  /** Registers a durable Run timer for provider retries instead of sleeping in-process. */
  readonly parkRetry?: EffectRetryParker;
  /** Reads the durable timer before a restarted dispatcher may begin the next attempt. */
  readonly retryWaitStatus?: EffectRetryWaitReader;
  readonly wait?: (delayMs: number, abortSignal?: AbortSignal) => Promise<void>;
  readonly now?: () => string;
}

const MIN_DISPATCH_STALE_MS = 60_000;
const DISPATCH_SETTLEMENT_GRACE_MS = 10_000;

function classifyError(error: unknown, mutating: boolean): AdapterDispatchError {
  if (error instanceof AdapterDispatchError) return error;
  return new AdapterDispatchError(
    mutating ? "after_dispatch" : "before_dispatch",
    "adapter_error",
    false
  );
}

async function withTimeout(
  execute: (abortSignal: AbortSignal) => Promise<unknown>,
  timeoutMs: number | undefined,
  outerSignal: AbortSignal | undefined
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timedOut = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new AdapterDispatchError("after_dispatch", "provider_timeout", true)),
      { once: true }
    );
  });
  if (outerSignal?.aborted) abort();
  else outerSignal?.addEventListener("abort", abort, { once: true });
  const timer =
    timeoutMs === undefined || timeoutMs <= 0 ? undefined : setTimeout(abort, timeoutMs);
  try {
    return await Promise.race([execute(controller.signal), timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    outerSignal?.removeEventListener("abort", abort);
  }
}

class RetryWaitAbortedError extends Error {}

function waitForDelay(delayMs: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new RetryWaitAbortedError());
      return;
    }
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(new RetryWaitAbortedError());
    };
    abortSignal?.addEventListener("abort", abort, { once: true });
  });
}

export class EffectDispatcher {
  private readonly wait: (delayMs: number, abortSignal?: AbortSignal) => Promise<void>;
  private readonly now: () => string;

  constructor(private readonly deps: EffectDispatcherDeps) {
    this.wait = deps.wait ?? waitForDelay;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async dispatch(
    businessId: string,
    effectId: string,
    abortSignal?: AbortSignal
  ): Promise<unknown> {
    let effect = await this.deps.store.get(businessId, effectId);
    if (effect === undefined) throw new ToolDispatchError("effect_not_found", effectId);
    if (effect.state === "confirmed") {
      if (!effect.outputStored) {
        throw new ToolDispatchError("invalid_output", effectId, "confirmed_output_unavailable");
      }
      return effect.output;
    }
    if (effect.state === "ambiguous" || effect.state === "reconciliation_required") {
      throw new ToolDispatchError("ambiguous", effectId);
    }
    if (effect.state !== "authorized" && effect.state !== "dispatched") {
      throw new ToolDispatchError("dispatch_failed", effectId, `effect_${effect.state}`);
    }
    const contract = this.deps.catalog.get(effect.intent.toolId, effect.intent.toolVersion);
    if (contract === undefined) throw new ToolDispatchError("contract_not_found", effectId);
    const adapter = this.deps.adapters.get(contract.adapter.ref);
    if (adapter === undefined) throw new ToolDispatchError("adapter_not_found", effectId);
    // Checked before the attempt is recorded, like the kill switch: a contract that reaches the
    // wrong backend is a mis-registration, and recording an attempt would claim the call was
    // routable. The detail names both sides so an operator can see which one is wrong.
    if (adapter.kind !== contract.adapter.kind) {
      throw new ToolDispatchError(
        "adapter_kind_mismatch",
        effectId,
        `${contract.adapter.kind}!=${adapter.kind}`
      );
    }
    if (
      contract.adapter.kind === "mcp" &&
      (effect.intent.mcp?.serverId !== contract.adapter.ref ||
        effect.intent.mcp?.serverRevision !== effect.intent.toolVersion)
    ) {
      throw new ToolDispatchError("mcp_binding_mismatch", effectId);
    }
    effect = await this.recoverInterruptedDispatch(businessId, effect, contract);
    await this.assertRetryReady(businessId, effect);
    const validateOutput = ajv.compile(contract.outputSchema);

    if (this.deps.mutationGuard !== undefined) {
      try {
        await this.deps.mutationGuard.assertAllowed({
          businessId,
          mutation: contract.mutating,
          runId: effect.runId,
          stateId: effect.intent.runStateId ?? effect.stateId,
          effectId,
          toolId: effect.intent.toolId,
          provider: contract.adapter.ref,
          destination: effect.intent.destination,
          dataClasses: contract.dataClasses,
          ...this.deps.mutationIdentity,
          ...(effect.intent.mcp === undefined ? {} : { integrationId: effect.intent.mcp.serverId }),
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
          (abortSignal) => {
            const requestWithSignal = { ...request, abortSignal };
            return this.deps.credentialDispatcher === undefined
              ? adapter.dispatch(requestWithSignal)
              : this.deps.credentialDispatcher.dispatch(effect, adapter, requestWithSignal);
          },
          contract.timeout?.wallClockMs,
          abortSignal
        );
        if (!validateOutput(output)) {
          const uncertainMutation = contract.mutating;
          await this.deps.store.finishAttempt({
            businessId,
            effectId,
            attempt: attemptNumber,
            attemptState: uncertainMutation ? "ambiguous" : "failed",
            effectState: uncertainMutation ? "ambiguous" : "failed",
            errorCode: "invalid_output",
            finishedAt: this.now(),
          });
          throw new ToolDispatchError(
            uncertainMutation ? "ambiguous" : "invalid_output",
            effectId,
            "invalid_output"
          );
        }
        await this.deps.store.finishAttempt({
          businessId,
          effectId,
          attempt: attemptNumber,
          attemptState: "confirmed",
          effectState: "confirmed",
          outputDigest: canonicalHash(output),
          output: { value: output },
          finishedAt: this.now(),
        });
        return output;
      } catch (thrown) {
        if (thrown instanceof ToolDispatchError) throw thrown;
        const error = classifyError(thrown, contract.mutating);
        const ambiguous = error.phase === "after_dispatch" && contract.mutating;
        const retry =
          error.retryable && mayRetry(contract, attemptNumber, error.phase) && !ambiguous;
        if (ambiguous || !retry) {
          await this.deps.store.finishAttempt({
            businessId,
            effectId,
            attempt: attemptNumber,
            attemptState: ambiguous ? "ambiguous" : "failed",
            effectState: ambiguous ? "ambiguous" : "failed",
            providerRequestId: error.providerRequestId,
            errorCode: error.code,
            finishedAt: this.now(),
          });
          if (ambiguous) throw new ToolDispatchError("ambiguous", effectId);
          throw new ToolDispatchError("dispatch_failed", effectId, error.code);
        }
        const delayMs = nextRetryDelayMs(attemptNumber, error.retryAfterMs);
        if (this.deps.parkRetry !== undefined) {
          const notBefore = new Date(Date.parse(this.now()) + delayMs).toISOString();
          const input = {
            businessId,
            effectId,
            runId: effect.runId,
            stateId: effect.intent.runStateId ?? effect.stateId,
            attempt: attemptNumber,
            reason: error.code,
            delayMs,
            notBefore,
          };
          let waitId: string;
          try {
            ({ waitId } = await this.deps.parkRetry(input));
          } catch {
            throw new ToolDispatchError("retry_wait_unavailable", effectId, error.code);
          }
          await this.deps.store.finishAttempt({
            businessId,
            effectId,
            attempt: attemptNumber,
            attemptState: "failed",
            effectState: "authorized",
            providerRequestId: error.providerRequestId,
            errorCode: error.code,
            finishedAt: this.now(),
          });
          throw new EffectDispatchDeferredError({ ...input, waitId });
        }
        if (error.retryAfterMs !== undefined) {
          await this.deps.store.finishAttempt({
            businessId,
            effectId,
            attempt: attemptNumber,
            attemptState: "failed",
            effectState: "failed",
            providerRequestId: error.providerRequestId,
            errorCode: error.code,
            finishedAt: this.now(),
          });
          throw new ToolDispatchError("retry_wait_unavailable", effectId, error.code);
        }
        await this.deps.store.finishAttempt({
          businessId,
          effectId,
          attempt: attemptNumber,
          attemptState: "failed",
          effectState: "authorized",
          providerRequestId: error.providerRequestId,
          errorCode: error.code,
          finishedAt: this.now(),
        });
        try {
          await this.wait(delayMs, abortSignal);
        } catch (waitError) {
          if (waitError instanceof RetryWaitAbortedError || abortSignal?.aborted) {
            throw new ToolDispatchError("dispatch_failed", effectId, "dispatch_cancelled");
          }
          throw waitError;
        }
        if (abortSignal?.aborted) {
          throw new ToolDispatchError("dispatch_failed", effectId, "dispatch_cancelled");
        }
      }
    }
  }

  private async recoverInterruptedDispatch(
    businessId: string,
    effect: NonNullable<Awaited<ReturnType<EffectStore["get"]>>>,
    contract: PublishedToolContract
  ): Promise<NonNullable<Awaited<ReturnType<EffectStore["get"]>>>> {
    if (effect.state !== "dispatched") return effect;
    const attempts = await this.deps.store.listAttempts(businessId, effect.effectId);
    const attempt = attempts.at(-1);
    if (attempt === undefined || attempt.state !== "dispatched") {
      throw new ToolDispatchError("ambiguous", effect.effectId, "dispatch_evidence_missing");
    }

    const retry = await this.retryWait(businessId, effect.effectId, attempt.attempt);
    if (retry.status !== "none") {
      await this.deps.store.finishAttempt({
        businessId,
        effectId: effect.effectId,
        attempt: attempt.attempt,
        attemptState: "failed",
        effectState: "authorized",
        errorCode: "provider_retry_wait",
        finishedAt: this.now(),
      });
      const recovered = await this.deps.store.get(businessId, effect.effectId);
      if (recovered === undefined) {
        throw new ToolDispatchError("effect_not_found", effect.effectId);
      }
      return recovered;
    }

    const staleAfterMs = Math.max(
      MIN_DISPATCH_STALE_MS,
      (contract.timeout?.wallClockMs ?? 0) + DISPATCH_SETTLEMENT_GRACE_MS
    );
    if (Date.parse(this.now()) < Date.parse(attempt.startedAt) + staleAfterMs) {
      throw new ToolDispatchError("dispatch_in_progress", effect.effectId);
    }
    await this.deps.store.transition({
      businessId,
      effectId: effect.effectId,
      expectedStates: ["dispatched"],
      state: "reconciliation_required",
      updatedAt: this.now(),
    });
    throw new ToolDispatchError("ambiguous", effect.effectId);
  }

  private async assertRetryReady(
    businessId: string,
    effect: NonNullable<Awaited<ReturnType<EffectStore["get"]>>>
  ): Promise<void> {
    if (effect.state !== "authorized" || this.deps.retryWaitStatus === undefined) return;
    const attempts = await this.deps.store.listAttempts(businessId, effect.effectId);
    const attempt = attempts.at(-1);
    if (attempt === undefined || attempt.state !== "failed") return;
    const retry = await this.retryWait(businessId, effect.effectId, attempt.attempt);
    if (retry.status === "ready") return;
    if (retry.status === "none" || retry.status === "unavailable") {
      throw new ToolDispatchError("retry_wait_unavailable", effect.effectId);
    }
    throw new EffectDispatchDeferredError({
      businessId,
      effectId: effect.effectId,
      runId: effect.runId,
      stateId: effect.intent.runStateId ?? effect.stateId,
      attempt: attempt.attempt,
      reason: attempt.errorCode ?? "provider_retry_wait",
      delayMs: Math.max(1, Date.parse(retry.notBefore) - Date.parse(this.now())),
      notBefore: retry.notBefore,
      waitId: retry.waitId,
    });
  }

  private async retryWait(
    businessId: string,
    effectId: string,
    attempt: number
  ): Promise<EffectRetryWaitStatus> {
    return (
      (await this.deps.retryWaitStatus?.(businessId, effectId, attempt)) ?? {
        status: "none",
      }
    );
  }
}
