export const CONCURRENCY_POLICIES = [
  "parallel",
  "serialize",
  "queue",
  "coalesce",
  "reject",
  "supersede",
] as const;

export type ConcurrencyPolicy = (typeof CONCURRENCY_POLICIES)[number];

export type ConcurrencySlotStatus = "held" | "queued" | "superseded";

export interface ConcurrencySlot {
  readonly runId: string;
  readonly status: ConcurrencySlotStatus;
  readonly sequence: number;
}

export type AdmissionRejectionReason = "target_busy" | "queue_full";

export type AdmissionAction =
  | { readonly kind: "hold" }
  | { readonly kind: "queue" }
  | { readonly kind: "reject"; readonly reason: AdmissionRejectionReason }
  | { readonly kind: "coalesce"; readonly withRunId: string }
  | { readonly kind: "supersede"; readonly supersedeRunIds: readonly string[] };

export interface AdmissionRequest {
  readonly businessId: string;
  readonly runId: string;
  readonly targetKey: string;
  readonly policy: ConcurrencyPolicy;
  readonly maxConcurrency?: number | null;
  readonly maxQueued?: number | null;
  readonly requestedAt: string;
}

export interface AdmitInput extends AdmissionRequest {
  readonly stateKey: string;
}

export type AdmissionOutcome = "admitted" | "queued" | "rejected" | "coalesced" | "superseded";

export interface AdmissionDecision {
  readonly outcome: AdmissionOutcome;
  readonly targetKey: string;
  readonly runId: string;
  readonly holders: readonly string[];
  readonly supersededRunIds: readonly string[];
  readonly queuePosition: number | null;
  readonly coalescedWithRunId?: string;
  readonly rejectionReason?: AdmissionRejectionReason;
}

export interface ReleaseSlotInput {
  readonly businessId: string;
  readonly targetKey: string;
  readonly runId: string;
  readonly now: string;
}

export interface ReleaseSlotResult {
  readonly released: boolean;
  readonly promotedRunId: string | null;
}

export type ConcurrencyErrorCode = "invalid_concurrency_policy";

/** Concurrency denial carrying the reason code and offending field only. */
export class ConcurrencyError extends Error {
  readonly name = "ConcurrencyError";

  constructor(
    readonly code: ConcurrencyErrorCode,
    readonly field = ""
  ) {
    super(`${code}${field ? `:${field}` : ""}`);
  }
}

/**
 * `decide` runs under the target row lock and excludes the admitting Run's own slot.
 */
export interface RunConcurrencyStore {
  admit(
    input: {
      businessId: string;
      runId: string;
      targetKey: string;
      stateKey: string;
      policy: string;
      requestedAt: string;
    },
    decide: (slots: readonly ConcurrencySlot[]) => AdmissionAction
  ): Promise<{ action: AdmissionAction; slots: readonly ConcurrencySlot[] }>;
  release(
    businessId: string,
    targetKey: string,
    runId: string,
    now: string
  ): Promise<ReleaseSlotResult>;
  listSlots(businessId: string, targetKey: string): Promise<readonly ConcurrencySlot[]>;
}

function liveSlots(slots: readonly ConcurrencySlot[]): readonly ConcurrencySlot[] {
  return [...slots]
    .filter((slot) => slot.status !== "superseded")
    .sort((left, right) => left.sequence - right.sequence);
}

function effectiveConcurrency(request: AdmissionRequest): number {
  if (request.policy === "serialize") return 1;
  return request.maxConcurrency ?? 1;
}

/**
 * Admission is decided under the target lock; a Run that already has its slot keeps it.
 */
