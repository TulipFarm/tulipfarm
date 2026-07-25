import type {
  CreateWaitInput,
  PersistedWait,
  PersistedWaitKind,
  PersistedWaitSignal,
  WaitAggregation,
  WaitDeliveryResult,
  WaitSignalInput,
  WaitSignalPolicy,
} from "@tulipfarm/storage";
import { hashResumeToken, mintResumeToken, type RunResumeGateway } from "./resume";

export type { PersistedWait, PersistedWaitKind, WaitAggregation };

export type DurableWaitErrorCode =
  | "invalid_wait_definition"
  | "unknown_resume_token"
  | "wait_already_resolved"
  | "wait_expired"
  | "wait_not_signalable"
  | "wrong_principal"
  | "wrong_run"
  | "wrong_schema";

/**
 * Durable-wait denial. The message carries the reason code and the wait/Run identity only —
 * never the signal payload, principal credentials, or resume token.
 */
export class DurableWaitError extends Error {
  readonly name = "DurableWaitError";

  constructor(
    readonly code: DurableWaitErrorCode,
    readonly detail = ""
  ) {
    super(`${code}${detail ? `:${detail}` : ""}`);
  }
}

export interface RegisterWaitInput {
  readonly id: string;
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly kind: PersistedWaitKind;
  readonly aggregation: WaitAggregation;
  /** Schema reference every accepted signal must declare; a timer still names its wait schema. */
  readonly schemaRef: string;
  /** Canonical `kind:id` principals authorized to signal; empty only for a timer. */
  readonly allowedPrincipals: readonly string[];
  readonly expectedSignals: number;
  readonly quorum: number | null;
  readonly deadlineAt: string;
  readonly createdAt: string;
}

export interface RegisteredWait {
  readonly wait: PersistedWait;
  /** Plaintext resume token, returned once. Storage holds only its SHA-256 digest. */
  readonly token: string;
}

export interface SignalWaitInput {
  readonly id: string;
  readonly businessId: string;
  readonly runId: string;
  readonly token: string;
  readonly principal: string;
  readonly schemaRef: string;
  /** Stable identity of this signal; a repeat delivery of the same identity is deduplicated. */
  readonly correlationKey: string;
  readonly signalDigest: string;
  readonly receivedAt: string;
}

export type WaitSignalOutcome = "resumed" | "resolved_without_resume" | "recorded" | "duplicate";

export interface WaitSignalResult {
  /**
   * `resumed` — the wait resolved and its Run left `waiting`. `resolved_without_resume` — the
   * wait resolved exactly once but the Run was no longer `waiting`, so it needs reconciliation.
   * `recorded` — counted toward aggregation. `duplicate` — already-seen correlation key.
   */
  readonly outcome: WaitSignalOutcome;
  readonly wait: PersistedWait;
  readonly signalCount: number;
}

/** Narrow surface `DurableWaitManager` needs; `@tulipfarm/storage`'s `WaitStore` satisfies it. */
export interface DurableWaitStore {
  create(input: CreateWaitInput): Promise<PersistedWait>;
  find(businessId: string, waitId: string): Promise<PersistedWait | null>;
  listSignals(businessId: string, waitId: string): Promise<readonly PersistedWaitSignal[]>;
  deliverSignal(input: WaitSignalInput, policy: WaitSignalPolicy): Promise<WaitDeliveryResult>;
}

function assertDefinition(input: RegisterWaitInput): void {
  const fail = (detail: string): never => {
    throw new DurableWaitError("invalid_wait_definition", detail);
  };
  if (input.schemaRef.length === 0) fail("schemaRef");
  if (input.deadlineAt <= input.createdAt) fail("deadlineAt");
  if (input.kind === "timer") {
    if (input.aggregation !== "first" || input.expectedSignals !== 1) fail("timer");
  } else if (input.allowedPrincipals.length === 0) {
    fail("allowedPrincipals");
  }
  if (input.expectedSignals < 1) fail("expectedSignals");
  if (input.aggregation === "first" && input.expectedSignals !== 1) fail("expectedSignals");
  if (input.aggregation === "quorum") {
    if (input.quorum === null || input.quorum < 1 || input.quorum > input.expectedSignals) {
      fail("quorum");
    }
  } else if (input.quorum !== null) {
    fail("quorum");
  }
}

