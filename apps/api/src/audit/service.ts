/** Audit evidence entry point; failures surface via `record` or log via `recordOrWarn`. */

import type { AuditDecision, AuditEvent, AuditEventInput, AuditEventRepo } from "@tulipfarm/audit";
import { AuditWriter } from "@tulipfarm/audit";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";

/** Attributed to changes made by the system itself rather than a signed-in user. */
export const SYSTEM_PRINCIPAL_ID = "system";

/** Caller-supplied audit input before chain fields and business scope are attached. */
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

  /** Appends and throws; use `new PgAuditEventRepo(tx, true)` to join a transaction. */
  async record(input: AuditRecordInput): Promise<AuditEvent> {
    return this.writer.append(this.toInput(input));
  }

  /** Appends and logs on failure for already-committed audited changes. */
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
