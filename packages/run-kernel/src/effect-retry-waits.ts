import { createHash } from "node:crypto";
import type { DurableWaitManager, PersistedWait } from "./waits";

export const EFFECT_RETRY_WAIT_SCHEMA_REF = "tulipfarm://effect/retry/v1";

export interface EffectRetryWaitParkInput {
  readonly businessId: string;
  readonly effectId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly attempt: number;
  readonly reason: string;
  readonly delayMs: number;
  readonly notBefore: string;
}

export interface EffectRetryWaitParkResult {
  readonly waitId: string;
}

export type DurableEffectRetryWaitStatus =
  | { readonly status: "none" }
  | {
      readonly status: "pending" | "ready" | "unavailable";
      readonly waitId: string;
      readonly notBefore: string;
    };

export type EffectRetryWaitParker = (
  input: EffectRetryWaitParkInput
) => Promise<EffectRetryWaitParkResult>;

export type EffectRetryWaitStatusReader = (
  businessId: string,
  effectId: string,
  attempt: number
) => Promise<DurableEffectRetryWaitStatus>;

export function effectRetryWaitId(effectId: string, attempt: number): string {
  const digest = createHash("sha256").update(`effect-retry:${effectId}:${attempt}`).digest("hex");
  const version = `4${digest.slice(13, 16)}`;
  const variant = ((Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    version,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function matches(wait: PersistedWait, input: EffectRetryWaitParkInput): boolean {
  return (
    wait.runId === input.runId &&
    wait.stateKey === input.stateId &&
    wait.kind === "timer" &&
    wait.schemaRef === EFFECT_RETRY_WAIT_SCHEMA_REF &&
    wait.deadlineAt === input.notBefore
  );
}

export class DurableEffectRetryWaitHost {
  constructor(private readonly waits: Pick<DurableWaitManager, "find" | "register">) {}

  readonly parkRetry: EffectRetryWaitParker = async (input) => {
    const waitId = effectRetryWaitId(input.effectId, input.attempt);
    const existing = await this.waits.find(input.businessId, waitId);
    if (existing !== null) {
      if (!matches(existing, input)) throw new Error("effect_retry_wait_conflict");
      return { waitId };
    }

    const createdAt = new Date(Date.parse(input.notBefore) - input.delayMs);
    if (
      !Number.isSafeInteger(input.attempt) ||
      input.attempt < 1 ||
      !Number.isSafeInteger(input.delayMs) ||
      input.delayMs < 1 ||
      !Number.isFinite(createdAt.getTime())
    ) {
      throw new Error("invalid_effect_retry_wait");
    }

    try {
      await this.waits.register({
        id: waitId,
        businessId: input.businessId,
        runId: input.runId,
        stateKey: input.stateId,
        kind: "timer",
        aggregation: "first",
        schemaRef: EFFECT_RETRY_WAIT_SCHEMA_REF,
        allowedPrincipals: [],
        expectedSignals: 1,
        quorum: null,
        deadlineAt: input.notBefore,
        createdAt: createdAt.toISOString(),
      });
    } catch (error) {
      const raced = await this.waits.find(input.businessId, waitId);
      if (raced === null || !matches(raced, input)) throw error;
    }
    return { waitId };
  };

  readonly status: EffectRetryWaitStatusReader = async (businessId, effectId, attempt) => {
    const wait = await this.waits.find(businessId, effectRetryWaitId(effectId, attempt));
    if (wait === null) return { status: "none" };
    const details = { waitId: wait.id, notBefore: wait.deadlineAt };
    if (wait.status === "pending") return { status: "pending", ...details };
    if (wait.status === "satisfied") return { status: "ready", ...details };
    return { status: "unavailable", ...details };
  };
}
