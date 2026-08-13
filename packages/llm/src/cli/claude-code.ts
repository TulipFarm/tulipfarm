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

/**
 * `LanguageModelV4` over `@anthropic-ai/claude-agent-sdk` — lets a user with a Claude Pro/Max
 * subscription (no API key) run TulipFarm. See `docs/plans/cli-agent-providers.md` for the full
 * design; the short version: one `query()` call per AgentLoop iteration, tools are declared to
 * the SDK but never executed — the assistant message carrying `tool_use` blocks is captured and
 * the query aborted before the SDK would ever invoke them, so the real dispatch stays on
 * TulipFarm's Tool Broker. `settingSources: []` ignores the host's own `~/.claude` config
 * entirely; the credential and everything else the subprocess can see is scoped by `jail.ts`.
 */

const CLAUDE_ENV_PASSTHROUGH = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

const MCP_SERVER_NAME = "tulipfarm";

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

function isAuthFailure(text: string): boolean {
  return /invalid api key|oauth token|unauthorized|authentication|401/i.test(text);
}

/** Tools are declared to the SDK so it can emit `tool_use` blocks, but never actually executed —
 * every real call is captured off the assistant message and dispatched through the Tool Broker
 * instead. This handler exists only to satisfy the SDK's `tool()` API; reaching it is a bug. */
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
      const allowedTools = declared.map(
        (definition) => `mcp__${MCP_SERVER_NAME}__${definition.name}`
      );

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
          allowedTools,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          persistSession: false,
          includePartialMessages: true,
          systemPrompt: systemPrompt || undefined,
          model: this.modelId,
        },
      });

      let inputTokens = 0;
      let outputTokens = 0;
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
            inputTokens +=
              (usage.input_tokens ?? 0) +
              (usage.cache_read_input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0);
            outputTokens += usage.output_tokens ?? 0;
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
                toolName: block.name,
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
          };
          if (result.subtype !== "success" || result.is_error) {
            const text = result.result ?? result.subtype ?? "CLI provider turn failed";
            if (isAuthFailure(text))
              throw new LlmProviderError("model_authentication_failed", new Error(text));
            throw new Error(text);
          }
        }
      }

      if (jsonMode && buffered) {
        yield { type: "text-delta", delta: firstJsonObject(buffered) ?? buffered };
      }

      yield { type: "usage", inputTokens, outputTokens };
    } finally {
      jail.cleanup();
    }
  }
}
