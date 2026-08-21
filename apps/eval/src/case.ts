import type {
  AssembleContext,
  ExposedTool,
  ModelMessage,
  ModelOutput,
} from "@tulipfarm/agent-runtime";
import type { RedTeam } from "./red-team.ts";

/**
 * One deterministic, model-free check against a Trial's observation.
 *
 * Expectations are data, never functions, so a Corpus can be content-hashed and a Case can be
 * authored without writing code.
 */
export type Expectation =
  /** The assembled system prompt contains this text — the only check that proves the real Context
   *  assembler ran, rather than a hand-written prompt being fed to the loop. */
  | { readonly kind: "prompt_contains"; readonly text: string }
  | { readonly kind: "prompt_attaches"; readonly fileId: string }
  | { readonly kind: "prompt_omits_attachment"; readonly fileId: string }
  | { readonly kind: "prompt_omits"; readonly text: string }
  | { readonly kind: "tool_called"; readonly name: string }
  | { readonly kind: "tool_not_called"; readonly name: string }
  /** The named Tools were called in this relative order; unnamed calls between them are ignored. */
  | { readonly kind: "tool_call_order"; readonly names: readonly string[] }
  | {
      readonly kind: "tool_argument_equals";
      readonly name: string;
      readonly path: string;
      readonly value: unknown;
    }
  | { readonly kind: "output_contains"; readonly text: string; readonly ungrounded?: string }
  | { readonly kind: "output_matches"; readonly pattern: string; readonly ungrounded?: string }
  /** The answer does not contain this text. The one way to assert a guard actually removed
   *  something, rather than merely that it recorded a refusal.
   *
   *  The text must be grounded — something the model was given and could have repeated — or the
   *  expectation passes with the guard deleted. `ungrounded` states why not, for the rarer Case
   *  asserting the model must not *invent* something. */
  | { readonly kind: "output_omits"; readonly text: string; readonly ungrounded?: string }
  | { readonly kind: "output_field_equals"; readonly path: string; readonly value: unknown }
  | { readonly kind: "loop_status"; readonly status: string }
  | { readonly kind: "tool_call_count"; readonly count: number }
  /** A guard refused at this stage. Naming the guard pins *which* rule fired, not merely that one
   *  did — a Case that only asserted "something blocked" would go on passing after the policy was
   *  replaced by a stricter unrelated rule. */
  | { readonly kind: "guardrail_blocked"; readonly stage: string; readonly guard: string }
  /** Prose quality the deterministic Expectations cannot reach, scored by a pinned third-vendor
   *  Judge against explicit criteria. Use only where `===` genuinely cannot do the job — a rubric
   *  is slower, costs money and is less reproducible than a string check. */
  | {
      readonly kind: "rubric_score";
      readonly criteria: readonly string[];
      /** The lowest score on the fixed 1–5 scale that still passes. */
      readonly min: number;
    }
  /** The safety variant: one question, answered, rather than a quality rating. */
  | { readonly kind: "rubric_denies"; readonly question: string }
  /** No guard refused at this stage. This is what catches an over-eager guardrail: the Case fails
   *  when a stage that should have let a benign turn through starts refusing it. */
  | { readonly kind: "guardrail_allowed"; readonly stage: string }
  /** L3 only. The Run's terminal status, as the Run kernel recorded it. */
  | { readonly kind: "run_status"; readonly status: string }
  /** L3 only. The `invoke` State's terminal status — a Turn that answered but left its State
   *  parked is a Run the reconciler will pick up, not a finished turn. */
  | { readonly kind: "state_status"; readonly status: string }
  /** L3 only. The Turn was completed, and with this verdict. */
  | { readonly kind: "turn_status"; readonly status: string }
  /** L3 only. This Run event type was appended durably. L2 stubs the event port, so this is the
   *  only place a Turn that stopped emitting its events can be caught. */
  | { readonly kind: "run_event_emitted"; readonly eventType: string }
  /** L3 only. A Soul artifact was committed to the Eval Soul's real git repository. */
  | { readonly kind: "soul_committed"; readonly path: string }
  /**
   * L3 only. The Runtime is serving this artifact, written `Kind:slug`.
   *
   * Committing is not publishing: an artifact only reaches a product surface once its bundle is the
   * active publication. Pair it with `soul_committed` — a write that commits and never activates
   * passes the commit Expectation while remaining invisible to every user.
   */
  | { readonly kind: "soul_published"; readonly artifact: string }
  /**
   * L3 only. A File the Turn generated is readable by this grantee, written `kind:id`.
   *
   * The audience is not in the Tool call — the model neither chooses it nor sees it — so this is
   * the only Expectation that can tell "an Agent wrote a document" apart from "a team can open the
   * document their Agent wrote".
   */
  | { readonly kind: "generated_file_readable_by"; readonly grantee: string }
  /** L3 only. The counterpart: the audience widened this far and no further. */
  | { readonly kind: "generated_file_not_readable_by"; readonly grantee: string }
  /** L3 only. A validated Curator Proposal reached its participant as a Task. */
  | { readonly kind: "curator_task_visible"; readonly title: string };

