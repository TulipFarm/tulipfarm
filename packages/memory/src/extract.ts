/** Extraction proposes inferred Pending Memory only; candidates are statements, not instructions. */

import type { MemoryDeps, MemoryTrustTier, MemoryType } from "./memory";
import { type RememberRequest, type RememberResult, rememberMemory } from "./remember";
import type { MemoryScopeRequest, MemoryScopeTarget } from "./scope";
import {
  endMemorySpan,
  MEMORY_METRICS,
  MEMORY_SPANS,
  recordMemoryCounter,
  setMemorySpanAttributes,
  startMemorySpan,
} from "./telemetry";

/** The longest statement worth storing. Beyond this it is a summary, not a fact. */
export const MAX_CANDIDATE_STATEMENT_CHARS = 256;
/** The longest subject worth storing — a short noun phrase, not a sentence. */
export const MAX_CANDIDATE_SUBJECT_CHARS = 64;
/** High confidence threshold: bad candidates create review toil, and ignored queues are worse. */
export const MIN_CANDIDATE_CONFIDENCE = 0.6;

/** One statement an extractor believes is worth remembering. Not yet screened, never yet durable. */
export interface MemoryCandidate {
  readonly subject: string;
  readonly statement: string;
  /** Defaults to `fact`. `procedural` is refused — procedural memory comes from explicit
   * correction, not from inference. */
  readonly memoryType?: MemoryType;
  readonly confidence: number;
  readonly importance?: number;
  readonly entities?: readonly string[];
}

/** What the extractor is given. Deliberately just text plus attribution — no store access. */
export interface MemoryExtractionInput {
  readonly businessId: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}

/** Supplies candidates. Implemented in `apps/api` over the LLM abstraction. */
export interface MemoryExtractionPort {
  extract(input: MemoryExtractionInput): Promise<readonly MemoryCandidate[]>;
}

/** Injection screening is supplied by the app guardrails service, not a weaker local copy. */
export interface MemoryCandidateScreen {
  /** True when the text carries an injection attempt and must not be proposed. */
  isInjection(text: string): boolean | Promise<boolean>;
}

export type CandidateRejectionReason =
  | "empty"
  | "oversize_statement"
  | "oversize_subject"
  | "low_confidence"
  | "imperative"
  | "procedural_not_inferable"
  | "prompt_injection";

export type CandidateScreening =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: CandidateRejectionReason };

