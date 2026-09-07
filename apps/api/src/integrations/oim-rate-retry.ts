import { createHash } from "node:crypto";
import type { DurableWaitManager, PersistedWait } from "@tulipfarm/run-kernel";
import type { EffectRetryParker, EffectRetryParkInput } from "@tulipfarm/tool-broker";

export const OIM_RATE_RETRY_WAIT_SCHEMA_REF = "tulipfarm://oim/rate-retry/v1";

export type OimRateRetryWaitStatus = "none" | "pending" | "ready" | "unavailable";

export function oimRateRetryWaitId(effectId: string, attempt: number): string {
  const digest = createHash("sha256").update(`oim-rate-retry:${effectId}:${attempt}`).digest("hex");
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

function matches(wait: PersistedWait, input: EffectRetryParkInput): boolean {
  return (
    wait.runId === input.runId &&
    wait.stateKey === input.stateId &&
    wait.kind === "timer" &&
    wait.schemaRef === OIM_RATE_RETRY_WAIT_SCHEMA_REF &&
    wait.deadlineAt === input.notBefore
  );
}

export class OimRateRetryWaitHost {
  constructor(private readonly waits: DurableWaitManager) {}

  readonly parkRetry: EffectRetryParker = async (input) => {
    const waitId = oimRateRetryWaitId(input.effectId, input.attempt);
    const existing = await this.waits.find(input.businessId, waitId);
    if (existing !== null) {
      if (!matches(existing, input)) throw new Error("oim_rate_retry_wait_conflict");
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
      throw new Error("invalid_oim_rate_retry_wait");
    }

    try {
      await this.waits.register({
        id: waitId,
        businessId: input.businessId,
        runId: input.runId,
        stateKey: input.stateId,
        kind: "timer",
        aggregation: "first",
        schemaRef: OIM_RATE_RETRY_WAIT_SCHEMA_REF,
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

  async status(
    businessId: string,
    effectId: string,
    attempt: number
  ): Promise<OimRateRetryWaitStatus> {
    const wait = await this.waits.find(businessId, oimRateRetryWaitId(effectId, attempt));
    if (wait === null) return "none";
    if (wait.status === "pending") return "pending";
    if (wait.status === "satisfied") return "ready";
    return "unavailable";
  }
}