/**
 * Default-deny authorization for one delivery, evaluated under the wait's lock. Identity checks
 * always apply, so a replayed correlation key from another Run, schema, or principal is still
 * denied. Lifecycle checks are skipped for a signal already recorded under this wait: an
 * at-least-once redelivery of accepted work is idempotent, not a late or duplicate resume.
 */
export function authorizeSignal(
  wait: PersistedWait,
  input: SignalWaitInput,
  isDuplicate: boolean
): DurableWaitErrorCode | null {
  if (wait.runId !== input.runId) return "wrong_run";
  if (wait.kind === "timer") return "wait_not_signalable";
  if (wait.schemaRef !== input.schemaRef) return "wrong_schema";
  if (!wait.allowedPrincipals.includes(input.principal)) return "wrong_principal";
  if (isDuplicate) return null;
  if (wait.status !== "pending") return "wait_already_resolved";
  if (input.receivedAt >= wait.deadlineAt) return "wait_expired";
  return null;
}

/** SPEC §9.2 aggregation: `first`, `all`, `quorum`, or a bounded window closed by its deadline. */
export function isWaitSatisfied(wait: PersistedWait, signalCount: number): boolean {
  switch (wait.aggregation) {
    case "first":
      return signalCount >= 1;
    case "all":
      return signalCount >= wait.expectedSignals;
    case "quorum":
      return wait.quorum !== null && signalCount >= wait.quorum;
    case "window":
      return false;
  }
}

/**
 * Durable timer, event, Approval, human-task, form, and child-Run waits (SPEC §7.2, §9.2). A wait
 * is persisted before the Run stops consuming a worker; it is redeemed through an unguessable
 * one-use resume token whose digest alone is stored. Storage resolves the wait and consumes the
 * token under one row lock, so a duplicate delivery, a wrong-principal attempt, a concurrent
 * worker, or a restart still resumes the Run exactly once.
 */
export class DurableWaitManager {
  constructor(
    private readonly store: DurableWaitStore,
    private readonly resume: RunResumeGateway
  ) {}

  /** Persists a wait and returns its resume token once. */
  async register(input: RegisterWaitInput): Promise<RegisteredWait> {
    assertDefinition(input);
    const { token, tokenHash } = mintResumeToken();
    const wait = await this.store.create({
      id: input.id,
      businessId: input.businessId,
      runId: input.runId,
      stateKey: input.stateKey,
      kind: input.kind,
      aggregation: input.aggregation,
      schemaRef: input.schemaRef,
      allowedPrincipals: input.allowedPrincipals,
      expectedSignals: input.expectedSignals,
      quorum: input.quorum,
      tokenHash,
      deadlineAt: input.deadlineAt,
      createdAt: input.createdAt,
    });
    return { wait, token };
  }

  /** Redeems a resume token. Denials throw; accepted deliveries report their aggregation effect. */
  async signal(input: SignalWaitInput): Promise<WaitSignalResult> {
    const result = await this.store.deliverSignal(
      {
        id: input.id,
        businessId: input.businessId,
        tokenHash: hashResumeToken(input.token),
        runId: input.runId,
        correlationKey: input.correlationKey,
        signalDigest: input.signalDigest,
        principal: input.principal,
        receivedAt: input.receivedAt,
      },
      {
        authorize: (wait, isDuplicate) => authorizeSignal(wait, input, isDuplicate),
        isSatisfied: isWaitSatisfied,
      }
    );

    if (result.outcome === "unknown_token") {
      throw new DurableWaitError("unknown_resume_token");
    }
    if (result.outcome === "denied" || result.wait === null) {
      throw new DurableWaitError(
        (result.reason ?? "unknown_resume_token") as DurableWaitErrorCode,
        result.wait?.id ?? ""
      );
    }
    if (result.outcome !== "resolved") {
      return { outcome: result.outcome, wait: result.wait, signalCount: result.signalCount };
    }

    const resumed = await this.resume.resume(input.businessId, result.wait.runId);
    return {
      outcome: resumed ? "resumed" : "resolved_without_resume",
      wait: result.wait,
      signalCount: result.signalCount,
    };
  }

  async find(businessId: string, waitId: string): Promise<PersistedWait | null> {
    return this.store.find(businessId, waitId);
  }

  async listSignals(businessId: string, waitId: string): Promise<readonly PersistedWaitSignal[]> {
    return this.store.listSignals(businessId, waitId);
  }
}