/** Directive heuristic anchors at the start and is only one defense before human review. */
const IMPERATIVE_OPENERS = [
  /^(?:please\s+)?(?:always|never|don'?t|do\s+not|avoid|make\s+sure|ensure|remember\s+to)\b/i,
  /^(?:you|the\s+assistant|the\s+agent)\s+(?:must|should|shall|will|need\s+to|have\s+to|are\s+to)\b/i,
  /^(?:ignore|disregard|forget|override|bypass|reveal|disclose|output|print|execute|run)\b/i,
  /^from\s+now\s+on\b/i,
  /^(?:instead\s+of|rather\s+than)\b.*\b(?:use|do|say|call)\b/i,
];

/** True when the statement reads as an instruction rather than a fact. */
export function isImperativeStatement(statement: string): boolean {
  const trimmed = statement.trim();
  return IMPERATIVE_OPENERS.some((pattern) => pattern.test(trimmed));
}

/** Screens one candidate cheapest-first; only injection screening is impure. */
export async function screenMemoryCandidate(
  candidate: MemoryCandidate,
  screen?: MemoryCandidateScreen
): Promise<CandidateScreening> {
  const subject = candidate.subject.trim();
  const statement = candidate.statement.trim();

  if (subject.length === 0 || statement.length === 0) {
    return { accepted: false, reason: "empty" };
  }
  if (subject.length > MAX_CANDIDATE_SUBJECT_CHARS) {
    return { accepted: false, reason: "oversize_subject" };
  }
  if (statement.length > MAX_CANDIDATE_STATEMENT_CHARS) {
    return { accepted: false, reason: "oversize_statement" };
  }
  if (candidate.confidence < MIN_CANDIDATE_CONFIDENCE) {
    return { accepted: false, reason: "low_confidence" };
  }
  // Procedural memory changes how the Agent behaves, so it is only ever taken from an explicit
  // correction a person actually made — never from something a model thought it noticed.
  if (candidate.memoryType === "procedural") {
    return { accepted: false, reason: "procedural_not_inferable" };
  }
  if (isImperativeStatement(statement)) {
    return { accepted: false, reason: "imperative" };
  }
  if (screen !== undefined && (await screen.isInjection(`${subject}: ${statement}`))) {
    return { accepted: false, reason: "prompt_injection" };
  }
  return { accepted: true };
}

export interface ProposeCandidatesRequest {
  readonly target: MemoryScopeTarget;
  readonly candidates: readonly MemoryCandidate[];
  readonly authorPrincipalId: string;
  readonly authorAgentId?: string;
  readonly runId?: string;
  /** Caller alone knows whether text was agent-inferred or externally derived. */
  readonly trustTier?: MemoryTrustTier;
  readonly evidence?: readonly { readonly kind: "message"; readonly ref: string }[];
}

export interface ProposedCandidate {
  readonly candidate: MemoryCandidate;
  readonly pendingId: string;
}

export interface RejectedCandidate {
  readonly candidate: MemoryCandidate;
  readonly reason: CandidateRejectionReason | string;
}

export interface ProposeCandidatesResult {
  readonly proposed: readonly ProposedCandidate[];
  readonly rejected: readonly RejectedCandidate[];
}

/** Extracted candidates are forced to inferred Pending Memory; disabled inferred memory returns refusals. */
export async function proposeMemoryCandidates(
  deps: MemoryDeps,
  request: ProposeCandidatesRequest,
  scopeRequest: MemoryScopeRequest,
  screen?: MemoryCandidateScreen
): Promise<ProposeCandidatesResult> {
  const span = startMemorySpan(deps.telemetry, MEMORY_SPANS.extraction, {
    scope: request.target.scope,
  });
  recordMemoryCounter(
    deps.telemetry,
    MEMORY_METRICS.extractionCandidates,
    request.candidates.length,
    {
      outcome: "received",
      scope: request.target.scope,
    }
  );
  const proposed: ProposedCandidate[] = [];
  const rejected: RejectedCandidate[] = [];

  for (const candidate of request.candidates) {
    const screening = await screenMemoryCandidate(candidate, screen);
    if (!screening.accepted) {
      recordMemoryCounter(deps.telemetry, MEMORY_METRICS.extractionScreeningRefusals, 1, {
        reason: screening.reason,
        scope: request.target.scope,
      });
      rejected.push({ candidate, reason: screening.reason });
      continue;
    }

    const remember: RememberRequest = {
      target: request.target,
      subject: candidate.subject.trim(),
      statement: candidate.statement.trim(),
      confidence: candidate.confidence,
      memoryType: candidate.memoryType ?? "fact",
      trustTier: request.trustTier ?? "agent_inferred",
      ...(candidate.importance === undefined ? {} : { importance: candidate.importance }),
      ...(candidate.entities === undefined ? {} : { entities: candidate.entities }),
      provenance: {
        origin: "inferred",
        authorPrincipalId: request.authorPrincipalId,
        ...(request.authorAgentId === undefined ? {} : { authorAgentId: request.authorAgentId }),
        ...(request.runId === undefined ? {} : { runId: request.runId }),
        evidence: request.evidence ?? [],
      },
    };

    const result: RememberResult = await rememberMemory(deps, remember, scopeRequest);
    if (result.outcome === "pending_confirmation") {
      recordMemoryCounter(deps.telemetry, MEMORY_METRICS.extractionCandidates, 1, {
        outcome: "proposed",
        scope: request.target.scope,
        memory_type: remember.memoryType ?? "fact",
        trust_tier: remember.trustTier ?? "agent_inferred",
      });
      proposed.push({ candidate, pendingId: result.pendingId });
    } else {
      recordMemoryCounter(deps.telemetry, MEMORY_METRICS.extractionScreeningRefusals, 1, {
        reason: describeRefusal(result),
        scope: request.target.scope,
      });
      rejected.push({ candidate, reason: describeRefusal(result) });
    }
  }

  setMemorySpanAttributes(span, {
    scope: request.target.scope,
    proposed: proposed.length,
    rejected: rejected.length,
  });
  endMemorySpan(span);
  return { proposed, rejected };
}

/** Refusal reason; `saved` means the pending-memory gate was bypassed and is reported. */
function describeRefusal(result: RememberResult): string {
  if (result.outcome === "denied") return result.reason;
  if (result.outcome === "saved") return "unexpected_direct_save";
  return result.outcome;
}
