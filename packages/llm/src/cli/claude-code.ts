import { join } from "node:path";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import {
  createSdkMcpServer,
  query,
  type SDKMessage,
  type SDKUserMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { fromJSONSchema, type ZodObject } from "zod";
import { LlmProviderError } from "../provider-error";
import { CliLanguageModel, type CliTurnEvent } from "./base";
import { createCliJail, jailedEnv } from "./jail";
import { firstJsonObject, jsonModeInstruction } from "./structured";
import { functionTools, type RenderedImage, renderTranscript } from "./transcript";

/** Claude Code declares tools only to capture `tool_use`; Tool Broker dispatches them. */

/** Only OAuth token reaches the child; ambient Anthropic env can reroute or rebill traffic. */
const CLAUDE_ENV_PASSTHROUGH = [] as const;

const MCP_SERVER_NAME = "tulipfarm";

/** Strips Claude Code MCP prefixes so AgentLoop sees bare Tool names. */
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export function stripMcpPrefix(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

function userMessage(text: string, images: readonly RenderedImage[]): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text },
        ...images.map((image) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: image.mimeType, data: image.dataBase64 },
        })),
      ],
    },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

async function* singleTurnPrompt(
  text: string,
  images: readonly RenderedImage[]
): AsyncGenerator<SDKUserMessage> {
  yield userMessage(text, images);
}

function deltaText(message: SDKMessage): string | undefined {
  if (message.type !== "stream_event") return undefined;
  const event = message.event as { type?: string; delta?: { type?: string; text?: string } };
  if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
    return typeof event.delta.text === "string" ? event.delta.text : undefined;
  }
  return undefined;
}

/** Observed result strings classify credential failures because Claude Code returns no status code. */
const AUTH_FAILURE_PATTERNS = [
  /not a valid api key/i,
  /invalid api key/i,
  /invalid x-api-key/i,
  /oauth/i,
  /unauthorized/i,
  /authentication/i,
  /authentication_error/i,
  /\b401\b/,
  /\b403\b/,
  /please run \/login/i,
  /run `claude setup-token`/i,
] as const;

const BILLING_FAILURE_PATTERNS = [
  /credit balance/i,
  /hit your (?:usage )?limit/i,
  /usage limit/i,
  /subscription.*(?:expired|exhausted|limit)/i,
] as const;

