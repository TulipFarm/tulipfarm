import type {
  AssembleContext,
  ExposedTool,
  ModelMessage,
  ModelOutput,
} from "@tulipfarm/agent-runtime";
import { externalPdf, type PdfFixtureVariant } from "@tulipfarm/files/test-fixtures/pdf";
import type { GuardrailDefinition, routine, ToolContractDefinition } from "@tulipfarm/schema";
import {
  externalPptx,
  externalXlsx,
} from "../../../packages/files/src/office-fixture.test-support.ts";
import {
  type DocxFixture,
  synthesizeDocxFixture,
  synthesizeDocxRefusalFixture,
} from "./docx-fixture.ts";
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
  /**
   * The model adapter's provider-facing prompt carries this File with byte-for-byte
   * identity and the declared media metadata.
   */
  | {
      readonly kind: "provider_prompt_file_exact";
      readonly fileId: string;
      readonly part: "file" | "image";
    }
  /** No provider-facing binary part came from this declared File. */
  | { readonly kind: "provider_prompt_omits_file"; readonly fileId: string }
  /** Real L3 model input retains every PDF page and rejects partial text after an OCR refusal. */
  | {
      readonly kind: "pdf_input_accounted";
      readonly fileId: string;
      readonly pages: readonly { readonly width: number; readonly height: number }[];
      readonly text: "present" | "absent";
      readonly minimumTokens: number;
    }
  /** Grounded text in the first provider request, excluding assistant Messages. */
  | { readonly kind: "provider_prompt_contains"; readonly text: string }
  /** The model invocation boundary was observed but never called. */
  | { readonly kind: "model_not_called" }
  /** L2 only. The final model request contains model-facing Context after loop compaction. */
  | { readonly kind: "model_prompt_contains"; readonly text: string }
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
  /**
   * L3 only. A real Tool dispatch with the exact argument completed with this status and returned
   * this value. This reads the Tool result, never the assistant's later description of it.
   */
  | {
      readonly kind: "tool_result_field_equals";
      readonly name: string;
      readonly argumentPath: string;
      readonly argumentValue: unknown;
      readonly status: string;
      /** One-based journey position: the initial Turn is 1, its first follow-up is 2. */
      readonly turnIndex?: number;
      readonly outputPath: string;
      readonly value: unknown;
    }
  /** L3 only. A targeted real Tool result returned a reason containing this text. */
  | {
      readonly kind: "tool_result_reason_contains";
      readonly name: string;
      readonly argumentPath: string;
      readonly argumentValue: unknown;
      readonly status: string;
      readonly turnIndex?: number;
      readonly text: string;
    }
  /** The named Tool was denied on a call carrying this exact argument value; "$" selects all arguments. */
  | {
      readonly kind: "tool_denied";
      readonly name: string;
      readonly path: string;
      readonly value: unknown;
    }
  /**
   * The Tool was called with this argument, whatever its value.
   *
   * `tool_argument_equals` cannot stand in for this on a real model: an argument the model
   * composes in its own words has no value a Case could name in advance, so pinning one would
   * fail on phrasing rather than on behaviour.
   */
  | { readonly kind: "tool_argument_present"; readonly name: string; readonly path: string }
  | { readonly kind: "tool_argument_absent"; readonly name: string; readonly path: string }
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
  /** L3 only. Actual MCP tools/call requests observed at the external provider transport. */
  | { readonly kind: "mcp_provider_call_count"; readonly count: number }
  /**
   * At least one assistant message asked for this many Tool calls at once.
   *
   * The one thing `tool_call_count` cannot see. Four Tools called across four model round-trips and
   * four Tools called in a single message are indistinguishable by count, by order and by name —
   * yet the difference between them is most of a Turn's latency, because the loop dispatches a run
   * of consecutive read-only calls concurrently and a model that asks one question at a time pays
   * for every round-trip it did not need.
   *
   * The batch is measured rather than the loop iterations it saved, because the batch is the
   * behaviour being asserted. An iteration count also moves with how much work the Turn needed, so
   * a Case pinning it would report a batching regression whenever its fixture merely grew a step.
   */
  | { readonly kind: "tool_calls_batched"; readonly min: number }
  /**
   * L2 only. A forced checkpoint crash replayed this model-produced batch with stable call ids,
   * before another model request, while the fixture's idempotent effect seam executed each once.
   */
  | { readonly kind: "tool_batch_replayed" }
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
  /** L3 Routine only. A persisted Tool State output contains this exact value at the path. */
  | { readonly kind: "state_output_equals"; readonly path: string; readonly value: unknown }
  | { readonly kind: "native_admission_equals"; readonly path: string; readonly value: unknown }
  /** L3 only. The Turn was completed, and with this verdict. */
  | { readonly kind: "turn_status"; readonly status: string }
  /** L3 only. This Run event type was appended durably. L2 stubs the event port, so this is the
   *  only place a Turn that stopped emitting its events can be caught. */
  | {
      readonly kind: "run_event_emitted";
      readonly eventType: string;
      readonly count?: number;
    }
  /** L3 only. Concatenated durable participant text.delta payloads omit this grounded text. */
  | { readonly kind: "run_event_text_omits"; readonly text: string; readonly ungrounded?: string }
  /** L3 only. Assistant Message metadata read back from persistence has this field and value. */
  | {
      readonly kind: "persisted_message_metadata_equals";
      readonly path: string;
      readonly value: unknown;
    }
  /** L3 only. A Soul artifact was committed to the Eval Soul's real git repository. */
  | { readonly kind: "soul_committed"; readonly path: string }
  /**
   * L3 only. The Runtime is serving this artifact, written `Kind:slug`.
   *
   * Committing is not publishing: an artifact only reaches a product surface once its bundle is the
   * active publication. Pair it with `soul_committed` — a write that commits and never activates
   * passes the commit Expectation while remaining invisible to every user.
   */
  | {
      readonly kind: "soul_published" | "soul_not_published";
      readonly artifact: string;
      readonly turnIndex?: number;
    }
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
  /** L3 only. A Chat generation produced an expiring draft rather than a persistent File. */
  | { readonly kind: "generated_file_draft_created" }
  /** L3 only. The Soul Doctor repaired the named artifact and the repair reached the bundle. */
  | { readonly kind: "doctor_repaired"; readonly subject: string }
  /** L3 only. The Doctor refused to publish and put the named artifact in front of a person. */
  | { readonly kind: "doctor_escalated"; readonly subject: string }
  /**
   * L3 only. The named Tool's real dispatch was denied, and the reason it gave back contains this
   * text.
   *
   * The one place a Case can measure a real refusal's wording rather than its outcome — `soul_write`
   * and `file_create` are the only Tools L3 runs for real, so this is the only Expectation that can
   * tell a rejection that names what would have resolved apart from one that only says no.
   */
  | { readonly kind: "tool_denial_contains"; readonly name: string; readonly text: string };