export function decideAdmission(
  request: AdmissionRequest,
  slots: readonly ConcurrencySlot[]
): AdmissionAction {
  const live = liveSlots(slots);
  const own = live.find((slot) => slot.runId === request.runId);
  if (own !== undefined) return own.status === "held" ? { kind: "hold" } : { kind: "queue" };

  const others = live.filter((slot) => slot.runId !== request.runId);
  const held = others.filter((slot) => slot.status === "held");

  switch (request.policy) {
    case "parallel":
      return { kind: "hold" };
    case "coalesce": {
      const earliest = others[0];
      return earliest === undefined
        ? { kind: "hold" }
        : { kind: "coalesce", withRunId: earliest.runId };
    }
    case "reject":
      return held.length === 0 ? { kind: "hold" } : { kind: "reject", reason: "target_busy" };
    case "supersede":
      return others.length === 0
        ? { kind: "hold" }
        : { kind: "supersede", supersedeRunIds: others.map((slot) => slot.runId) };
    case "serialize":
    case "queue": {
      if (held.length < effectiveConcurrency(request)) return { kind: "hold" };
      const queued = others.filter((slot) => slot.status === "queued").length;
      const maxQueued = request.maxQueued ?? null;
      if (maxQueued !== null && queued >= maxQueued) {
        return { kind: "reject", reason: "queue_full" };
      }
      return { kind: "queue" };
    }
  }
}

function assertPolicy(request: AdmissionRequest): void {
  const { policy, maxConcurrency, maxQueued } = request;
  const bounded = policy === "queue" || policy === "parallel";
  if (!bounded && maxConcurrency !== undefined && maxConcurrency !== null && maxConcurrency !== 1) {
    throw new ConcurrencyError("invalid_concurrency_policy", "maxConcurrency");
  }
  if (bounded && maxConcurrency !== undefined && maxConcurrency !== null && maxConcurrency < 1) {
    throw new ConcurrencyError("invalid_concurrency_policy", "maxConcurrency");
  }
  const queues = policy === "queue" || policy === "serialize";
  if (!queues && maxQueued !== undefined && maxQueued !== null) {
    throw new ConcurrencyError("invalid_concurrency_policy", "maxQueued");
  }
  if (queues && maxQueued !== undefined && maxQueued !== null && maxQueued < 0) {
    throw new ConcurrencyError("invalid_concurrency_policy", "maxQueued");
  }
}

/**
 * Target concurrency decisions persist under the target lock; invalid policy widening is denied.
 */
export class TargetConcurrencyManager {
  constructor(private readonly store: RunConcurrencyStore) {}

  async admit(input: AdmitInput): Promise<AdmissionDecision> {
    assertPolicy(input);
    const { action, slots } = await this.store.admit(
      {
        businessId: input.businessId,
        runId: input.runId,
        targetKey: input.targetKey,
        stateKey: input.stateKey,
        policy: input.policy,
        requestedAt: input.requestedAt,
      },
      (contenders) => decideAdmission(input, contenders)
    );

    const live = liveSlots(slots).filter((slot) => slot.runId !== input.runId);
    const holders = live.filter((slot) => slot.status === "held").map((slot) => slot.runId);
    const base = {
      targetKey: input.targetKey,
      runId: input.runId,
      holders,
      supersededRunIds: [] as readonly string[],
      queuePosition: null as number | null,
    };

    switch (action.kind) {
      case "hold":
        return { ...base, outcome: "admitted" };
      case "queue":
        return {
          ...base,
          outcome: "queued",
          queuePosition: live.filter((slot) => slot.status === "queued").length + 1,
        };
      case "reject":
        return { ...base, outcome: "rejected", rejectionReason: action.reason };
      case "coalesce":
        return { ...base, outcome: "coalesced", coalescedWithRunId: action.withRunId };
      case "supersede":
        return { ...base, outcome: "superseded", supersededRunIds: action.supersedeRunIds };
    }
  }

  async release(input: ReleaseSlotInput): Promise<ReleaseSlotResult> {
    return this.store.release(input.businessId, input.targetKey, input.runId, input.now);
  }

  async listSlots(businessId: string, targetKey: string): Promise<readonly ConcurrencySlot[]> {
    return this.store.listSlots(businessId, targetKey);
  }
}