export function isAuthFailure(text: string): boolean {
  return AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

export function isBillingFailure(text: string): boolean {
  return BILLING_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

/** Remediation the operator can act on, surfaced alongside the classified failure. */
const REAUTH_HINT =
  "Claude Code credential rejected — run `claude setup-token` and paste the new token in Settings.";

/** Tool handlers must never run; Tool Broker dispatches captured calls. */
function declareTools(tools: LanguageModelV4CallOptions["tools"]) {
  return functionTools(tools).map((definition) => {
    const schema = fromJSONSchema(
      definition.inputSchema as Parameters<typeof fromJSONSchema>[0]
    ) as ZodObject;
    return tool(definition.name, definition.description ?? "", schema.shape, async () => {
      throw new Error(
        "tulipfarm: CLI provider tool executed unexpectedly — tool calls must be captured, not run, here"
      );
    });
  });
}

export class ClaudeCodeModel extends CliLanguageModel {
  readonly provider = "claude-code";

  constructor(
    modelId: string,
    private readonly oauthToken: string | undefined,
    timeoutMs?: number
  ) {
    super(modelId, timeoutMs);
  }

  protected async *runTurn(
    options: LanguageModelV4CallOptions,
    signal: AbortSignal
  ): AsyncGenerator<CliTurnEvent> {
    const jail = createCliJail("tf-claude-");
    try {
      const { systemText, transcriptText, images } = renderTranscript(options.prompt);
      const responseFormat = options.responseFormat;
      const jsonMode = responseFormat?.type === "json";
      const systemPrompt = jsonMode
        ? systemText + jsonModeInstruction(responseFormat.schema, responseFormat.name)
        : systemText;

      const declared = declareTools(options.tools);
      const server = createSdkMcpServer({
        name: MCP_SERVER_NAME,
        version: "1",
        tools: declared,
        alwaysLoad: true,
      });
      const allowedTools = declared.map((definition) => `${MCP_TOOL_PREFIX}${definition.name}`);

      const controller = new AbortController();
      signal.addEventListener("abort", () => controller.abort(), { once: true });

      const env = jailedEnv(process.env, jail.home, CLAUDE_ENV_PASSTHROUGH, {
        CLAUDE_CONFIG_DIR: join(jail.home, ".claude"),
        ...(this.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: this.oauthToken } : {}),
      });

      const sdkQuery = query({
        prompt: singleTurnPrompt(transcriptText || "(no prior conversation)", images),
        options: {
          abortController: controller,
          cwd: jail.home,
          env,
          tools: [],
          skills: [],
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: { [MCP_SERVER_NAME]: server },
          // Only `allowedTools` permits tool names; handlers still must not execute.
          allowedTools,
          persistSession: false,
          includePartialMessages: true,
          systemPrompt: systemPrompt || undefined,
          model: this.modelId,
        },
      });

      /** Deduplicate cumulative assistant usage by message id before summing. */
      const usageById = new Map<string, { input: number; output: number }>();
      /** The `result` message's own totals, which supersede the per-message snapshots. */
      let settled:
        | {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          }
        | undefined;
      let resolvedModel: string | undefined;
      let buffered = "";
      let sawToolCall = false;

      for await (const message of sdkQuery) {
        if (signal.aborted) break;

        const delta = deltaText(message);
        if (delta !== undefined) {
          if (jsonMode) buffered += delta;
          else yield { type: "text-delta", delta };
          continue;
        }

        if (message.type === "assistant") {
          const usage = message.message.usage as
            | {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              }
            | undefined;
          if (usage) {
            const id = message.message.id ?? "unknown";
            const seen = {
              input:
                (usage.input_tokens ?? 0) +
                (usage.cache_read_input_tokens ?? 0) +
                (usage.cache_creation_input_tokens ?? 0),
              output: usage.output_tokens ?? 0,
            };
            const known = usageById.get(id);
            usageById.set(
              id,
              known
                ? {
                    input: Math.max(known.input, seen.input),
                    output: Math.max(known.output, seen.output),
                  }
                : seen
            );
          }
          const content = message.message.content as Array<{
            type: string;
            id?: string;
            name?: string;
            input?: unknown;
          }>;
          for (const block of content) {
            if (block.type === "tool_use" && block.id && block.name) {
              sawToolCall = true;
              yield {
                type: "tool-call",
                toolCallId: block.id,
                toolName: stripMcpPrefix(block.name),
                input: block.input,
              };
            }
          }
          if (sawToolCall) {
            await sdkQuery.interrupt().catch(() => undefined);
            controller.abort();
            break;
          }
          continue;
        }

        if (message.type === "result") {
          const result = message as unknown as {
            subtype?: string;
            result?: string;
            is_error?: boolean;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            modelUsage?: Record<string, unknown>;
          };
          // A rejected credential still reports `subtype: "success"` — only `is_error` and the
          // `result` text distinguish it from a real completion, so both must be checked.
          if (result.subtype !== "success" || result.is_error) {
            const text = result.result ?? result.subtype ?? "Claude Code turn failed";
            if (isBillingFailure(text)) {
              throw new LlmProviderError("model_billing_inactive", new Error(text));
            }
            if (isAuthFailure(text)) {
              // `LlmProviderError` keeps only its reason participant-visible; the cause is
              // operator-only, and `AgentLoop`'s `deepestErrorMessage` surfaces it in the log —
              // so it carries both the remediation and the provider's own wording.
              throw new LlmProviderError(
                "model_authentication_failed",
                new Error(`${REAUTH_HINT} (provider said: ${text})`)
              );
            }
            throw new Error(text);
          }
          // The turn's own totals. An `assistant` message carries the usage snapshot taken before
          // the model wrote anything — Anthropic reports `output_tokens: 1` there — so summing
          // those alone reported roughly one output token for every completed turn.
          if (result.usage) settled = result.usage;
          // Keyed by the model the vendor resolved the alias to. Only trusted when there is
          // exactly one: several means the turn was not one model, and naming a single version
          // then would assert something the run does not support.
          const ran = Object.keys(result.modelUsage ?? {});
          if (ran.length === 1 && ran[0]) resolvedModel = ran[0];
        }
      }

      if (jsonMode && buffered) {
        yield { type: "text-delta", delta: firstJsonObject(buffered) ?? buffered };
      }

      if (resolvedModel !== undefined) yield { type: "model-version", modelId: resolvedModel };

      // A tool call interrupts the turn before any `result` arrives, so the per-message snapshots
      // remain the only account of what that partial turn consumed.
      if (settled) {
        const cacheRead = settled.cache_read_input_tokens ?? 0;
        yield {
          type: "usage",
          inputTokens:
            (settled.input_tokens ?? 0) + cacheRead + (settled.cache_creation_input_tokens ?? 0),
          outputTokens: settled.output_tokens ?? 0,
          ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
        };
        return;
      }

      let inputTokens = 0;
      let outputTokens = 0;
      for (const seen of usageById.values()) {
        inputTokens += seen.input;
        outputTokens += seen.output;
      }
      yield { type: "usage", inputTokens, outputTokens };
    } finally {
      jail.cleanup();
    }
  }
}
