import {
  type GuardContext,
  GuardrailsService,
  isBlocked,
  REFUSED_TOOL_RESULT_NOTICE,
  type ToolDispatchPort,
  type ToolDispatchRequest,
  type ToolDispatchResult,
  type ToolResultDistillerPort,
  toolResultText,
} from "@tulipfarm/agent-runtime";
import {
  contentFiles,
  contentText,
  type MessageContent,
  type RunEventGuardrailStage,
} from "@tulipfarm/schema";
import type { TurnEventWriter } from "./run-events";

/** Enforces the Context's guardrail policy and refuses digest mismatches before execution. */

/**
 * A URL rewritten so the screener can read it as the prose a model would read.
 *
 * Phrase matching normalises whitespace, but a URL cannot contain any — an injected instruction
 * arrives as `/Ignore-all-previous-instructions`, which no phrase matches yet a model parses
 * exactly as written. Percent-encoding hides it a second way. Decoding and turning separators
 * back into spaces screens the sentence the reader actually sees. Used only to build the text
 * handed to the guard; the citation itself is never rewritten.
 */
function urlScreeningText(url: string): string {
  let readable = url;
  try {
    readable = decodeURIComponent(url);
  } catch {
    // Malformed escapes: screen the raw form rather than skipping the value entirely.
  }
  return readable.replace(/[^\p{L}\p{N}]+/gu, " ");
}

/** What a refused turn says when the guard named no message of its own. */
const DEFAULT_BLOCK_MESSAGE = "I can't help with that request.";

/** A guard's verdict, as the caller needs to act on it. */
export type GuardedText =
  | { readonly blocked: false; readonly text: string }
  | { readonly blocked: true; readonly message: string };

export type GuardedContent =
  | { readonly blocked: false; readonly content: MessageContent }
  | { readonly blocked: true; readonly message: string };

export class GuardrailDigestMismatchError extends Error {
  readonly name = "GuardrailDigestMismatchError";

  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super(
      `guardrail policy hashes to "${actual}" but the Context recorded "${expected}" — ` +
        "refusing to execute a turn whose evidence names a policy it is not enforcing"
    );
  }
}

export interface TurnGuardrailPolicy {
  /** The validated guardrails config the Context's `guardrailDigest` names. */
  readonly policy: Record<string, unknown>;
  readonly digest: string;
  readonly context: GuardContext;
  /** Tool tier by Tool name, so the blocklist can refuse a whole category. */
  readonly toolTiers: ReadonlyMap<string, string>;
}

type GuardLogger = { warn: (obj: unknown, msg?: string) => void };

/** Built before Context; unconfigured stages refuse so Tools never run without policy. */
export class TurnGuardrails {
  private service: GuardrailsService | undefined;
  private settings: TurnGuardrailPolicy | undefined;

  constructor(private readonly log: GuardLogger) {}

  configure(settings: TurnGuardrailPolicy): void {
    const service = new GuardrailsService();
    service.init(settings.policy, this.log);
    if (service.revision !== settings.digest) {
      throw new GuardrailDigestMismatchError(settings.digest, service.revision);
    }
    this.service = service;
    this.settings = settings;
  }

  /**
   * The user's request, before any of it reaches the model.
   *
   * The guards read text, so the screenable text is derived here rather than at the call site:
   * this is the one place that has to learn when a new part starts carrying words, instead of
   * every caller silently screening less than it thinks it does.
   *
   * @param attachmentText What the Files this Turn attached actually say, already extracted by the
   * side that owns them. An uploaded document is the widest indirect-injection channel there is,
   * because its instructions arrive looking like data; screening it here is what stops a PDF being
   * a way around the screening a plain message gets.
   */
  async input(
    content: MessageContent,
    events: TurnEventWriter,
    attachmentText: readonly string[]
  ): Promise<GuardedContent> {
    const { service, ctx } = this.require();
    const text = contentText(content);
    const result = await service.runInput(text, ctx);
    if (result.blocked) {
      await this.record(events, "input", result.guard, result.reason, "input");
      return { blocked: true, message: result.message ?? DEFAULT_BLOCK_MESSAGE };
    }

    const names = contentFiles(content)
      .map((part) => part.name)
      .join("\n");
    if (names.length > 0) {
      // A filename is attacker-chosen text that reaches the model verbatim, so it is screened
      // like any other input. Screened separately and for blocking only: a redaction cannot be
      // applied to a name without changing which File the part refers to, and an attachment
      // named to carry an instruction is not a message worth partially admitting.
      const named = await service.runInput(names, ctx);
      if (named.blocked) {
        await this.record(events, "input", named.guard, named.reason, "input");
        return { blocked: true, message: named.message ?? DEFAULT_BLOCK_MESSAGE };
      }
    }

    for (const extracted of attachmentText) {
      if (extracted.length === 0) continue;
      // Blocking only, for the same reason as a filename: a redaction cannot be applied to a
      // File's bytes, and the model is sent the bytes. Admitting the File with its text "cleaned"
      // would tell the operator the words were removed while the model still read them.
      const attached = await service.runInput(extracted, ctx);
      if (attached.blocked) {
        await this.record(events, "input", attached.guard, attached.reason, "input");
        return { blocked: true, message: attached.message ?? DEFAULT_BLOCK_MESSAGE };
      }
    }

    if (result.value === text) return { blocked: false, content };
    // A guard rewrote the text — redaction. The rewrite covers the message's text as a whole, so
    // it is carried as one part; keeping the original text parts would re-admit what was removed.
    return {
      blocked: false,
      content: [{ type: "text", text: result.value }, ...contentFiles(content)],
    };
  }