/** Expectations that read persisted state, which only the L3 tier can observe. */
const PERSISTED_KINDS: ReadonlySet<string> = new Set([
  "run_status",
  "state_status",
  "turn_status",
  "run_event_emitted",
  "soul_committed",
  "soul_published",
  "generated_file_readable_by",
  "generated_file_not_readable_by",
  "curator_task_visible",
]);

export function isPersisted(expectation: Expectation): boolean {
  return PERSISTED_KINDS.has(expectation.kind);
}

/**
 * Expectations that read guardrail decisions, which only the L2 tier collects.
 *
 * L3 really does run the guards — the executor calls them — but it does not surface their
 * decisions, so `guardrail_allowed` would pass by finding nothing rather than by the guard having
 * allowed anything.
 */
export function isGuardrail(expectation: Expectation): boolean {
  return expectation.kind.startsWith("guardrail_");
}

/** A faked Tool dispatch, matched to a call by Tool name and consumed in order. */
export interface ScriptedToolResult {
  readonly name: string;
  readonly output?: unknown;
  /** Present to script a Tool that fails, so refusal and recovery behaviour can be measured. */
  readonly error?: string;
}

/**
 * One Turn of a multi-Turn journey, in the same vocabulary a single-Turn Case already uses.
 *
 * Reusing `input`, `script` and `toolResults` rather than inventing journey-specific names keeps
 * the Case format one format: a journey Turn is a Case's Turn, not a new kind of thing.
 */
export interface JourneyTurn {
  readonly input: readonly ModelMessage[];
  readonly toolResults?: readonly ScriptedToolResult[];
  readonly script?: readonly ModelOutput[];
}

/**
 * A File a Case makes available to its Turn.
 *
 * Carries no bytes: the runner synthesises them, because what a Case is asserting is whether a
 * File *reached* the prompt, and a base64 blob in the Corpus would make every such Case expensive
 * to read and review without making the assertion any stronger.
 */
/**
 * Every string anywhere in `value`.
 *
 * Serializing and searching the JSON would be shorter and wrong: `JSON.stringify` escapes quotes
 * and newlines, so a payload containing either would not match text it is genuinely present in.
 */
export function everyString(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const item of value) everyString(item, found);
  else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) everyString(item, found);
  }
  return found;
}

export interface CaseAttachment {
  readonly fileId: string;
  readonly mediaType: string;
  readonly name: string;
  /**
   * The File's actual bytes, as text.
   *
   * Only needed when the Case turns on what is *inside* the File — a red-team payload hidden in an
   * attachment, say. Without it the bytes are a deterministic stand-in, which is enough for a Case
   * that only asserts a File reached the prompt, and cheaper to review.
   */
  readonly content?: string;
}

function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * A minimal single-page PDF whose text layer is `text`, byte-exact down to the xref table.
 *
 * A real model reading a `application/pdf` attachment runs an actual PDF parser, not a text
 * decoder — bytes that are just `text` encoded as UTF-8 read to it as a corrupt document, not a
 * document with no answer. `content` only ever carries plain ASCII in this Corpus, so the JS
 * string length used for the offsets below equals the UTF-8 byte length; a non-ASCII Case would
 * need this rewritten to measure encoded bytes instead.
 */
function synthesizePdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td\n(${escapePdfText(text)}) Tj\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

/**
 * The bytes a Case's File carries.
 *
 * A Case that only asserts whether a File *reached* the prompt does not care what is in it, and
 * real bytes in the Corpus would cost review effort for no signal — so those get a stand-in
 * derived from the id, keeping a Sweep reproducible. A Case that declares `content` gets exactly
 * that, because an attack the model never receives would make the Case pass by vacuity. A
 * `content` declared under `mediaType: "application/pdf"` gets that text wrapped in a real PDF
 * rather than sent raw, because a real model parses the bytes as a document, not as text.
 */
export function synthesizeAttachment(file: CaseAttachment): CaseAttachment & { data: Uint8Array } {
  if (file.content !== undefined && file.mediaType === "application/pdf") {
    return { ...file, data: synthesizePdf(file.content) };
  }
  const bytes = file.content ?? `eval-bytes:${file.fileId}`;
  return { ...file, data: new TextEncoder().encode(bytes) };
}

