/**
 * Turning model output into effects the server is willing to record.
 *
 * Everything the model said is a claim; everything here is either a claim that survived every
 * check, or a rejection with a reason. Nothing is silently dropped — "rejected, and why" is the
 * signal that says whether the loop is working, and a filter that discards quietly cannot be
 * measured or fixed.
 */

import type { MemorySectionKey } from "@tulipfarm/schema";
import {
  buildCitationIndex,
  type CitableTurn,
  type CitationRejection,
  checkCitations,
  checkSharedText,
} from "./citations";
import type { CuratorBusinessOutput, CuratorCitation, CuratorUserOutput } from "./output";
import {
  curatorDedupeKey,
  PROPOSAL_SUBJECT_KIND,
  type ProposalDelivery,
  type ProposalKind,
  type ProposalSubjectKind,
  RESOURCE_TEMPLATES,
} from "./proposal";

export type CuratorEffect =
  | {
      readonly kind: "memory_patch";
      readonly section: MemorySectionKey;
      readonly add: readonly string[];
      readonly remove: readonly string[];
      readonly citations: readonly CuratorCitation[];
    }
  | {
      readonly kind: "proposal";
      readonly proposalKind: ProposalKind;
      readonly subjectId: string;
      readonly subjectLabel: string;
      readonly deliver: readonly ProposalDelivery[];
      readonly dedupeKey: string;
      readonly rationale: string;
      readonly citations: readonly CuratorCitation[];
    }
  | {
      readonly kind: "knowledge_promotion";
      readonly statement: string;
      readonly citations: readonly CuratorCitation[];
    }
  | {
      readonly kind: "knowledge_page";
      readonly sourceKey: string;
      readonly title: string;
      readonly body: string;
      readonly candidateIds: readonly string[];
    }
  | {
      readonly kind: "proposal_seed";
      readonly proposalKind: ProposalKind;
      readonly subjectId: string;
      readonly rationale: string;
    };

export type EffectRejectionReason =
  | CitationRejection["reason"]
  | "unresolved_subject"
  | "additions_exceed_section_budget"
  | "unknown_candidate";

export interface EffectRejection {
  readonly effect: CuratorEffect["kind"];
  readonly reason: EffectRejectionReason;
  readonly detail?: string;
}

export interface CuratorPlan {
  readonly effects: readonly CuratorEffect[];
  readonly rejections: readonly EffectRejection[];
}

/** Resolves an existing Soul artifact to its display name, or `undefined` if it does not exist. */
export type SubjectResolver = (
  subjectKind: ProposalSubjectKind,
  subjectId: string
) => string | undefined;

export interface UserPlanContext {
  readonly turns: readonly CitableTurn[];
  readonly resolveSubject: SubjectResolver;
  /**
   * The live per-section ceiling. Additions alone are measured against it, never additions net of
   * removals: the Curator cannot know which removals will match, and an estimate that guessed
   * would reject writes that would in fact have fit.
   */
  readonly sectionCharBudget: number;
}

export interface BusinessPlanContext {
  /** Candidate ids pinned to this Run. A page built from anything else is not reproducible. */
  readonly candidateIds: readonly string[];
  /** Stable page identity derived from the candidates a page was built from, never its title. */
  readonly knowledgeSourceKey: (candidateIds: readonly string[]) => string;
}

/** `## Standing instructions` is replayed into every future turn, so inference is not enough. */
const DIRECTIVE_SECTION: MemorySectionKey = "standing_instructions";

function reject(effect: CuratorEffect["kind"], rejection: CitationRejection): EffectRejection {
  const detail =
    "turnId" in rejection ? rejection.turnId : "text" in rejection ? rejection.text : undefined;
  return { effect, reason: rejection.reason, ...(detail === undefined ? {} : { detail }) };
}