  /** The answer, before it is persisted as a Message any channel will read. */
  async output(text: string, events: TurnEventWriter): Promise<GuardedText> {
    const { service, ctx } = this.require();
    const result = await service.runOutput(text, ctx);
    if (!result.blocked) return { blocked: false, text: result.value };
    await this.record(events, "output", result.guard, result.reason, "output");
    return { blocked: true, message: result.message ?? DEFAULT_BLOCK_MESSAGE };
  }

  /**
   * Blocks Tool calls as model-visible denials, not whole-turn refusals.
   *
   * The result is screened as well as the call. A refused result keeps its `succeeded` status and
   * loses only its content: the Tool ran, and on a mutating call something happened out in the
   * world, so reporting it as denied would tell the model an effect it caused never landed.
   */
  guard(tools: ToolDispatchPort, events: TurnEventWriter): ToolDispatchPort {
    return {
      dispatch: async (request: ToolDispatchRequest): Promise<ToolDispatchResult> => {
        const { service, ctx, toolTiers } = this.require();
        const result = await service.runToolCall(
          {
            toolName: request.name,
            tier: toolTiers.get(request.name) ?? "",
            args: request.arguments,
          },
          ctx
        );
        if (result.blocked) {
          await this.record(
            events,
            "tool_call",
            result.guard,
            result.reason,
            `tool:${request.callId}`,
            // Model sees the denial; participant does not see a block for a continuing turn.
            false
          );
          return {
            status: "denied",
            callId: request.callId,
            reason: `${result.guard}: ${result.reason}`,
          };
        }
        // Execute the guard-approved arguments, not the model's original arguments.
        const dispatched = await tools.dispatch({ ...request, arguments: result.value.args });
        return this.screenResult(request, dispatched, events);
      },
    };
  }

  /**
   * The `tool-result` stage again, over the summariser's own words.
   *
   * The raw result was screened before the summariser read it, but the summariser is a cheaper
   * model reading bytes a destination controls, and what it writes is new text that lands in the
   * transcript. Screening only its input would trust it to have not been steered by that input.
   *
   * A blocked summary is dropped rather than withheld: the raw result it was shrinking already
   * passed the same screen, so returning nothing leaves the Turn with that, which is what a Turn
   * without a summariser would have had.
   */
  guardDistiller(
    distiller: ToolResultDistillerPort,
    events: TurnEventWriter
  ): ToolResultDistillerPort {
    return {
      distill: async (request, signal) => {
        const distilled = await distiller.distill(request, signal);
        if (distilled === undefined || isBlocked(distilled)) return distilled;

        const text = toolResultText([
          distilled.summary,
          ...distilled.citations.flatMap((citation) =>
            citation.url === undefined
              ? [citation.quote]
              : [citation.quote, urlScreeningText(citation.url)]
          ),
        ]);
        if (text.trim() === "") return distilled;

        const { service, ctx } = this.require();
        const screened = await service.runToolResult({ toolName: request.toolName, text }, ctx);
        if (!screened.blocked) return distilled;

        await this.record(
          events,
          "tool_result",
          screened.guard,
          screened.reason,
          `distilled:${request.toolName}`,
          false
        );
        // Not `undefined`: that means "no summary available" and leaves the caller holding the
        // raw result, which is the content this guard just refused.
        return { blocked: true };
      },
    };
  }

  /**
   * The `tool-result` stage: what a Tool brought back, before the model reads it.
   *
   * A failed call is screened as well as a succeeded one. Its `reason` is not always this
   * deployment's own words — a Tool that talks to a destination can quote what the destination
   * said, so that string is reachable by whoever controls the destination.
   *
   * A blocked result never becomes `denied`. The Tool already ran; on a mutating call an effect
   * has landed. Reporting it as denied would tell the model an effect it caused never happened,
   * so only what came back is withheld.
   */
  private async screenResult(
    request: ToolDispatchRequest,
    dispatched: ToolDispatchResult,
    events: TurnEventWriter
  ): Promise<ToolDispatchResult> {
    if (dispatched.status !== "succeeded" && dispatched.status !== "failed") return dispatched;
    const text =
      dispatched.status === "succeeded" ? toolResultText(dispatched.output) : dispatched.reason;
    if (text.trim() === "") return dispatched;

    const { service, ctx } = this.require();
    const screened = await service.runToolResult({ toolName: request.name, text }, ctx);
    if (!screened.blocked) return dispatched;

    await this.record(
      events,
      "tool_result",
      screened.guard,
      screened.reason,
      `tool_result:${request.callId}`,
      false
    );

    return dispatched.status === "succeeded"
      ? {
          ...dispatched,
          output: {
            withheld: true,
            tool: request.name,
            reason: screened.reason,
            detail: screened.message ?? REFUSED_TOOL_RESULT_NOTICE,
          },
        }
      : { ...dispatched, reason: REFUSED_TOOL_RESULT_NOTICE };
  }

  private require(): {
    service: GuardrailsService;
    ctx: GuardContext;
    toolTiers: ReadonlyMap<string, string>;
  } {
    if (this.service === undefined || this.settings === undefined) {
      throw new Error("guardrails were used before the turn's policy was configured");
    }
    return {
      service: this.service,
      ctx: this.settings.context,
      toolTiers: this.settings.toolTiers,
    };
  }

  /** Records operator evidence separately from participant-visible refusal text. */
  private async record(
    events: TurnEventWriter,
    stage: RunEventGuardrailStage,
    guard: string,
    reason: string,
    key: string,
    participantVisible = true
  ): Promise<void> {
    await events.emit(
      "guardrail.decision",
      { stage, guard, decision: "block", reason },
      `guard:${key}`
    );
    if (participantVisible) {
      await events.emit("guardrail.blocked", { stage, reason }, `blocked:${key}`);
    }
  }
}