export interface EvalCase {
  readonly id: string;
  /**
   * `l2` drives the Agent loop directly; `l3` drives the product's own Chat executor against a real
   * database. Nearly all the signal is at L2, and L3 is deliberately small — it exists to prove the
   * Run lifecycle around the loop, which L2 stubs and therefore cannot notice breaking.
   */
  readonly tier: "l2" | "l3";
  readonly agent: string;
  /** What feeds the real Context assembler. The assembler's output is what the model sees. */
  readonly context: AssembleContext;
  readonly input: readonly ModelMessage[];
  /** A deterministic Curator response applied after the L3 Chat Turn settles. */
  readonly curator?: { readonly output: unknown };
  /**
   * The Files resolved for *this* Turn, as the Context assembler would resolve them.
   *
   * A file part in `input` that no entry here names carries no bytes and reaches no provider —
   * which is exactly how a File stays confined to the Turn it was attached to.
   */
  readonly attachments?: readonly CaseAttachment[];
  /**
   * Files the library holds that this Turn did *not* send — what `file_read` can go and fetch.
   *
   * The counterpart to `attachments`, and the reason confinement is a saving rather than data
   * loss: a document from three Turns ago is here, reachable by a Tool call, without riding every
   * prompt in between. A Case that asserts re-reading must put its File here and not in
   * `attachments`, or the bytes were present from the first step and the Case proves nothing.
   */
  readonly readable?: readonly CaseAttachment[];
  readonly tools?: readonly ExposedTool[];
  /**
   * Platform Tools exposed as the product actually declares them, named rather than copied.
   *
   * Use this for any Tool the product ships. A copy in `tools` measures the model against a
   * description no deployment sends, and cannot assert the properties that live in the
   * declaration itself.
   */
  readonly platformTools?: readonly string[];
  readonly toolResults?: readonly ScriptedToolResult[];
  /**
   * Model outputs replayed in order by the scripted binding.
   *
   * Ignored entirely by a real-model binding. It exists so the whole Corpus stays runnable for
   * free and deterministically in ordinary CI, which is what lets a contributor without
   * credentials develop the framework.
   */
  readonly script?: readonly ModelOutput[];
  /**
   * L3 only. Further Turns run against the same Conversation, database and Soul as `input`.
   *
   * This exists for one seam a single Turn cannot reach: whether what a Turn *committed* is what
   * the next Turn can *see*. Everything else a journey appears to test — history, ordering — is
   * carried more cheaply by an L2 Case, so keep journeys rare.
   */
  readonly journey?: readonly JourneyTurn[];
  /**
   * L3 only. Breaks one of the executor's dependencies, so a Case can measure what the Turn does
   * when its surroundings fail rather than when the model does.
   *
   * Every tier otherwise hands the executor working ports, which means the Corpus can only observe
   * a Turn that got as far as the loop. A Turn abandoned *before* the loop — Context unreadable,
   * Soul unreachable — is the one failure a participant can neither see nor retry, so it is worth
   * the one knob it takes to reach it. `"context"` fails Context resolution.
   */
  readonly fault?: "context";
  /**
   * L3 only. Roles an admin has assigned this Case's Agent, seeded as `role_assignments` rows.
   *
   * Deliberately not read from the Agent's Soul `roles:` list. That list is advisory metadata and
   * creates no assignment — `reconcileSoulRoles` projects Role *definitions* only — so a fixture
   * that read it would measure a mapping the product does not have, and would go on passing after
   * live authority stopped reaching Files. These are the rows `/business/access/agents` writes.
   */
  readonly agentRoles?: readonly string[];
  readonly expect: readonly Expectation[];
  /** Raised above 1 only for Cases used to measure the Noise Floor. */
  readonly trials?: number;
  /** Present only on Cases in `corpus/red-team/`. Declares which of the two good endings this
   *  Case asserts, which decides whether it gates the release or is reported as a rate. */
  readonly redTeam?: RedTeam;
}

export const LOOP_LIMITS = {
  maxIterations: 8,
  maxToolCalls: 16,
  maxRepairAttempts: 2,
} as const;

/**
 * Expectation kinds a Judge answers rather than the deterministic scorer.
 *
 * Lives here rather than beside either scorer so both can import it without a cycle.
 */
export function isJudged(a: Expectation): boolean {
  return a.kind === "rubric_score" || a.kind === "rubric_denies";
}

/**
 * The File library this Case's Agent can reach with `file_read`, as the loop dependency.
 *
 * Stands in for the store the control plane would serve. Absent — not empty — when the Case
 * declares no `readable` File, because an empty port would let the loop believe it asked and got
 * nothing, which is the answer a Case asserting confinement is trying to distinguish.
 */
export function readableLibrary(evalCase: EvalCase): {
  attachments?: { read: (runId: string, fileId: string) => Promise<Uint8Array | undefined> };
} {
  const library = new Map(
    (evalCase.readable ?? []).map((file) => [file.fileId, synthesizeAttachment(file).data])
  );
  if (library.size === 0) return {};
  return { attachments: { read: async (_runId, fileId) => library.get(fileId) } };
}
