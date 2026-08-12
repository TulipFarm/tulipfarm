/**
 * The application's single entry point for audit evidence (SPEC §20).
 *
 * Deliberately unlike {@link ActivityService}: activity is a UI feed and a lost row is cosmetic,
 * whereas audit is evidence and a lost row is the difference between an answerable and an
 * unanswerable question. So failures here are surfaced, never swallowed, and the caller chooses
 * whether to proceed — {@link record} throws, {@link recordOrWarn} does not.
 */

import type { AuditDecision, AuditEvent, AuditEventInput, AuditEventRepo } from "@tulipfarm/audit";
import { AuditWriter } from "@tulipfarm/audit";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";

/** Attributed to changes made by the system itself rather than a signed-in user. */
export const SYSTEM_PRINCIPAL_ID = "system";

/**
 * What a call site actually knows. The chain fields (`chainIndex`, `previousHash`, `hash`) and the
 * business scope are supplied here, because a route that had to compute them could get them wrong.
 */
export interface AuditRecordInput {
  /** The signed-in user, or omitted for system-initiated changes. */
  readonly actorId?: string | null;
  /** The principal whose authority was used, when it differs from the actor (an Agent acting for
   *  a user). Defaults to the actor. */
  readonly effectivePrincipalId?: string;
  readonly action: string;
  readonly target: string;
  readonly decision?: AuditDecision;
  readonly reasonCodes?: readonly string[];
  readonly correlationId?: string;
  readonly agentId?: string;
  readonly runId?: string;
  readonly causationId?: string;
  /** Non-protected evidence only — never request bodies, prompts, secrets or file contents. The
   *  audit package rejects those outright rather than storing them. */
  readonly safeMetadata?: Record<string, unknown>;
}

export class AuditService {
  private readonly writer: AuditWriter;

  constructor(
    repo: AuditEventRepo,
    private readonly businessId: string = DEPLOYMENT_BUSINESS_ID,
    private readonly log: (message: string) => void = console.error
  ) {
    this.writer = new AuditWriter(repo);
  }

  private toInput(input: AuditRecordInput): AuditEventInput {
    const principalId = input.actorId || SYSTEM_PRINCIPAL_ID;
    return {
      actor: { principalId, businessId: this.businessId },
      effectivePrincipal: {
        principalId: input.effectivePrincipalId ?? principalId,
        businessId: this.businessId,
      },
      action: input.action,
      target: input.target,
      decision: input.decision ?? "allow",
      reasonCodes: input.reasonCodes ?? [],
      // A correlation id is required by the contract; minting one keeps a caller that has no
      // request context from being unable to audit at all.
      correlationId: input.correlationId ?? crypto.randomUUID(),
      occurredAt: new Date(),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
      ...(input.safeMetadata !== undefined ? { safeMetadata: input.safeMetadata } : {}),
    };
  }

  /**
   * Appends an event, throwing if it cannot be persisted.
   *
   * Whether this joins the transaction of the change being audited depends on the repository it
   * was built with. The application-wide instance is bound to the pool, so it does *not* — the
   * event and the change commit separately. To bind them, construct a
   * `new AuditService(new PgAuditEventRepo(tx, true))` inside the transaction; the second argument
   * is required, or a chain conflict would abort the caller's transaction outright.
   */
  async record(input: AuditRecordInput): Promise<AuditEvent> {
    return this.writer.append(this.toInput(input));
  }

  /**
   * Appends an event, logging instead of throwing.
   *
   * For call sites where the audited change has already been committed and cannot be undone —
   * failing the request there would report an error for work that actually succeeded, while still
   * losing the event. The loss is made loud rather than silent.
   */
  async recordOrWarn(input: AuditRecordInput): Promise<void> {
    try {
      await this.record(input);
    } catch (error) {
      this.log(
        `[audit] FAILED to record ${input.action} on ${input.target}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
