import { canonicalHash, type GuardrailsConfig, validateGuardrailsConfig } from "@tulipfarm/schema";
import { DEFAULT_GUARDRAILS } from "./default-policy";
import { makeContentFilterGuard } from "./guards/content-filter";
import { makePromptInjectionGuard } from "./guards/prompt-injection";
import { makeToolBlocklistGuard, type ToolCallInput } from "./guards/tool-blocklist";
import { makeUntrustedContentGuard, type ToolResultInput } from "./guards/untrusted-content";
import type { Guard, GuardContext, StageResult } from "./pipeline";
import { runStage } from "./pipeline";

type ServiceLogger = { warn: (obj: unknown, msg?: string) => void };

const NOOP_LOGGER: ServiceLogger = { warn() {} };

export interface ResolvedGuardrailsConfig {
  readonly config: GuardrailsConfig;
  readonly source: "custom" | "default";
}

/** Resolves the exact effective policy used by the runtime, including its fail-safe fallback. */
export function resolveGuardrailsConfig(
  raw: Record<string, unknown> | null,
  log: ServiceLogger = NOOP_LOGGER
): ResolvedGuardrailsConfig {
  if (raw == null) return { config: DEFAULT_GUARDRAILS, source: "default" };
  try {
    return { config: validateGuardrailsConfig(raw), source: "custom" };
  } catch (err) {
    log.warn({ err }, "guardrails config invalid — using default policy");
    return { config: DEFAULT_GUARDRAILS, source: "default" };
  }
}

/** Owns the four guard stages; invalid or absent config falls back to defaults. */
export class GuardrailsService {
  private log: ServiceLogger = NOOP_LOGGER;
  private input: Guard<string>[] = [];
  private toolCall: Guard<ToolCallInput>[] = [];
  private toolResult: Guard<ToolResultInput>[] = [];
  private output: Guard<string>[] = [];
  private configValue: GuardrailsConfig = DEFAULT_GUARDRAILS;
  private revisionValue = canonicalHash(DEFAULT_GUARDRAILS);

  get revision(): string {
    return this.revisionValue;
  }

  /** Policy the guards were built from; hashed by `revision` and reusable by Workers. */
  get config(): GuardrailsConfig {
    return this.configValue;
  }

  init(raw: Record<string, unknown> | null, log: ServiceLogger): void {
    this.log = log;
    const { config: cfg } = resolveGuardrailsConfig(raw, log);

    const input = (cfg.input ?? []).map((c) => makePromptInjectionGuard(c));
    const toolCall = (cfg["tool-call"] ?? []).map((c) => makeToolBlocklistGuard(c));
    const toolResult = (cfg["tool-result"] ?? []).map((c) => makeUntrustedContentGuard(c));
    const output = (cfg.output ?? []).map((c) => makeContentFilterGuard(c));

    this.input = input;
    this.toolCall = toolCall;
    this.toolResult = toolResult;
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

  runToolResult(input: ToolResultInput, ctx: GuardContext): Promise<StageResult<ToolResultInput>> {
    return runStage(this.toolResult, input, ctx, this.log);
  }

  runOutput(text: string, ctx: GuardContext): Promise<StageResult<string>> {
    return runStage(this.output, text, ctx, this.log);
  }
}