/** Expectations that read persisted state, which only the L3 tier can observe. */
const PERSISTED_KINDS: ReadonlySet<string> = new Set([
  "run_status",
  "state_status",
  "state_output_equals",
  "native_admission_equals",
  "mcp_provider_call_count",
  "turn_status",
  "run_event_emitted",
  "run_event_text_omits",
  "persisted_message_metadata_equals",
  "tool_result_field_equals",
  "tool_result_reason_contains",
  "soul_committed",
  "soul_published",
  "soul_not_published",
  "generated_file_readable_by",
  "generated_file_not_readable_by",
  "generated_file_draft_created",
  "doctor_repaired",
  "doctor_escalated",
  "tool_denial_contains",
]);

export function isPersisted(expectation: Expectation): boolean {
  return PERSISTED_KINDS.has(expectation.kind);
}

/**
 * Expectations that read how the model grouped its Tool calls, which only the L2 tier observes.
 *
 * L2 wraps the Model Port itself, so it sees each response whole and can count the calls in it.
 * L3 drives the product's Chat executor, which reports the calls a Turn dispatched but not which
 * response asked for them — so a batching Expectation there would read nothing and pass by
 * vacuity, which is the failure mode this framework exists to prevent.
 */
export function isBatching(expectation: Expectation): boolean {
  return expectation.kind === "tool_calls_batched";
}

