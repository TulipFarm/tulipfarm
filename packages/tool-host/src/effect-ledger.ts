import { createHash } from "node:crypto";
import {
  EffectLedgerError,
  type EffectStore,
  intentDigest,
  normalizeToolIntent,
  type ToolIntent,
} from "@tulipfarm/tool-broker";
import type { ApiToolDefinition } from "./define";

/** Platform Tool effect ledger; thrown attempts are `ambiguous`, never `failed`. */

/** Dresses a digest as an RFC 4122 v4 uuid for `uuid` columns. */
export function derivedEffectId(...parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join(":")).digest("hex");
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

/** Ledger only mutating non-provider Tools; effect ownership must be singular. */
export function ledgerOwnsCall(definition: ApiToolDefinition<unknown> | undefined): boolean {
  if (definition === undefined) return false;
  if (!definition.mutating) return false;
  return definition.provider === undefined;
}

export interface LedgerCallInput {
  readonly businessId: string;
  readonly runId: string;
  readonly callId: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly action: string;
  readonly arguments: unknown;
  readonly targetRefs: readonly { readonly type: string; readonly id: string }[];
  readonly guardrailRevision: string;
  readonly destination?: string;
}

export type ReserveOutcome =
  /** Fresh reservation; the caller must execute and then report a terminal state. */
  | { readonly outcome: "reserved"; readonly effectId: string }
  /** This exact call already ran. `state` is what the earlier attempt settled on. */
  | { readonly outcome: "duplicate"; readonly state: string }
  /** Same call id with different authorized arguments: refuse as an idempotency conflict. */
  | { readonly outcome: "conflict" };

/** Idempotency excludes the argument digest so both unique constraints agree on conflicts. */
function idempotencyKeyFor(input: LedgerCallInput): string {
  return derivedEffectId("chat-tool-idempotency", input.runId, input.callId, input.toolId);
}

function intentFor(input: LedgerCallInput): ToolIntent {
  return normalizeToolIntent({
    intentId: derivedEffectId("chat-tool-intent", input.runId, input.callId, input.toolId),
    businessId: input.businessId,
    runId: input.runId,
    stateId: `chat:${input.callId}`,
    toolId: input.toolId,
    toolVersion: input.toolVersion,
    action: input.action,
    targetRefs: input.targetRefs.map((ref) => ({ type: ref.type, id: ref.id })),
    arguments: input.arguments,
    idempotencyKey: idempotencyKeyFor(input),
    ...(input.destination === undefined ? {} : { destination: input.destination }),
  });
}

export class ChatEffectLedger {
  constructor(private readonly store: EffectStore) {}

  async reserve(input: LedgerCallInput): Promise<ReserveOutcome> {
    const intent = intentFor(input);
    const effectId = derivedEffectId("chat-tool-effect", input.runId, input.callId, input.toolId);
    try {
      const reserved = await this.store.reserve({
        effectId,
        businessId: input.businessId,
        runId: input.runId,
        stateId: intent.stateId,
        logicalEffectOrdinal: 0,
        idempotencyKey: intent.idempotencyKey,
        intentDigest: intentDigest(intent),
        intent,
        guardrailRevision: input.guardrailRevision,
        createdAt: new Date().toISOString(),
      });
      return reserved.outcome === "duplicate"
        ? { outcome: "duplicate", state: reserved.effect.state }
        : { outcome: "reserved", effectId: reserved.effect.effectId };
    } catch (error) {
      if (error instanceof EffectLedgerError && error.code === "idempotency_digest_mismatch") {
        return { outcome: "conflict" };
      }
      throw error;
    }
  }

  /** Open one attempt per authorized effect; transient retries stay inside that attempt. */
  async beginAttempt(businessId: string, effectId: string): Promise<number> {
    const attempt = await this.store.beginAttempt(businessId, effectId, new Date().toISOString());
    return attempt.attempt;
  }

  async finishAttempt(
    businessId: string,
    effectId: string,
    attempt: number,
    outcome: { readonly state: "confirmed" | "failed" | "ambiguous"; readonly errorCode?: string }
  ): Promise<void> {
    await this.store.finishAttempt({
      businessId,
      effectId,
      attempt,
      attemptState: outcome.state,
      effectState: outcome.state,
      finishedAt: new Date().toISOString(),
      ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
    });
  }
}
