import {
  type GuardContext,
  GuardrailsService,
  type ToolDispatchPort,
  type ToolDispatchRequest,
  type ToolDispatchResult,
} from "@tulipfarm/agent-runtime";
import type { RunEventGuardrailStage } from "@tulipfarm/schema";
import type { TurnEventWriter } from "./run-events";

/**
 * Guardrail enforcement for a Worker-executed turn (GR-V1-001/002/003; plan §2).
 *
 * The three stages used to run inside the API's chat turn, which meant a Slack or Telegram message
 * reached the model through a path nothing guarded. Enforcement belongs wherever the turn actually
 * executes, so it lives here: one policy, applied identically on every channel.
 *
 * The policy itself is not read here. It arrives with the Context, already validated, and is
 * rebuilt into the same guards the API compiled — then checked, by comparing revisions, against the
 * digest recorded as `context.assembled` evidence. A turn whose enforcement does not match its own
 * evidence is refused rather than run, because the alternative is a record that lies about what
 * guarded it.
 */

/** What a refused turn says when the guard named no message of its own. */
const DEFAULT_BLOCK_MESSAGE = "I can't help with that request.";

/** A guard's verdict, as the caller needs to act on it. */
export type GuardedText =
  | { readonly blocked: false; readonly text: string }
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

/**
 * The three stages, bound to one turn.
 *
 * Built before the Context is resolved — the Tool dispatch port has to be wrapped before the loop
 * exists — and configured once the Context says which policy to enforce. Until then every stage
 * refuses: an unconfigured guard means the turn resolved no policy, and running Tools under no
 * policy is precisely what this class exists to prevent.
 */
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

  /** The user's request, before any of it reaches the model. */
  async input(text: string, events: TurnEventWriter): Promise<GuardedText> {
    const { service, ctx } = this.require();
    const result = await service.runInput(text, ctx);
    if (!result.blocked) return { blocked: false, text: result.value };
    await this.record(events, "input", result.guard, result.reason, "input");
    return { blocked: true, message: result.message ?? DEFAULT_BLOCK_MESSAGE };
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
   * Wraps the Tool dispatch port so no call reaches the broker unguarded.
   *
   * A blocked call comes back as a denial the model reads and may recover from, which is what
   * makes this stage different from the other two: refusing one Tool is not refusing the turn.
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
            // The model is told a Tool was refused; a participant watching the stream is not shown
            // a block, because the turn is still going to answer them.
            false
          );
          return {
            status: "denied",
            callId: request.callId,
            reason: `${result.guard}: ${result.reason}`,
          };
        }
        // A transform rewrites the arguments, so the broker executes what the guard allowed rather
        // than what the model asked for.
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

  /**
   * Records a block twice, deliberately.
   *
   * `guardrail.decision` is operator evidence naming the guard; `guardrail.blocked` is what a
   * participant is shown, and carries the reason without the guard's identity, so a refusal never
   * teaches a reader which pattern to write around next time.
   */
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