/** A faked Tool dispatch, matched to a call by Tool name and consumed in order. */
export interface ScriptedToolResult {
  readonly name: string;
  /** When present, this result only answers a call with these exact arguments. */
  readonly when?: unknown;
  readonly output?: unknown;
  /** Present to script an authorization denial rather than a Tool execution failure. */
  readonly denied?: string;
  /** First dispatch parks for approval; the resumed dispatch returns `output`. */
  readonly approvalId?: string;
  /** Present to script a Tool that fails, so refusal and recovery behaviour can be measured. */
  readonly error?: string;
  /** Present when the Tool already registered the durable provider retry timer for this call. */
  readonly retryWaitId?: string;
  /**
   * Present to script a Tool that rejects the call's arguments. Distinct from `error`: only this
   * outcome reaches the loop's repair path, so it is the only way a Case can measure what the
   * model is asked to correct — and what the loop stops asking it to correct.
   */
  readonly invalidArguments?: string;
}

export type ScriptedModelOutput =
  | Exclude<ModelOutput, { readonly kind: "tool_calls" }>
  | (Extract<ModelOutput, { readonly kind: "tool_calls" }> & {
      /** Text streamed before the Tool calls, matching providers that narrate their next action. */
      readonly text?: string;
    });

/**
 * One Turn of a multi-Turn journey, in the same vocabulary a single-Turn Case already uses.
 *
 * Reusing `input`, `script` and `toolResults` rather than inventing journey-specific names keeps
 * the Case format one format: a journey Turn is a Case's Turn, not a new kind of thing.
 */
export interface JourneyTurn {
  readonly input: readonly ModelMessage[];
  readonly toolResults?: readonly ScriptedToolResult[];
  readonly script?: readonly ScriptedModelOutput[];
}

export type RoutineProviderStep =
  | {
      readonly kind: "success";
      readonly output: unknown;
      /** Adds deterministic payload bulk without committing a 128 KiB Corpus literal. */
      readonly paddingBytes?: number;
    }
  | {
      readonly kind: "retry";
      readonly retryAfterMs: number;
      readonly code?: string;
    };

/**
 * One deterministic Routine Tool State driven through the production executor and Broker.
 *
 * Deliberately limited to one Tool State plus ordinary successor States. This fixture exercises
 * durable approval, provider retry, confirmed-effect replay, and persisted output mapping rather
 * than becoming a second workflow language.
 */
export interface L3RoutineFixture {
  readonly definition: routine.RoutineDefinition;
  readonly toolContract: ToolContractDefinition;
  readonly guardrail?: GuardrailDefinition;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly providerSteps: readonly RoutineProviderStep[];
  readonly approval?: "approved";
  readonly crashAfter?: "effect_confirmed" | "state_succeeded";
}

/** Offline account state; authority decisions still belong to the production MCP host. */
export interface L3McpFixture {
  readonly visibility: "private" | "shared";
  readonly accounts: readonly {
    readonly id: string;
    readonly scope: "personal" | "shared";
    readonly status: "active" | "action_required" | "revoked";
    readonly isDefault?: boolean;
    readonly expiresAt?: string;
  }[];
  readonly selection?: {
    readonly accountId: string;
    readonly sharedConsent: boolean;
  };
  readonly sharedGrants?: readonly string[];
  readonly revokeGrantBeforeApproval?: string;
}

