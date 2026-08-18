import {
  type GuardContext,
  GuardrailsService,
  type ToolDispatchPort,
  type ToolDispatchRequest,
  type ToolDispatchResult,
} from "@tulipfarm/agent-runtime";
import {
  contentFiles,
  contentText,
  type MessageContent,
  type RunEventGuardrailStage,
} from "@tulipfarm/schema";
import type { TurnEventWriter } from "./run-events";

/** Enforces the Context's guardrail policy and refuses digest mismatches before execution. */

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
   * when a File part starts contributing text of its own, this is the one place that has to learn
   * about it, instead of every caller silently screening less than it thinks it does.
   */
  async input(content: MessageContent, events: TurnEventWriter): Promise<GuardedContent> {
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

  /** Blocks Tool calls as model-visible denials, not whole-turn refusals. */
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
        return tools.dispatch({ ...request, arguments: result.value.args });
      },
    };
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
