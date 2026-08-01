import { canonicalHash, type GuardrailsConfig, validateGuardrailsConfig } from "@tulipfarm/schema";
import { DEFAULT_GUARDRAILS } from "./default-policy";
import { makeContentFilterGuard } from "./guards/content-filter";
import { makePromptInjectionGuard } from "./guards/prompt-injection";
import { makeToolBlocklistGuard, type ToolCallInput } from "./guards/tool-blocklist";
import type { Guard, GuardContext, StageResult } from "./pipeline";
import { runStage } from "./pipeline";

type ServiceLogger = { warn: (obj: unknown, msg?: string) => void };

const NOOP_LOGGER: ServiceLogger = { warn() {} };

/**
 * Owns the three guard stages and runs them. {@link init} validates the
 * configured policy and rebuilds the guard arrays into locals before swapping
 * them in, so a bad reload can never corrupt running state (mirrors
 * `LlmService.init`). An invalid or absent config falls back to
 * {@link DEFAULT_GUARDRAILS} — fail-safe to the default policy, never unguarded,
 * never crashing the turn.
 */
export class GuardrailsService {
  private log: ServiceLogger = NOOP_LOGGER;
  private input: Guard<string>[] = [];
  private toolCall: Guard<ToolCallInput>[] = [];
  private output: Guard<string>[] = [];
  private configValue: GuardrailsConfig = DEFAULT_GUARDRAILS;
  private revisionValue = canonicalHash(DEFAULT_GUARDRAILS);

  get revision(): string {
    return this.revisionValue;
  }

  /**
   * The policy these guards were built from — the same object {@link revision} hashes.
   *
   * Exposed because the Worker enforces this policy on turns it executes and cannot read the Soul
   * itself. Shipping the config rather than a compiled pipeline keeps one authority: whoever
   * receives it rebuilds the identical guards through {@link init} and can prove it by comparing
   * revisions.
   */
  get config(): GuardrailsConfig {
    return this.configValue;
  }

  init(raw: Record<string, unknown> | null, log: ServiceLogger): void {
    this.log = log;

    let cfg: GuardrailsConfig;
    if (raw == null) {
      cfg = DEFAULT_GUARDRAILS;
    } else {
      try {
        cfg = validateGuardrailsConfig(raw);
      } catch (err) {
        log.warn({ err }, "guardrails config invalid — using default policy");
        cfg = DEFAULT_GUARDRAILS;
      }
    }

    const input = (cfg.input ?? []).map((c) => makePromptInjectionGuard(c));
    const toolCall = (cfg["tool-call"] ?? []).map((c) => makeToolBlocklistGuard(c));
    const output = (cfg.output ?? []).map((c) => makeContentFilterGuard(c));

    this.input = input;
    this.toolCall = toolCall;
    this.output = output;
    this.configValue = cfg;
    this.revisionValue = canonicalHash(cfg);
  }

  runInput(text: string, ctx: GuardContext): Promise<StageResult<string>> {
    return runStage(this.input, text, ctx, this.log);
  }

  runToolCall(input: ToolCallInput, ctx: GuardContext): Promise<StageResult<ToolCallInput>> {
    return runStage(this.toolCall, input, ctx, this.log);
  }

  runOutput(text: string, ctx: GuardContext): Promise<StageResult<string>> {
    return runStage(this.output, text, ctx, this.log);
  }
}