function resolveSubject(
  kind: ProposalKind,
  subjectId: string,
  resolver: SubjectResolver
): string | undefined {
  const subjectKind = PROPOSAL_SUBJECT_KIND[kind];
  // The menu is this package's own, so consulting it here is not something a caller can forget.
  if (subjectKind === "resource_template") return RESOURCE_TEMPLATES[subjectId];
  return resolver(subjectKind, subjectId);
}

export function planUserEffects(output: CuratorUserOutput, ctx: UserPlanContext): CuratorPlan {
  const index = buildCitationIndex(ctx.turns);
  const effects: CuratorEffect[] = [];
  const rejections: EffectRejection[] = [];

  for (const patch of output.memory) {
    const section = patch.section as MemorySectionKey;
    const add = patch.add ?? [];
    const remove = patch.remove ?? [];
    const rejection = checkCitations(index, {
      citations: patch.citations,
      claims: [...add, ...remove],
      requireDirective: section === DIRECTIVE_SECTION,
    });
    if (rejection) {
      rejections.push(reject("memory_patch", rejection));
      continue;
    }
    const addedChars = add.reduce((sum, entry) => sum + entry.length + 1, 0);
    if (addedChars > ctx.sectionCharBudget) {
      rejections.push({
        effect: "memory_patch",
        reason: "additions_exceed_section_budget",
        detail: section,
      });
      continue;
    }
    effects.push({ kind: "memory_patch", section, add, remove, citations: patch.citations });
  }

  for (const proposal of output.proposals) {
    const rejection = checkCitations(index, {
      citations: proposal.citations,
      claims: [proposal.rationale],
    });
    if (rejection) {
      rejections.push(reject("proposal", rejection));
      continue;
    }
    const subjectLabel = resolveSubject(proposal.kind, proposal.subjectId, ctx.resolveSubject);
    if (subjectLabel === undefined) {
      rejections.push({
        effect: "proposal",
        reason: "unresolved_subject",
        detail: proposal.subjectId,
      });
      continue;
    }
    effects.push({
      kind: "proposal",
      proposalKind: proposal.kind,
      subjectId: proposal.subjectId,
      subjectLabel,
      deliver: proposal.deliver,
      dedupeKey: curatorDedupeKey(proposal.kind, proposal.subjectId),
      rationale: proposal.rationale,
      citations: proposal.citations,
    });
  }

  for (const promotion of output.knowledgePromotions) {
    const rejection = checkCitations(index, {
      citations: promotion.citations,
      claims: [promotion.statement],
      shared: true,
    });
    if (rejection) {
      rejections.push(reject("knowledge_promotion", rejection));
      continue;
    }
    effects.push({
      kind: "knowledge_promotion",
      statement: promotion.statement,
      citations: promotion.citations,
    });
  }

  return { effects, rejections };
}

export function planBusinessEffects(
  output: CuratorBusinessOutput,
  ctx: BusinessPlanContext
): CuratorPlan {
  const pinned = new Set(ctx.candidateIds);
  const effects: CuratorEffect[] = [];
  const rejections: EffectRejection[] = [];

  for (const page of output.knowledge) {
    const unknown = page.candidateIds.find((id) => !pinned.has(id));
    if (unknown !== undefined) {
      rejections.push({ effect: "knowledge_page", reason: "unknown_candidate", detail: unknown });
      continue;
    }
    const unsafe = checkSharedText(page.title) ?? checkSharedText(page.body);
    if (unsafe) {
      rejections.push(reject("knowledge_page", unsafe));
      continue;
    }
    effects.push({
      kind: "knowledge_page",
      sourceKey: ctx.knowledgeSourceKey(page.candidateIds),
      title: page.title,
      body: page.body,
      candidateIds: page.candidateIds,
    });
  }

  for (const seed of output.proposalSeeds) {
    const unsafe = checkSharedText(seed.rationale);
    if (unsafe) {
      rejections.push(reject("proposal_seed", unsafe));
      continue;
    }
    effects.push({
      kind: "proposal_seed",
      proposalKind: seed.kind,
      subjectId: seed.subjectId,
      rationale: seed.rationale,
    });
  }

  return { effects, rejections };
}