export interface L3NativeRoutineFixture {
  readonly destination: string;
  readonly accountId: string;
  readonly fault?: "lease_lost" | "route_changed" | "account_revoked";
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
   * The File's content, encoded as text or placed inside a declared PDF/Office fixture.
   *
   * Only needed when the Case turns on what is *inside* the File — a red-team payload hidden in an
   * attachment, say. Without it the bytes are a deterministic stand-in, which is enough for a Case
   * that only asserts a File reached the prompt, and cheaper to review.
   */
  readonly content?: string;
  /** L3 attachment only: real OOXML text or a bounded, reproducible defective document. */
  readonly docx?: DocxFixture;
  readonly xlsx?: { readonly precedingRows: number };
  readonly pptx?: { readonly speakerNotes: true };
  readonly pdf?: {
    readonly variant: PdfFixtureVariant;
    /** A readable scan is replaced only after the real file_read Tool authorizes attachment. */
    readonly replaceAfterRead?: "malformed" | "encrypted";
  };
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
 * `content` declared under `mediaType: "application/pdf"` gets a real PDF; a `docx` fixture puts
 * it after the configured paragraph prefix inside OOXML. XLSX places it after the requested rows;
 * PPTX places it only in speaker notes. Binary fixtures are never UTF-8 stand-ins.
 */
export function synthesizeAttachment(file: CaseAttachment): CaseAttachment & { data: Uint8Array } {
  if (file.pdf !== undefined) {
    return { ...file, data: externalPdf(file.pdf.variant, file.content ?? "") };
  }
  if (file.xlsx !== undefined && file.content !== undefined) {
    return { ...file, data: externalXlsx(file.content, file.xlsx.precedingRows) };
  }
  if (file.pptx !== undefined && file.content !== undefined) {
    return { ...file, data: externalPptx(file.content) };
  }
  if (file.docx !== undefined && "variant" in file.docx) {
    return { ...file, data: synthesizeDocxRefusalFixture(file.docx.variant) };
  }
  if (file.docx !== undefined && file.content !== undefined) {
    return {
      ...file,
      data: synthesizeDocxFixture(file.content, file.docx.precedingParagraphs),
    };
  }
  if (file.content !== undefined && file.mediaType === "application/pdf") {
    return { ...file, data: synthesizePdf(file.content) };
  }
  const bytes = file.content ?? `eval-bytes:${file.fileId}`;
  return { ...file, data: new TextEncoder().encode(bytes) };
}

export interface EvalCase {
  readonly id: string;
  /** Offline safety composition only; never supplies runtime identity or hosted trust. */
  readonly safetyHostingAuthority?: "independent" | "tulipfarm";
  /**
   * `l2` drives the Agent loop directly; `l3` drives the product's own Chat executor against a real
   * database. Nearly all the signal is at L2, and L3 is deliberately small — it exists to prove the
   * Run lifecycle around the loop, which L2 stubs and therefore cannot notice breaking.
   */
  readonly tier: "l2" | "l3";
  readonly agent: string;
  /** L3-only deterministic Routine Tool-State execution; bypasses the model and Chat Turn path. */
  readonly routine?: L3RoutineFixture;
  readonly mcp?: L3McpFixture;
  readonly nativeRoutine?: L3NativeRoutineFixture;
  readonly integrationReply?: IngressReplyResult;
  /**
   * What feeds the real Context assembler, beyond what the Eval Soul already supplies.
   *
   * Every field a Case could once set is retired — the assembler takes only the Agent's own
   * personality, and that is the Soul's to write — so this is now omitted in practice. It is kept
   * so `loadCorpus` can still name a retired field rather than ignore it in silence.
   */
  readonly context?: AssembleContext;
  readonly input: readonly ModelMessage[];
  /** A deterministic Soul Doctor sweep, run over the Soul the L3 Turn left behind. */
  readonly doctor?: {
    readonly repair?: {
      /** Slug the scripted repair answers for; a finding about any other artifact is escalated. */
      readonly slug: string;
      readonly content: string;
      readonly summary: string;
    };
  };
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
  /** L2 infrastructure ownership fixture; the real Tool gate decides explicit Soul pushes. */
  readonly hostingAuthority?: "independent" | "tulipfarm";
  readonly toolResults?: readonly ScriptedToolResult[];
  /**
   * Model outputs replayed in order by the scripted binding.
   *
   * Ignored entirely by a real-model binding. It exists so the whole Corpus stays runnable for
   * free and deterministically in ordinary CI, which is what lets a contributor without
   * credentials develop the framework.
   */
  readonly script?: readonly ScriptedModelOutput[];
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
   * the one knob it takes to reach it. `"context"` fails Context resolution; `"model"` fails the
   * Model Port before output; `"model_after_checkpoint"` resumes one approval checkpoint and then
   * fails the Model Port; `"model_output_limit"` passes a scripted text response through the
   * shared production completion guard with the SDK's `length` finish reason.
   */
  readonly fault?: "context" | "model" | "model_after_checkpoint" | "model_output_limit";
  /**
   * L2 only. Crashes the checkpoint write immediately after the first Tool result in a
   * model-produced batch, then retries the same loop input against the saved checkpoint.
   */
  readonly checkpointCrash?: "after_first_tool_result";
  /** L2 only. Forces the production loop's Context compaction seam at this token budget. */
  readonly contextTokenBudget?: number;
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

import type { IngressReplyResult } from "@tulipfarm/turn-executor";
