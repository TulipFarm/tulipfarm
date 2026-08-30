/**
 * The Curator's model output contract.
 *
 * Two schemas rather than one union: a user Run and a business Run may emit disjoint things, and a
 * union's validation errors would not say which branch failed — but "why was this output rejected"
 * is a metric the loop is judged on. The scopes are also asymmetric on purpose. A business Run
 * aggregates several people, so it cannot name an audience and therefore cannot emit a Proposal or
 * touch anyone's Memory; each user's own Run decides what a business-wide finding means for them.
 */

import { ajv, MEMORY_SECTION_KEYS } from "@tulipfarm/schema";
import {
  PROPOSAL_DELIVERIES,
  PROPOSAL_KINDS,
  type ProposalDelivery,
  type ProposalKind,
} from "./proposal";

/** Evidence for one claim: a quote the server must find in the exact Turn it names. */
export interface CuratorCitation {
  readonly turnId: string;
  readonly quote: string;
}

export interface CuratorMemoryPatch {
  readonly section: string;
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
  readonly citations: readonly CuratorCitation[];
}

export interface CuratorProposal {
  readonly kind: ProposalKind;
  readonly subjectId: string;
  readonly deliver: readonly ProposalDelivery[];
  /** Shown to operators, never executed and never rendered to the subject user. */
  readonly rationale: string;
  readonly citations: readonly CuratorCitation[];
}

/** A declarative statement worth the whole business, sanitized out of one user's conversation. */
export interface CuratorKnowledgePromotion {
  readonly statement: string;
  readonly citations: readonly CuratorCitation[];
}

export interface CuratorUserOutput {
  readonly memory: readonly CuratorMemoryPatch[];
  readonly proposals: readonly CuratorProposal[];
  readonly knowledgePromotions: readonly CuratorKnowledgePromotion[];
}

/** A business-wide page. Its identity comes from the candidates it was built from, not its title. */
export interface CuratorKnowledgePage {
  readonly candidateIds: readonly string[];
  readonly title: string;
  readonly body: string;
}

/** Audience-free: the business Run says what is worth suggesting, not to whom. */
export interface CuratorProposalSeed {
  readonly kind: ProposalKind;
  readonly subjectId: string;
  readonly rationale: string;
}

export interface CuratorBusinessOutput {
  readonly knowledge: readonly CuratorKnowledgePage[];
  readonly proposalSeeds: readonly CuratorProposalSeed[];
}

const ID = { type: "string", minLength: 1, maxLength: 200 } as const;

const CITATIONS = {
  type: "array",
  minItems: 1,
  maxItems: 10,
  items: {
    type: "object",
    required: ["turnId", "quote"],
    additionalProperties: false,
    properties: { turnId: ID, quote: { type: "string", minLength: 8, maxLength: 500 } },
  },
} as const;

// `minItems: 0`, not 1: a model that has nothing to add or remove naturally emits `[]` rather than
// omitting the key, and an empty list is semantically identical to an absent one — the parser
// below drops a patch that ends up with neither, so `minItems: 1` here would only ever discard a
// well-formed sibling entry (e.g. a valid `add`) sharing the same output object.
const ENTRIES = {
  type: "array",
  minItems: 0,
  maxItems: 20,
  items: { type: "string", minLength: 1, maxLength: 500 },
} as const;

export const CURATOR_USER_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    memory: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        required: ["section", "citations"],
        additionalProperties: false,
        properties: {
          section: { type: "string", enum: [...MEMORY_SECTION_KEYS] },
          add: ENTRIES,
          remove: ENTRIES,
          citations: CITATIONS,
        },
      },
    },
    proposals: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        required: ["kind", "subjectId", "deliver", "rationale", "citations"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: [...PROPOSAL_KINDS] },
          subjectId: ID,
          deliver: {
            type: "array",
            minItems: 1,
            maxItems: 2,
            uniqueItems: true,
            items: { type: "string", enum: [...PROPOSAL_DELIVERIES] },
          },
          rationale: { type: "string", minLength: 1, maxLength: 500 },
          citations: CITATIONS,
        },
      },
    },
    knowledgePromotions: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        required: ["statement", "citations"],
        additionalProperties: false,
        properties: {
          statement: { type: "string", minLength: 1, maxLength: 500 },
          citations: CITATIONS,
        },
      },
    },
  },
};

