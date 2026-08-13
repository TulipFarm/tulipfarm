import { createHash } from "node:crypto";
import {
  EffectLedgerError,
  type EffectStore,
  intentDigest,
  normalizeToolIntent,
  type ToolIntent,
} from "@tulipfarm/tool-broker";
import type { ApiToolDefinition } from "../tools/define";

/**
 * The effect ledger for the ~71 platform Tools, which until now had none.
 *
 * `github`, `slack` and the declarative family each reserve their own effect before dispatching,
 * so a crash between "the write landed" and "we recorded that it landed" is recoverable there.
 * Every other mutating Tool — Record CRUD, Soul Forge, memory, key-value — ran naked: a duplicate
 * delivery of the same tool call created a second Record, and a Tool that threw left nothing behind
 * for anyone to reconcile against.
 *
 * This module closes that gap without moving any executor. A mutating platform Tool now reserves
 * an effect keyed to its call, records one attempt per try, and lands in a terminal state that says
 * what is known: `confirmed` when the executor returned success, `failed` when it returned a
 * structured error (which proves it ran to completion and decided), and `ambiguous` when it
 * **threw** — because a throw carries no phase, so a write that landed and then failed on the way
 * back is indistinguishable from one that never landed. Parking that as `ambiguous` is the whole
 * point of having a ledger; reporting it as `failed` would licence a reconciler to assume nothing
 * happened.
 */

/** Dresses a digest as an RFC 4122 v4 uuid; `effect_records.run_id`/`effect_id` are `uuid` columns. */
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

/**
 * Whether this Tool's call is the ledger's to own on the chat path.
 *
 * Two exclusions, both load-bearing:
 *
 * - **Read-only Tools are not ledgered.** There is no effect to be idempotent about, and a row per
 *   read would make every listing a write. Idempotency protects against re-applying a change; a
 *   repeated read re-applies nothing.
 * - **A provider-backed Tool is not ledgered here**, because it already reserved its own effect
 *   inside its executor with the one thing this layer lacks: the dispatch *phase*. Reserving again
 *   would open a second effect for the same logical write and, worse, the outer reservation would
 *   report `confirmed` while the inner one sat `ambiguous`. Ownership must be singular, and the
 *   layer that can see the phase is the one that should hold it.
 */
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
}

export type ReserveOutcome =
  /** Fresh reservation; the caller must execute and then report a terminal state. */
  | { readonly outcome: "reserved"; readonly effectId: string }
  /** This exact call already ran. `state` is what the earlier attempt settled on. */
  | { readonly outcome: "duplicate"; readonly state: string }
  /**
   * The same call id came back carrying different arguments. The ledger cannot treat that as a
   * replay (the arguments are part of what was authorized) and must not treat it as new (the call
   * id is the client's own promise of uniqueness), so it is refused.
   */
  | { readonly outcome: "conflict" };

/**
 * The call's idempotency key deliberately does **not** include an argument digest.
 *
 * `effect_records` carries two unique constraints — one on `idempotency_key` and one on
 * `(run_id, state_id, logical_effect_ordinal)`. If the key varied with the arguments while
 * `state_id` did not, the same call id resubmitted with changed arguments would miss the first
 * constraint and violate the second, surfacing as a raw database error instead of a decision.
 * Keying both on the call alone keeps them in agreement, and lets `intentDigest` detect the changed
 * arguments as what it is: an idempotency conflict with a name.
 */
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

  /**
   * Opens the attempt row and moves the effect to `dispatched`. Returns its number so the matching
   * finish can address it.
   *
   * Exactly one attempt is opened per settled effect, and the dispatcher's own transient retries
   * happen *inside* it rather than each opening another. That is not a simplification: the ledger's
   * `attempt` models a dispatch whose phase is in question, and `beginAttempt` refuses any effect
   * not still `authorized` precisely to stop a settled effect being re-dispatched. The transient
   * retry loop runs entirely before any terminal decision is recorded, so it is one logical
   * dispatch that took a few tries to get an answer, not several dispatches.
   */
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
