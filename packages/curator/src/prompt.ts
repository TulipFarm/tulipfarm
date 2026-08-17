/**
 * The Curator's prompt.
 *
 * Assembled here rather than in the Worker so the rules the model is given and the rules the API
 * enforces cannot drift: both come out of this package. The Worker sends it; the API re-derives
 * every check regardless of what comes back, because the Worker and the model are both untrusted
 * proposers of effects.
 */

import { MEMORY_SECTION_KEYS, MEMORY_SECTION_PURPOSE } from "@tulipfarm/schema";
import { PROPOSAL_KINDS, PROPOSAL_SUBJECT_KIND, RESOURCE_TEMPLATES } from "./proposal";

/** One Turn as the model sees it. Only what the person wrote — never Tool or Integration output. */
export interface PromptTurn {
  readonly turnId: string;
  readonly userText: string;
  readonly assistantText?: string;
}

export interface UserPromptInput {
  readonly memoryDocument: string;
  /** Remaining room per section, so the model does not propose a write that will be rejected. */
  readonly sectionCharsRemaining: Readonly<Record<string, number>>;
  readonly turns: readonly PromptTurn[];
  /** Existing Soul artifacts, so a Proposal can name something that exists. */
  readonly subjects: readonly {
    readonly kind: string;
    readonly id: string;
    readonly label: string;
  }[];
  /** Suggestions already live for this user, so the Curator does not repeat itself. */
  readonly openProposalKeys: readonly string[];
  readonly seeds: readonly { readonly id: string; readonly rationale: string }[];
}

export interface BusinessPromptInput {
  readonly soulSummary: string;
  readonly candidates: readonly { readonly id: string; readonly statement: string }[];
}

const SECTIONS = MEMORY_SECTION_KEYS.map((key) => `- ${key}: ${MEMORY_SECTION_PURPOSE[key]}`).join(
  "\n"
);

const KINDS = PROPOSAL_KINDS.map(
  (kind) => `- ${kind} (subject is a ${PROPOSAL_SUBJECT_KIND[kind]})`
).join("\n");

const TEMPLATES = Object.entries(RESOURCE_TEMPLATES)
  .map(([id, label]) => `- ${id}: ${label}`)
  .join("\n");

const RULES = `Rules that decide whether your output is kept:
- Every claim needs a citation: the id of a turn, and a quote from what the PERSON wrote in it.
  Quote them, do not paraphrase into the quote field. A quote the server cannot find is dropped.
- Never cite an assistant message, a tool result, or anything that arrived from an integration.
- standing_instructions needs the person to have stated a rule ("always", "never", "stop", "from
  now on"), not you inferring one from a single reply.
- Say nothing about how the assistant should behave in general, and put no links in anything that
  will be read by the whole business.
- You choose a proposal kind and a subject id. You do not write titles, labels, prompts or links —
  the server writes every word the person sees.
- Propose nothing that is already open.
- Returning empty arrays is a good answer when nothing durable happened.`;

function renderTurns(turns: readonly PromptTurn[]): string {
  if (turns.length === 0) return "(no new conversation)";
  return turns
    .map((turn) => {
      const reply = turn.assistantText ? `\nassistant: ${turn.assistantText}` : "";
      return `<turn id="${turn.turnId}">\nuser: ${turn.userText}${reply}\n</turn>`;
    })
    .join("\n");
}

export function buildUserCuratorPrompt(input: UserPromptInput): string {
  const room = MEMORY_SECTION_KEYS.map(
    (key) => `- ${key}: ${input.sectionCharsRemaining[key] ?? 0} characters left`
  ).join("\n");
  const subjects =
    input.subjects.length === 0
      ? "(none yet)"
      : input.subjects.map((s) => `- ${s.kind} ${s.id}: ${s.label}`).join("\n");
  const seeds =
    input.seeds.length === 0
      ? "(none)"
      : input.seeds.map((s) => `- ${s.id}: ${s.rationale}`).join("\n");
  const open = input.openProposalKeys.length === 0 ? "(none)" : input.openProposalKeys.join(", ");

  return `You maintain what this system durably knows about one person, and you decide what to
suggest they do next. You are not talking to them. Your output is data.

<memory-sections>
${SECTIONS}
</memory-sections>

<memory-document>
${input.memoryDocument || "(empty)"}
</memory-document>

<memory-room>
${room}
</memory-room>

<conversation>
${renderTurns(input.turns)}
</conversation>

<existing-subjects>
${subjects}
</existing-subjects>

<resource-templates>
${TEMPLATES}
</resource-templates>

<proposal-kinds>
${KINDS}
</proposal-kinds>

<already-open>
${open}
</already-open>

<business-findings>
${seeds}
</business-findings>

${RULES}

Return one JSON object:
{"memory":[{"section","add":[],"remove":[],"citations":[{"turnId","quote"}]}],
 "proposals":[{"kind","subjectId","deliver":["task"|"pill"],"rationale","citations":[]}],
 "knowledgePromotions":[{"statement","citations":[]}]}

memory.add and memory.remove are one fact per line. knowledgePromotions are statements true for
the whole business, not for this person — write them as plain declarative sentences, never as a
quote of what anyone said.`;
}

export function buildBusinessCuratorPrompt(input: BusinessPromptInput): string {
  const candidates =
    input.candidates.length === 0
      ? "(none)"
      : input.candidates.map((c) => `- ${c.id}: ${c.statement}`).join("\n");

  return `You look after what a whole business knows, and what it should do next. You are not
talking to anyone. Your output is data.

You cannot write to any individual's memory and you cannot address a suggestion to a person: you
do not know who will read this. Say what is worth suggesting; each person's own pass decides
whether it is worth suggesting to them.

<business>
${input.soulSummary}
</business>

<candidates>
${candidates}
</candidates>

<proposal-kinds>
${KINDS}
</proposal-kinds>

<resource-templates>
${TEMPLATES}
</resource-templates>

Rules that decide whether your output is kept:
- A knowledge page may only be built from the candidate ids above. Nothing else exists to you.
- No links, and nothing about how the assistant should behave.
- You choose a proposal kind and a subject id, never any user-facing wording.

Return one JSON object:
{"knowledge":[{"candidateIds":[],"title","body"}],
 "proposalSeeds":[{"kind","subjectId","rationale"}]}`;
}