export const CURATOR_BUSINESS_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    knowledge: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        required: ["candidateIds", "title", "body"],
        additionalProperties: false,
        properties: {
          candidateIds: { type: "array", minItems: 1, maxItems: 50, items: ID },
          title: { type: "string", minLength: 1, maxLength: 120 },
          body: { type: "string", minLength: 1, maxLength: 8000 },
        },
      },
    },
    proposalSeeds: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        required: ["kind", "subjectId", "rationale"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: [...PROPOSAL_KINDS] },
          subjectId: ID,
          rationale: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
  },
};

const validateUser = ajv.compile(CURATOR_USER_OUTPUT_SCHEMA);
const validateBusiness = ajv.compile(CURATOR_BUSINESS_OUTPUT_SCHEMA);

export type CuratorOutputRejection =
  | { readonly reason: "unparsable" }
  | { readonly reason: "schema"; readonly detail: string };

export type CuratorParseResult<T> =
  | { readonly ok: true; readonly output: T }
  | { readonly ok: false; readonly rejection: CuratorOutputRejection };

function asObject(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === "string") {
    try {
      return asObject(JSON.parse(raw));
    } catch {
      // Unparseable model output is a rejection, not a fault: the caller turns `undefined` into a
      // typed `{reason:"schema"}` rejection, so the parse error carries nothing the caller lacks.
      return undefined;
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

function firstError(errors: unknown): string {
  const list = errors as { instancePath?: string; message?: string }[] | null | undefined;
  const head = list?.[0];
  if (!head) return "invalid";
  return `${head.instancePath || "/"} ${head.message ?? "invalid"}`.trim();
}

/**
 * Absent arrays become empty ones so every caller handles one shape. "The model proposed nothing"
 * is a legitimate and common answer, so it is not an error — but a Run that returned no *object*
 * at all is, because that means the model ignored the contract rather than declining to act.
 */
export function parseCuratorUserOutput(raw: unknown): CuratorParseResult<CuratorUserOutput> {
  const value = asObject(raw);
  if (!value) return { ok: false, rejection: { reason: "unparsable" } };
  if (!validateUser(value)) {
    return { ok: false, rejection: { reason: "schema", detail: firstError(validateUser.errors) } };
  }
  const output = value as unknown as Partial<CuratorUserOutput>;
  // `patch.add || patch.remove` would keep a patch whose array is present but empty, since `[]` is
  // truthy — check length so an empty-both patch is dropped as the no-op it is.
  const memory = (output.memory ?? []).filter(
    (patch) => (patch.add?.length ?? 0) > 0 || (patch.remove?.length ?? 0) > 0
  );
  return {
    ok: true,
    output: {
      memory,
      proposals: output.proposals ?? [],
      knowledgePromotions: output.knowledgePromotions ?? [],
    },
  };
}

export function parseCuratorBusinessOutput(
  raw: unknown
): CuratorParseResult<CuratorBusinessOutput> {
  const value = asObject(raw);
  if (!value) return { ok: false, rejection: { reason: "unparsable" } };
  if (!validateBusiness(value)) {
    return {
      ok: false,
      rejection: { reason: "schema", detail: firstError(validateBusiness.errors) },
    };
  }
  const output = value as unknown as Partial<CuratorBusinessOutput>;
  return {
    ok: true,
    output: { knowledge: output.knowledge ?? [], proposalSeeds: output.proposalSeeds ?? [] },
  };
}
