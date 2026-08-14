import { canonicalHash } from "@tulipfarm/schema";
import {
  type InstructionPrecedence,
  NON_COMPACTABLE_PRECEDENCE,
  precedenceRank,
} from "./precedence";

/** Manifest records evidence and digests only; never Message text, source text, or CoT. */

export type ContextEntryKind =
  | "message"
  | "summary"
  | "memory"
  | "knowledge"
  | "state_output"
  | "instruction";

export type ContextTaint = "trusted" | "untrusted";

export interface ContextAuthorization {
  readonly decision: "allow" | "deny";
  readonly reason?: string;
}

export interface ContextProvenance {
  readonly sourceRef: string;
  readonly revision?: string;
}

/** One authorization-checked source offered to the Agent for this State. */
export interface ContextCandidate {
  readonly sourceId: string;
  readonly kind: ContextEntryKind;
  readonly precedence: InstructionPrecedence;
  readonly version: string;
  readonly classification: string;
  readonly taint: ContextTaint;
  readonly authorization: ContextAuthorization;
  readonly tokens: number;
  /** Digest of the referenced content. The content itself never enters the manifest. */
  readonly digest: string;
  readonly provenance?: ContextProvenance;
  /** For `summary` entries: the source ids this summary was derived from. */
  readonly summarizes?: readonly string[];
}

export interface ContextEntry {
  readonly sourceId: string;
  readonly kind: ContextEntryKind;
  readonly precedence: InstructionPrecedence;
  readonly version: string;
  readonly classification: string;
  readonly taint: ContextTaint;
  readonly tokens: number;
  readonly digest: string;
  readonly provenance?: ContextProvenance;
  readonly summarizes?: readonly string[];
}

export type ContextExclusionReason =
  | "unauthorized"
  | "summary_source_unauthorized"
  | "context_budget"
  | string;

export interface ContextExclusion {
  readonly sourceId: string;
  readonly reason: ContextExclusionReason;
}

export interface ContextManifest {
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly entries: readonly ContextEntry[];
  readonly excluded: readonly ContextExclusion[];
  readonly totalTokens: number;
  /** Strictest taint present; an untrusted source taints the whole Context. */
  readonly taint: ContextTaint;
  readonly guardrailDigest: string;
  readonly bundleDigest: string;
  readonly digest: string;
}

export interface AssembleContextInput {
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly candidates: readonly ContextCandidate[];
  readonly guardrailDigest: string;
  readonly bundleDigest: string;
  readonly budgetTokens: number;
}

export type ContextAssemblyErrorCode =
  | "context_budget_exceeded"
  | "unknown_precedence"
  | "missing_guardrail_digest";

/** Assembly denial. Carries the reason code only — never a source, prompt, or Context payload. */
export class ContextAssemblyError extends Error {
  readonly name = "ContextAssemblyError";

  constructor(readonly code: ContextAssemblyErrorCode) {
    super(code);
  }
}

/** Classification strength, weakest first. A summary inherits the strongest of its sources. */
const CLASSIFICATION_RANK: Readonly<Record<string, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

function strongestClassification(values: readonly string[]): string {
  return values.reduce((strongest, value) =>
    (CLASSIFICATION_RANK[value] ?? Number.MAX_SAFE_INTEGER) >
    (CLASSIFICATION_RANK[strongest] ?? Number.MAX_SAFE_INTEGER)
      ? value
      : strongest
  );
}

function toEntry(candidate: ContextCandidate): ContextEntry {
  // Only the declared manifest fields are copied, so a caller cannot smuggle source content or
  // reasoning into the recorded Context by adding extra properties to a candidate.
  const entry: ContextEntry = {
    sourceId: candidate.sourceId,
    kind: candidate.kind,
    precedence: candidate.precedence,
    version: candidate.version,
    classification: candidate.classification,
    taint: candidate.taint,
    tokens: candidate.tokens,
    digest: candidate.digest,
  };
  return {
    ...entry,
    ...(candidate.provenance === undefined ? {} : { provenance: candidate.provenance }),
    ...(candidate.summarizes === undefined ? {} : { summarizes: candidate.summarizes }),
  };
}

/** Summary entries cannot bypass ACL; unauthorized sources drop the summary too. */
export function assembleContext(input: AssembleContextInput): ContextManifest {
  if (input.guardrailDigest.length === 0) {
    throw new ContextAssemblyError("missing_guardrail_digest");
  }

  const excluded: ContextExclusion[] = [];
  const authorized: ContextCandidate[] = [];

  for (const candidate of input.candidates) {
    if (precedenceRank(candidate.precedence) === undefined) {
      throw new ContextAssemblyError("unknown_precedence");
    }
    // Missing, stale, or unverifiable authorization denies (SPEC §12 default deny).
    if (candidate.authorization?.decision !== "allow") {
      excluded.push({
        sourceId: candidate.sourceId,
        reason: candidate.authorization?.reason ?? "unauthorized",
      });
      continue;
    }
    authorized.push(candidate);
  }

  const byId = new Map(authorized.map((candidate) => [candidate.sourceId, candidate]));
  const retained: ContextCandidate[] = [];
  for (const candidate of authorized) {
    if (candidate.kind !== "summary") {
      retained.push(candidate);
      continue;
    }
    const sources = (candidate.summarizes ?? []).map((sourceId) => byId.get(sourceId));
    if (sources.length === 0 || sources.some((source) => source === undefined)) {
      excluded.push({ sourceId: candidate.sourceId, reason: "summary_source_unauthorized" });
      continue;
    }
    const resolved = sources as ContextCandidate[];
    retained.push({
      ...candidate,
      // The summary can never be less tainted or less classified than what it summarizes.
      taint: resolved.some((source) => source.taint === "untrusted")
        ? "untrusted"
        : candidate.taint,
      classification: strongestClassification([
        candidate.classification,
        ...resolved.map((source) => source.classification),
      ]),
    });
  }

  const ordered = retained
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      const rank =
        (precedenceRank(left.candidate.precedence) as number) -
        (precedenceRank(right.candidate.precedence) as number);
      return rank !== 0 ? rank : left.index - right.index;
    })
    .map(({ candidate }) => candidate);

  const kept: ContextCandidate[] = [];
  let totalTokens = 0;
  // Compaction drops from the lowest precedence upward; safety and Guardrail levels never drop.
  for (const candidate of ordered) {
    if (totalTokens + candidate.tokens <= input.budgetTokens) {
      kept.push(candidate);
      totalTokens += candidate.tokens;
      continue;
    }
    if (NON_COMPACTABLE_PRECEDENCE.includes(candidate.precedence)) {
      throw new ContextAssemblyError("context_budget_exceeded");
    }
    excluded.push({ sourceId: candidate.sourceId, reason: "context_budget" });
  }

  const entries = kept.map(toEntry);
  const taint: ContextTaint = entries.some((entry) => entry.taint === "untrusted")
    ? "untrusted"
    : "trusted";

  return Object.freeze({
    businessId: input.businessId,
    runId: input.runId,
    stateId: input.stateId,
    entries: Object.freeze(entries),
    excluded: Object.freeze(excluded),
    totalTokens,
    taint,
    guardrailDigest: input.guardrailDigest,
    bundleDigest: input.bundleDigest,
    digest: canonicalHash({
      entries,
      guardrailDigest: input.guardrailDigest,
      bundleDigest: input.bundleDigest,
    }),
  });
}
