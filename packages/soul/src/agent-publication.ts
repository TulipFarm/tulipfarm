/** Agent publication gate: action-capable Agents need eval evidence and an allowed verdict. */

export interface ActivationAllowed {
  readonly decision: "allowed";
  readonly exceptionId?: string;
}

export interface ActivationBlocked {
  readonly decision: "blocked";
  readonly reason: string;
  readonly regressedCaseIds: readonly string[];
  readonly failedCaseIds: readonly string[];
}

export type AgentActivationVerdict = ActivationAllowed | ActivationBlocked;

export type AgentPublicationErrorCode = "activation_blocked" | "eval_evidence_missing";

/** Publication denial carrying the reason code only — never eval inputs or model output. */
export class AgentPublicationError extends Error {
  readonly name = "AgentPublicationError";

  constructor(
    readonly code: AgentPublicationErrorCode,
    readonly detail = ""
  ) {
    super(`${code}${detail ? `:${detail}` : ""}`);
  }
}

export interface AgentPublicationRequest {
  readonly agentId: string;
  readonly version: string;
  /** True when the Agent may call effect-bearing Tools; read-only Agents are gated more loosely. */
  readonly actionCapable: boolean;
  readonly activation?: AgentActivationVerdict;
  readonly evalReportDigest?: string;
  readonly publishedBy: string;
}

export interface PublishedAgentVersion {
  readonly status: "published";
  readonly agentId: string;
  readonly version: string;
  readonly actionCapable: boolean;
  readonly evalReportDigest: string | null;
  readonly exceptionId: string | null;
  readonly publishedBy: string;
}

export function publishAgentVersion(request: AgentPublicationRequest): PublishedAgentVersion {
  if (request.actionCapable) {
    if (request.activation === undefined) {
      throw new AgentPublicationError("eval_evidence_missing", "activation");
    }
    if (request.evalReportDigest === undefined) {
      throw new AgentPublicationError("eval_evidence_missing", "evalReportDigest");
    }
    if (request.activation.decision === "blocked") {
      throw new AgentPublicationError("activation_blocked", request.activation.reason);
    }
  }

  const exceptionId =
    request.activation?.decision === "allowed" ? (request.activation.exceptionId ?? null) : null;

  return {
    status: "published",
    agentId: request.agentId,
    version: request.version,
    actionCapable: request.actionCapable,
    evalReportDigest: request.evalReportDigest ?? null,
    exceptionId,
    publishedBy: request.publishedBy,
  };
}
