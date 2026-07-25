import {
  type ApprovalApprover,
  assertApproverEligible,
  computeApprovalBinding,
} from "@tulipfarm/authz";
import {
  type ApprovalDecisionEntry,
  type ApprovalGrantRecord,
  type ApprovalRepo,
  ApprovalStoreError,
  type ApprovalStoreErrorCode,
} from "@tulipfarm/storage";
import type { ToolBrokerOutcome } from "./broker";
import type { EffectStore, ReserveEffectInput, ReserveEffectResult } from "./effects";
import type { ToolIntent } from "./intent";

type AwaitingApprovalOutcome = Extract<ToolBrokerOutcome, { outcome: "awaiting_approval" }>;

export type ToolApprovalGateErrorCode =
  | ApprovalStoreErrorCode
  | "invalid_approval_outcome"
  | "binding_mismatch";

export class ToolApprovalGateError extends Error {
  constructor(
    readonly code: ToolApprovalGateErrorCode,
    readonly approvalId: string
  ) {
    super(`${code}:${approvalId}`);
    this.name = "ToolApprovalGateError";
  }
}

export interface ToolApprovalRequest {
  readonly approvalId: string;
  readonly evidenceHashes: readonly string[];
  readonly preview: string;
  readonly riskSummary: string;
  readonly allowedApproverRoles: readonly string[];
  readonly proposerPrincipalId: string;
  readonly performerPrincipalId?: string;
  readonly agentPrincipalId?: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface ConsumeApprovedEffectInput {
  readonly businessId: string;
  readonly approvalId: string;
  readonly intent: ToolIntent;
  readonly evidenceHashes: readonly string[];
  readonly guardrailRevision: string;
  readonly effect: Omit<
    ReserveEffectInput,
    "intent" | "intentDigest" | "guardrailRevision" | "approvalId"
  >;
  readonly at: Date;
}

function translate(error: unknown, approvalId: string): never {
  if (error instanceof ApprovalStoreError) {
    throw new ToolApprovalGateError(error.code, approvalId);
  }
  throw error;
}

function binding(intent: ToolIntent, evidenceHashes: readonly string[], guardrailRevision: string) {
  return computeApprovalBinding({ intent, evidenceHashes, guardrailRevision });
}

export class ToolApprovalGate {
  constructor(
    private readonly approvals: ApprovalRepo,
    private readonly effects: EffectStore
  ) {}

  async request(
    outcome: AwaitingApprovalOutcome,
    request: ToolApprovalRequest
  ): Promise<ApprovalGrantRecord> {
    const exactBinding = binding(outcome.intent, request.evidenceHashes, outcome.guardrailRevision);
    if (exactBinding.intentDigest !== outcome.intentDigest) {
      throw new ToolApprovalGateError("binding_mismatch", request.approvalId);
    }
    try {
      return await this.approvals.create({
        approvalId: request.approvalId,
        businessId: outcome.intent.businessId,
        binding: exactBinding,
        risk: outcome.risk.level,
        allowedApproverRoles: request.allowedApproverRoles,
        proposerPrincipalId: request.proposerPrincipalId,
        performerPrincipalId: request.performerPrincipalId,
        agentPrincipalId: request.agentPrincipalId,
        preview: request.preview,
        riskSummary: request.riskSummary,
        expiresAt: request.expiresAt,
        createdAt: request.createdAt,
      });
    } catch (error) {
      return translate(error, request.approvalId);
    }
  }

  async consumeAndReserve(input: ConsumeApprovedEffectInput): Promise<ReserveEffectResult> {
    if (
      input.intent.businessId !== input.businessId ||
      input.intent.idempotencyKey !== input.effect.idempotencyKey
    ) {
      throw new ToolApprovalGateError("binding_mismatch", input.approvalId);
    }
    const exactBinding = binding(input.intent, input.evidenceHashes, input.guardrailRevision);
    try {
      await this.approvals.consume(input.businessId, input.approvalId, exactBinding, input.at);
    } catch (error) {
      return translate(error, input.approvalId);
    }
    return this.effects.reserve({
      ...input.effect,
      intent: input.intent,
      intentDigest: exactBinding.intentDigest,
      guardrailRevision: input.guardrailRevision,
      approvalId: input.approvalId,
    });
  }
}

export class ToolApprovalDecisions {
  constructor(private readonly approvals: ApprovalRepo) {}

  async listPending(businessId: string, now: Date = new Date()): Promise<ApprovalGrantRecord[]> {
    return (await this.approvals.list(businessId)).filter(
      (record) =>
        record.consumedAt === undefined &&
        record.revokedAt === undefined &&
        record.expiresAt > now &&
        !record.decisions.some((decision) => decision.outcome === "denied")
    );
  }

  async decide(
    businessId: string,
    approvalId: string,
    approver: ApprovalApprover,
    outcome: ApprovalDecisionEntry["outcome"],
    decidedAt: Date
  ): Promise<ApprovalGrantRecord> {
    const record = await this.approvals.get(businessId, approvalId);
    if (record === undefined) throw new ToolApprovalGateError("not_found", approvalId);
    try {
      assertApproverEligible(record, approver, decidedAt);
      return await this.approvals.appendDecision(businessId, approvalId, {
        approverPrincipalId: approver.principalId,
        approverRoles: approver.roles,
        outcome,
        decidedAt,
      });
    } catch (error) {
      return translate(error, approvalId);
    }
  }
}
